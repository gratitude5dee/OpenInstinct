import "server-only";

import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { isIP } from "node:net";
import type { AccessScope } from "@/lib/access-scope";
import { ensureScope } from "@/db/services/scope";
import {
  assertLinkCheckoutOwnership,
  deleteLinkWalletConnection,
  invalidateActiveLinkSpendRequests,
  listActiveLinkSpendRequests,
  readLinkSpendRequest,
  readLinkWalletConnection,
  reserveLinkSpendRequest,
  updateLinkSpendRequest,
  writeLinkWalletConnection,
} from "@/db/services/link-wallet";
import {
  withLinkWalletWorkspaceLock,
  type LinkWalletTransaction,
} from "@/db/services/link-wallet-lock";
import { deleteEncryptedSecretNamespace } from "@/db/services/secrets";
import type { linkSpendRequests } from "@/db";
import {
  deleteSecret,
  readSecret,
  writeSecret,
} from "@/lib/manager/server/secret-store";
import {
  assertLinkCliAvailable,
  LinkCliError,
  LinkCliUnavailableError,
  withLinkCliSession,
  type LinkCliSession,
} from "./cli";
import { maskLinkAccountLabel } from "./safe-output";
import {
  linkCardCredentialFileSchema,
  linkCheckoutAssertionSchema,
  linkReportOutcomeSchema,
  linkSpendRequestInputSchema,
  linkSubmissionOutcomeSchema,
  type LinkAddress,
  type LinkCheckoutAssertion,
  type LinkPaymentMethod,
  type LinkProfile,
  type LinkReportOutcomeInput,
  type LinkSpendCredentialLease,
  type LinkSpendNextAction,
  type LinkSpendRequest,
  type LinkSpendRequestInput,
  type LinkSpendRequestStatus,
  type LinkSubmissionGuard,
  type LinkSubmissionOutcome,
  type LinkWalletConnection,
} from "./types";

const PENDING_AUTH_SECRET_ID = "device-authorization";
const APPROVAL_SECRET_PREFIX = "spend:";
const APPROVAL_SECRET_SUFFIX = ":approval";
const APPROVAL_WINDOW_MS = 10 * 60 * 1_000;
const POLL_TIMEOUT_MS = 28_000;
const ACTIVE_STATUSES = new Set<LinkSpendRequestStatus>([
  "creating",
  "created",
  "pending_approval",
  "approved",
  "requires_action",
]);
const TERMINAL_STATUSES = new Set<LinkSpendRequestStatus>([
  "denied",
  "expired",
  "canceled",
  "succeeded",
  "failed",
]);

type LinkSpendRow = typeof linkSpendRequests.$inferSelect;
type JsonObject = Record<string, unknown>;
type ParsedLinkSpendRequestInput = ReturnType<
  typeof linkSpendRequestInputSchema.parse
>;

export class LinkCheckoutBindingError extends Error {
  readonly code = "MERCHANT_BINDING_REQUIRED";

  constructor() {
    super(
      "The current Stripe merchant binding is required before Link approval."
    );
    this.name = "LinkCheckoutBindingError";
  }
}

export async function getLinkWalletConnection(
  scope: AccessScope
): Promise<LinkWalletConnection> {
  try {
    await assertLinkCliAvailable();
  } catch (error) {
    if (error instanceof LinkCliUnavailableError) {
      return {
        reason: "Link Agent Wallet is unavailable on this deployment.",
        state: "unavailable",
      };
    }
    throw error;
  }

  return withLinkWalletWorkspaceLock(scope, async (transaction) => {
    const connection = await readLinkWalletConnection(transaction, scope);
    if (!connection) return { state: "disconnected" };
    if (connection.status === "connected") {
      return {
        accountLabel: maskLinkAccountLabel(connection.accountLabel),
        connectedAt: connection.connectedAt ?? undefined,
        state: "connected",
      };
    }
    if (connection.status === "reauthentication_required") {
      return { state: "reauthentication-required" };
    }
    const pending = await readPendingAuthorization(scope, transaction);
    if (!pending) {
      await markReauthenticationRequired(scope, transaction);
      return { state: "reauthentication-required" };
    }
    return { ...pending, state: "pending" };
  });
}

export async function startLinkAuthorization(
  scope: AccessScope
): Promise<LinkWalletConnection> {
  await ensureScope(scope);
  try {
    await assertLinkCliAvailable();
  } catch (error) {
    if (error instanceof LinkCliUnavailableError)
      return unavailableConnection();
    throw error;
  }

  try {
    return await withLinkWalletWorkspaceLock(scope, async (transaction) => {
      const current = await readLinkWalletConnection(transaction, scope);
      if (current?.status === "connected") {
        return {
          accountLabel: maskLinkAccountLabel(current.accountLabel),
          connectedAt: current.connectedAt ?? undefined,
          state: "connected" as const,
        };
      }
      if (current?.status === "pending") {
        const existing = await readPendingAuthorization(scope, transaction);
        if (existing) return { ...existing, state: "pending" as const };
      }

      await deleteSecret({
        database: transaction,
        id: "auth",
        namespace: "link",
        scope,
      });
      await deleteSecret({
        database: transaction,
        id: PENDING_AUTH_SECRET_ID,
        namespace: "link",
        scope,
      });
      return withLinkCliSession(scope, transaction, async (session) => {
        const result = await session.run(
          ["auth", "login", "--client-name=OpenInstinct"],
          { timeoutMs: 20_000 }
        );
        if (readBoolean(result, "authenticated") === true) {
          return finalizeConnectedWallet(scope, transaction, session);
        }
        const pending = parseLinkDeviceAuthorization(result);
        const now = new Date().toISOString();
        await writeSecret({
          database: transaction,
          id: PENDING_AUTH_SECRET_ID,
          namespace: "link",
          scope,
          value: JSON.stringify(pending),
        });
        await writeLinkWalletConnection(transaction, scope, {
          accountLabel: null,
          connectedAt: null,
          status: "pending",
          updatedAt: now,
        });
        return { ...pending, state: "pending" as const };
      });
    });
  } catch (error) {
    if (isUnavailableError(error)) return unavailableConnection();
    if (isReauthenticationError(error)) {
      await withLinkWalletWorkspaceLock(scope, (transaction) =>
        markReauthenticationRequired(scope, transaction)
      );
      return { state: "reauthentication-required" };
    }
    throw error;
  }
}

export async function pollLinkAuthorization(
  scope: AccessScope
): Promise<LinkWalletConnection> {
  await ensureScope(scope);
  try {
    await assertLinkCliAvailable();
  } catch (error) {
    if (error instanceof LinkCliUnavailableError)
      return unavailableConnection();
    throw error;
  }

  try {
    return await withLinkWalletWorkspaceLock(scope, async (transaction) => {
      const current = await readLinkWalletConnection(transaction, scope);
      if (!current) return { state: "disconnected" };
      if (current.status === "connected") {
        return {
          accountLabel: maskLinkAccountLabel(current.accountLabel),
          connectedAt: current.connectedAt ?? undefined,
          state: "connected",
        };
      }
      if (current.status === "reauthentication_required") {
        return { state: "reauthentication-required" };
      }
      const pending = await readPendingAuthorization(scope, transaction);
      if (!pending) {
        await markReauthenticationRequired(scope, transaction);
        return { state: "reauthentication-required" };
      }

      return withLinkCliSession(scope, transaction, async (session) => {
        let result: unknown;
        try {
          result = await session.run(
            [
              "auth",
              "status",
              "--interval=1",
              "--max-attempts=1",
              "--timeout=3",
            ],
            { timeoutMs: 8_000 }
          );
        } catch (error) {
          if (
            error instanceof LinkCliError &&
            error.code === "POLLING_TIMEOUT"
          ) {
            return { ...pending, state: "pending" as const };
          }
          throw error;
        }
        if (readBoolean(result, "authenticated") !== true) {
          return { ...pending, state: "pending" as const };
        }
        return finalizeConnectedWallet(scope, transaction, session);
      });
    });
  } catch (error) {
    if (isUnavailableError(error)) return unavailableConnection();
    if (isReauthenticationError(error)) {
      await withLinkWalletWorkspaceLock(scope, (transaction) =>
        markReauthenticationRequired(scope, transaction)
      );
      return { state: "reauthentication-required" };
    }
    throw error;
  }
}

export async function disconnectLinkWallet(
  scope: AccessScope
): Promise<LinkWalletConnection> {
  await ensureScope(scope);
  await withLinkWalletWorkspaceLock(scope, async (transaction) => {
    const active = await listActiveLinkSpendRequests(transaction, scope);
    try {
      await withLinkCliSession(scope, transaction, async (session) => {
        for (const request of active) {
          if (!request.remoteSpendRequestId) continue;
          await session
            .run(["spend-request", "cancel", request.remoteSpendRequestId], {
              timeoutMs: 8_000,
            })
            .catch(() => undefined);
        }
        await session
          .run(["auth", "logout"], { timeoutMs: 8_000 })
          .catch(() => undefined);
      });
    } catch {
      // Local revocation remains authoritative even if Link cannot be reached.
    }
    const now = new Date().toISOString();
    await invalidateActiveLinkSpendRequests(transaction, scope, now);
    await deleteEncryptedSecretNamespace(scope, "link", transaction);
    await deleteLinkWalletConnection(transaction, scope);
  });
  return { state: "disconnected" };
}

export async function readLinkProfile(
  scope: AccessScope
): Promise<LinkProfile> {
  await ensureScope(scope);
  try {
    return await withLinkWalletWorkspaceLock(scope, async (transaction) => {
      await requireConnectedWallet(scope, transaction);
      return withLinkCliSession(scope, transaction, async (session) => {
        const user = await session.run(["user-info", "retrieve"]);
        const paymentMethods = await session.run(["payment-methods", "list"]);
        const shippingAddresses = await session.run([
          "shipping-address",
          "list",
        ]);
        return parseLinkProfile(user, paymentMethods, shippingAddresses);
      });
    });
  } catch (error) {
    await persistReauthenticationIfNeeded(scope, error);
    throw safeServiceError(error);
  }
}

export async function createOrReuseLinkSpendRequest(
  scope: AccessScope,
  input: LinkSpendRequestInput
): Promise<LinkSpendRequest> {
  const request = linkSpendRequestInputSchema.parse(input);
  await ensureScope(scope);
  try {
    return await withLinkWalletWorkspaceLock(scope, async (transaction) => {
      await requireConnectedWallet(scope, transaction);
      await assertLinkCheckoutOwnership(transaction, scope, request);

      const now = new Date();
      const handle = randomUUID();
      const requestFingerprint = fingerprintRequest(request);
      const reservation = await reserveLinkSpendRequest(transaction, {
        amount: request.amount,
        browserSessionId: request.browserSessionId,
        createdAt: now.toISOString(),
        createdByUserId: scope.userId,
        currency: request.currency,
        expiresAt: new Date(now.getTime() + APPROVAL_WINDOW_MS).toISOString(),
        failureCode: null,
        id: handle,
        idempotencyKey: request.idempotencyKey,
        kind: request.kind,
        merchantAccountId:
          request.kind === "link_pay_token" ? request.merchantAccountId : null,
        merchantLabel:
          request.kind === "card"
            ? safeMerchantLabel(request.merchantName, request.merchantOrigin)
            : null,
        merchantOrigin: request.merchantOrigin,
        remoteSpendRequestId: null,
        requestFingerprint,
        rootSessionId: request.rootSessionId,
        status: "creating",
        termsFingerprint: request.termsFingerprint,
        updatedAt: now.toISOString(),
        workerSessionId: request.workerSessionId,
        workspaceId: scope.workspaceId,
      });
      const row = reservation.row;
      if (!row)
        throw new Error("The Link spend request could not be reserved.");
      if (row.createdByUserId !== scope.userId) {
        throw new Error("The Link spend request belongs to another user.");
      }
      if (row.requestFingerprint !== requestFingerprint) {
        throw new Error(
          "This idempotent Link operation was replayed with different checkout details."
        );
      }
      if (row.status !== "creating")
        return publicSpendRequest(scope, transaction, row);

      return withLinkCliSession(scope, transaction, async (session) => {
        if (!reservation.created) {
          const recovered = await recoverRemoteSpendRequest(session, row);
          if (recovered) {
            const updated = await persistRemoteSpend(
              scope,
              transaction,
              row,
              recovered
            );
            return publicSpendRequest(scope, transaction, updated);
          }
          // An earlier provider call may have succeeded even when its response
          // was lost. Never issue a second create for an existing reservation;
          // later polls can recover by provider ID or stable metadata.
          return publicSpendRequest(scope, transaction, row);
        }

        try {
          const result = await session.run(
            buildLinkSpendCreateArguments(
              request,
              row.id,
              session.directoryPath
            ),
            { timeoutMs: 22_000 }
          );
          const updated = await persistRemoteSpend(
            scope,
            transaction,
            row,
            parseLinkSpendProviderResponse(result)
          );
          return await publicSpendRequest(scope, transaction, updated);
        } catch (error) {
          if (isReauthenticationError(error) || isUnavailableError(error)) {
            throw error;
          }
          if (error instanceof LinkCliError && error.retryable) {
            const recovered = await recoverRemoteSpendRequest(
              session,
              row,
              error.remoteSpendRequestId
            ).catch(() => undefined);
            if (recovered) {
              const updated = await persistRemoteSpend(
                scope,
                transaction,
                row,
                recovered
              );
              return publicSpendRequest(scope, transaction, updated);
            }
            return publicSpendRequest(scope, transaction, row);
          }
          const updated = await updateLinkSpendRequest(
            transaction,
            scope,
            row.id,
            {
              failureCode: safeFailureCode(error),
              status: "failed",
              updatedAt: new Date().toISOString(),
            }
          );
          if (!updated) throw safeServiceError(error);
          return await publicSpendRequest(scope, transaction, updated);
        }
      });
    });
  } catch (error) {
    await persistReauthenticationIfNeeded(scope, error);
    throw safeServiceError(error);
  }
}

export async function pollLinkSpendRequest(
  scope: AccessScope,
  assertion: LinkCheckoutAssertion
): Promise<LinkSpendRequest> {
  const parsedAssertion = linkCheckoutAssertionSchema.parse(assertion);
  await ensureScope(scope);
  try {
    return await withLinkWalletWorkspaceLock(scope, async (transaction) => {
      await requireConnectedWallet(scope, transaction);
      let row = await requireSpendRow(
        scope,
        transaction,
        parsedAssertion,
        true
      );
      row = await expireIfNeeded(scope, transaction, row);
      if (TERMINAL_STATUSES.has(parseStatus(row.status))) {
        return publicSpendRequest(scope, transaction, row);
      }
      return withLinkCliSession(scope, transaction, async (session) => {
        if (!row.remoteSpendRequestId) {
          const recovered = await recoverRemoteSpendRequest(session, row);
          if (!recovered) return publicSpendRequest(scope, transaction, row);
          row = await persistRemoteSpend(scope, transaction, row, recovered);
        }
        if (!row.remoteSpendRequestId) {
          return publicSpendRequest(scope, transaction, row);
        }
        try {
          const result = await session.run(
            [
              "spend-request",
              "retrieve",
              row.remoteSpendRequestId,
              "--interval=2",
              "--max-attempts=10",
              "--timeout=24",
            ],
            { timeoutMs: POLL_TIMEOUT_MS }
          );
          row = await persistRemoteSpend(
            scope,
            transaction,
            row,
            parseLinkSpendProviderResponse(result)
          );
        } catch (error) {
          if (
            error instanceof LinkCliError &&
            error.code === "POLLING_TIMEOUT"
          ) {
            const updated = await updateLinkSpendRequest(
              transaction,
              scope,
              row.id,
              {
                status:
                  row.status === "created" ? "pending_approval" : row.status,
                updatedAt: new Date().toISOString(),
              }
            );
            if (updated) row = updated;
          } else {
            throw error;
          }
        }
        return publicSpendRequest(scope, transaction, row);
      });
    });
  } catch (error) {
    await persistReauthenticationIfNeeded(scope, error);
    throw safeServiceError(error);
  }
}

export async function cancelLinkSpendRequest(
  scope: AccessScope,
  assertion: LinkCheckoutAssertion
): Promise<LinkSpendRequest> {
  const parsedAssertion = linkCheckoutAssertionSchema.parse(assertion);
  await ensureScope(scope);
  try {
    return await withLinkWalletWorkspaceLock(scope, async (transaction) => {
      const row = await requireSpendRow(
        scope,
        transaction,
        parsedAssertion,
        true
      );
      if (!ACTIVE_STATUSES.has(parseStatus(row.status))) {
        return publicSpendRequest(scope, transaction, row);
      }
      if (row.remoteSpendRequestId) {
        const remoteSpendRequestId = row.remoteSpendRequestId;
        await withLinkCliSession(scope, transaction, (session) =>
          session
            .run(["spend-request", "cancel", remoteSpendRequestId], {
              timeoutMs: 10_000,
            })
            .catch(() => undefined)
        );
      }
      const updated = await updateLinkSpendRequest(transaction, scope, row.id, {
        failureCode: "CANCELED",
        status: "canceled",
        updatedAt: new Date().toISOString(),
      });
      await deleteApprovalSecret(scope, transaction, row.id);
      if (!updated) throw new Error("The Link spend request was lost.");
      return publicSpendRequest(scope, transaction, updated);
    });
  } catch (error) {
    await persistReauthenticationIfNeeded(scope, error);
    throw safeServiceError(error);
  }
}

export async function withLinkSpendCredential(
  scope: AccessScope,
  assertion: LinkCheckoutAssertion,
  callback: (lease: LinkSpendCredentialLease) => void | Promise<void>
): Promise<void> {
  const parsedAssertion = linkCheckoutAssertionSchema.parse(assertion);
  await ensureScope(scope);
  const callbackFailures: unknown[] = [];
  try {
    await withLinkWalletWorkspaceLock(scope, async (transaction) => {
      await requireConnectedWallet(scope, transaction);
      const row = await requireSpendRow(
        scope,
        transaction,
        parsedAssertion,
        true
      );
      if (row.status !== "approved" || !row.remoteSpendRequestId) {
        throw new Error(
          "The Link spend request is not approved for credential use."
        );
      }
      const remoteSpendRequestId = row.remoteSpendRequestId;
      await withLinkCliSession(scope, transaction, async (session) => {
        if (row.kind === "link_pay_token") {
          if (row.lptLeaseCount >= 2) {
            throw new Error(
              "The Link Pay Token retry allowance has already been used."
            );
          }
          const result = await session.run([
            "spend-request",
            "retrieve",
            remoteSpendRequestId,
            "--include=link_pay_token",
          ]);
          const remote = parseLinkSpendProviderResponse(result);
          if (remote.status !== "approved") {
            await persistRemoteSpend(scope, transaction, row, remote);
            throw new Error(
              "Link no longer considers this spend request approved."
            );
          }
          const token = parseLinkPayToken(result);
          const leased = await updateLinkSpendRequest(
            transaction,
            scope,
            row.id,
            {
              lptLeaseCount: row.lptLeaseCount + 1,
              updatedAt: new Date().toISOString(),
            }
          );
          if (!leased)
            throw new Error("The Link credential lease was not saved.");
          try {
            await callback({ kind: "link_pay_token", token });
          } catch (error) {
            callbackFailures.push(error);
          }
          return;
        }

        if (row.cardLeasedAt) {
          throw new Error(
            "The one-time Link virtual card was already injected."
          );
        }
        const filePath = join(
          session.directoryPath,
          `card-${randomUUID()}.json`
        );
        const result = await session.run([
          "spend-request",
          "retrieve",
          remoteSpendRequestId,
          "--include=card",
          `--output-file=${filePath}`,
        ]);
        const remote = parseLinkSpendProviderResponse(result);
        if (remote.status !== "approved") {
          await persistRemoteSpend(scope, transaction, row, remote);
          throw new Error(
            "Link no longer considers this spend request approved."
          );
        }
        await validateCredentialFile(filePath, remoteSpendRequestId);
        const leased = await updateLinkSpendRequest(
          transaction,
          scope,
          row.id,
          {
            cardLeasedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          }
        );
        if (!leased)
          throw new Error("The Link credential lease was not saved.");
        try {
          await callback({ filePath, kind: "card" });
        } catch (error) {
          callbackFailures.push(error);
        }
      });
    });
  } catch (error) {
    await persistReauthenticationIfNeeded(scope, error);
    throw safeServiceError(error);
  }
  if (callbackFailures.length > 0) throw callbackFailures[0];
}

export async function beginLinkSpendSubmission(
  scope: AccessScope,
  assertion: LinkCheckoutAssertion
): Promise<LinkSubmissionGuard> {
  const parsedAssertion = linkCheckoutAssertionSchema.parse(assertion);
  await ensureScope(scope);
  return withLinkWalletWorkspaceLock(scope, async (transaction) => {
    const row = await requireSpendRow(
      scope,
      transaction,
      parsedAssertion,
      true
    );
    if (row.submissionStartedAt) {
      return { startedAt: row.submissionStartedAt, state: "already_started" };
    }
    if (row.status !== "approved") {
      throw new Error("The approved Link payment can no longer be submitted.");
    }
    const startedAt = new Date().toISOString();
    const updated = await updateLinkSpendRequest(transaction, scope, row.id, {
      status: "submission_started",
      submissionStartedAt: startedAt,
      submissionUpdatedAt: startedAt,
      updatedAt: startedAt,
    });
    if (!updated)
      throw new Error("The Link submission guard could not be saved.");
    await deleteApprovalSecret(scope, transaction, row.id);
    return { startedAt, state: "started" };
  });
}

export async function recordLinkSpendSubmission(
  scope: AccessScope,
  assertion: LinkCheckoutAssertion,
  outcome: LinkSubmissionOutcome
): Promise<void> {
  const parsedAssertion = linkCheckoutAssertionSchema.parse(assertion);
  const parsedOutcome = linkSubmissionOutcomeSchema.parse(outcome);
  await ensureScope(scope);
  await withLinkWalletWorkspaceLock(scope, async (transaction) => {
    const row = await requireSpendRow(
      scope,
      transaction,
      parsedAssertion,
      false
    );
    if (row.status === "succeeded") return;
    if (!row.submissionStartedAt && parsedOutcome.outcome !== "blocked") {
      throw new Error("No guarded Link submission has started.");
    }
    const now = new Date().toISOString();
    await updateLinkSpendRequest(transaction, scope, row.id, {
      status:
        parsedOutcome.outcome === "confirmed"
          ? "succeeded"
          : parsedOutcome.outcome === "blocked"
            ? "failed"
            : row.status,
      submissionOutcome: parsedOutcome.outcome,
      submissionUpdatedAt: now,
      updatedAt: now,
    });
    if (parsedOutcome.outcome !== "submitted") {
      await deleteApprovalSecret(scope, transaction, row.id);
    }
  });
}

export async function reportLinkSpendRequestOutcome(
  scope: AccessScope,
  input: LinkReportOutcomeInput
): Promise<void> {
  const report = linkReportOutcomeSchema.parse(input);
  await ensureScope(scope);
  await withLinkWalletWorkspaceLock(scope, async (transaction) => {
    const row = await requireSpendRow(
      scope,
      transaction,
      report.assertion,
      false
    );
    if (row.reportedAt) return;
    const now = new Date().toISOString();
    await updateLinkSpendRequest(transaction, scope, row.id, {
      reportOutcome: report.outcome,
      reportedAt: now,
      updatedAt: now,
    });
    if (!row.remoteSpendRequestId) return;
    try {
      await withLinkCliSession(scope, transaction, (session) =>
        session.run(buildReportArguments(row, report), { timeoutMs: 10_000 })
      );
    } catch {
      // Reporting is best effort and must never turn a verified order into a failure.
    }
  });
}

async function requireConnectedWallet(
  scope: AccessScope,
  transaction: LinkWalletTransaction
) {
  const connection = await readLinkWalletConnection(transaction, scope);
  if (connection?.status === "connected") return connection;
  if (connection?.status === "reauthentication_required") {
    throw new LinkCliError("NOT_AUTHENTICATED");
  }
  throw new Error("Link Wallet is not connected for this workspace.");
}

async function finalizeConnectedWallet(
  scope: AccessScope,
  transaction: LinkWalletTransaction,
  session: LinkCliSession
): Promise<LinkWalletConnection> {
  let accountLabel: string | undefined;
  try {
    const user = await session.run(["user-info", "retrieve"]);
    accountLabel = maskLinkAccountLabel(
      readString(user, "email", "phone", "name")
    );
  } catch (error) {
    if (isReauthenticationError(error)) throw error;
  }
  const now = new Date().toISOString();
  await writeLinkWalletConnection(transaction, scope, {
    accountLabel: accountLabel ?? null,
    connectedAt: now,
    status: "connected",
    updatedAt: now,
  });
  await deleteSecret({
    database: transaction,
    id: PENDING_AUTH_SECRET_ID,
    namespace: "link",
    scope,
  });
  return { accountLabel, connectedAt: now, state: "connected" };
}

async function markReauthenticationRequired(
  scope: AccessScope,
  transaction: LinkWalletTransaction
) {
  await writeLinkWalletConnection(transaction, scope, {
    accountLabel: null,
    connectedAt: null,
    status: "reauthentication_required",
    updatedAt: new Date().toISOString(),
  });
  await deleteSecret({
    database: transaction,
    id: PENDING_AUTH_SECRET_ID,
    namespace: "link",
    scope,
  });
}

async function persistReauthenticationIfNeeded(
  scope: AccessScope,
  error: unknown
) {
  if (!isReauthenticationError(error)) return;
  await withLinkWalletWorkspaceLock(scope, (transaction) =>
    markReauthenticationRequired(scope, transaction)
  );
}

function isReauthenticationError(error: unknown) {
  return (
    error instanceof LinkCliError &&
    [
      "NOT_AUTHENTICATED",
      "INVALID_GRANT",
      "UNAUTHORIZED",
      "TOKEN_EXPIRED",
    ].includes(error.code)
  );
}

function isUnavailableError(error: unknown) {
  return (
    error instanceof LinkCliUnavailableError ||
    (error instanceof LinkCliError &&
      ["REGION_NOT_SUPPORTED", "UNAVAILABLE"].includes(error.code))
  );
}

function unavailableConnection(): LinkWalletConnection {
  return {
    reason:
      "Link Agent Wallet is currently available only to eligible US Link accounts.",
    state: "unavailable",
  };
}

function safeServiceError(error: unknown) {
  if (error instanceof LinkCliError || error instanceof Error) return error;
  return new Error("Link could not complete the request safely.");
}

async function readPendingAuthorization(
  scope: AccessScope,
  transaction: LinkWalletTransaction
) {
  const value = await readSecret({
    database: transaction,
    id: PENDING_AUTH_SECRET_ID,
    namespace: "link",
    scope,
  });
  if (!value) return undefined;
  try {
    return parseLinkDeviceAuthorization(JSON.parse(value) as unknown);
  } catch {
    return undefined;
  }
}

export function parseLinkDeviceAuthorization(value: unknown) {
  const verificationUrl = readLinkControlledUrl(
    value,
    "verification_url_complete",
    "verification_uri_complete",
    "verification_url",
    "verification_uri",
    "verificationUrl"
  );
  const phrase = readString(
    value,
    "phrase",
    "verification_phrase",
    "verification_code",
    "user_code",
    "userCode"
  );
  if (!verificationUrl || !phrase || phrase.length > 160) {
    throw new LinkCliError("INVALID_CLI_OUTPUT");
  }
  return { phrase, verificationUrl };
}

function parseLinkProfile(
  userPayload: unknown,
  paymentPayload: unknown,
  shippingPayload: unknown
): LinkProfile {
  const user = unwrapNamedObject(userPayload, "user", "user_info");
  const paymentMethods = readCollection(
    paymentPayload,
    "payment_methods",
    "data",
    "items"
  ).map(parsePaymentMethod);
  const shippingAddresses = readCollection(
    shippingPayload,
    "shipping_addresses",
    "addresses",
    "data",
    "items"
  ).map(parseShippingAddress);
  return {
    contact: {
      email: nullableString(user, "email"),
      name: nullableString(user, "name", "full_name"),
      phone: nullableString(user, "phone", "phone_number"),
    },
    defaultPaymentMethodId:
      paymentMethods.find(({ isDefault }) => isDefault)?.id ?? null,
    defaultShippingAddressId:
      shippingAddresses.find(({ isDefault }) => isDefault)?.id ?? null,
    paymentMethods,
    shippingAddresses,
  };
}

function parsePaymentMethod(value: JsonObject): LinkPaymentMethod {
  const card = objectAt(value, "card");
  const bank = objectAt(value, "bank_account", "bankAccount");
  const billing = objectAt(value, "billing_address", "billingAddress");
  const id = nullableString(value, "id");
  if (!id) throw new LinkCliError("INVALID_CLI_OUTPUT");
  return {
    bankAccount: bank
      ? {
          bankName: nullableString(bank, "bank_name", "bankName"),
          last4: nullableString(bank, "last4"),
        }
      : null,
    billingAddress: billing ? parseAddress(billing) : null,
    card: card
      ? {
          brand: nullableString(card, "brand"),
          expMonth: nullableInteger(card, "exp_month", "expMonth"),
          expYear: nullableInteger(card, "exp_year", "expYear"),
          last4: nullableString(card, "last4"),
        }
      : null,
    id,
    isDefault: readBoolean(value, "is_default", "isDefault") === true,
    nickname: nullableString(value, "nickname"),
    type:
      nullableString(value, "type") ??
      (card ? "card" : bank ? "bank_account" : "unknown"),
  };
}

function parseShippingAddress(value: JsonObject) {
  const id = nullableString(value, "id");
  if (!id) throw new LinkCliError("INVALID_CLI_OUTPUT");
  const address = objectAt(value, "address");
  return {
    address: address ? parseAddress(address) : null,
    id,
    isDefault: readBoolean(value, "is_default", "isDefault") === true,
    nickname: nullableString(value, "nickname"),
  };
}

function parseAddress(value: JsonObject): LinkAddress {
  return {
    city: nullableString(value, "city", "locality"),
    country: nullableString(value, "country", "country_code"),
    dependentLocality: nullableString(
      value,
      "dependent_locality",
      "dependentLocality"
    ),
    line1: nullableString(value, "line1", "line_1"),
    line2: nullableString(value, "line2", "line_2"),
    name: nullableString(value, "name", "recipient"),
    phone: nullableString(value, "phone", "phone_number"),
    postalCode: nullableString(value, "postal_code", "postalCode"),
    sortingCode: nullableString(value, "sorting_code", "sortingCode"),
    state: nullableString(value, "state", "administrative_area"),
  };
}

async function requireSpendRow(
  scope: AccessScope,
  transaction: LinkWalletTransaction,
  assertion: LinkCheckoutAssertion,
  strictMerchantBinding: boolean
) {
  const row = await readLinkSpendRequest(transaction, scope, assertion.handle);
  if (!row || row.createdByUserId !== scope.userId) {
    throw new Error("The Link spend request does not belong to this user.");
  }
  await assertLinkCheckoutOwnership(transaction, scope, assertion);
  if (
    row.browserSessionId !== assertion.browserSessionId ||
    row.workerSessionId !== assertion.workerSessionId ||
    row.rootSessionId !== assertion.rootSessionId ||
    row.merchantOrigin !== assertion.merchantOrigin ||
    row.termsFingerprint !== assertion.termsFingerprint ||
    row.currency !== assertion.currency ||
    assertion.currentAmount > row.amount
  ) {
    throw new Error(
      "The checkout no longer matches the Link-approved merchant, order, or amount."
    );
  }
  const enforceMerchantBinding =
    strictMerchantBinding &&
    row.status !== "submission_started" &&
    row.status !== "succeeded";
  if (enforceMerchantBinding) {
    if (row.kind === "link_pay_token" && !assertion.merchantAccountId) {
      throw new LinkCheckoutBindingError();
    }
    if (
      (row.kind === "link_pay_token" &&
        assertion.merchantAccountId !== row.merchantAccountId) ||
      (row.kind === "card" && assertion.merchantAccountId !== undefined)
    ) {
      throw new Error(
        "The checkout no longer matches the Link-approved Stripe merchant binding."
      );
    }
  }
  return row;
}

async function expireIfNeeded(
  scope: AccessScope,
  transaction: LinkWalletTransaction,
  row: LinkSpendRow
) {
  if (!ACTIVE_STATUSES.has(parseStatus(row.status))) return row;
  if (Date.parse(row.expiresAt) > Date.now()) return row;
  const updated = await updateLinkSpendRequest(transaction, scope, row.id, {
    failureCode: "EXPIRED",
    status: "expired",
    updatedAt: new Date().toISOString(),
  });
  await deleteApprovalSecret(scope, transaction, row.id);
  return updated ?? row;
}

export function buildLinkSpendCreateArguments(
  request: ParsedLinkSpendRequestInput,
  handle: string,
  directoryPath: string
) {
  const argv = [
    "spend-request",
    "create",
    `--amount=${String(request.amount)}`,
    `--currency=${request.currency}`,
    `--context=${safeApprovalContext(request)}`,
  ];
  for (const item of request.lineItems) {
    argv.push(`--line-item=${encodeLineItem(item)}`);
  }
  for (const total of request.totals) {
    argv.push(`--total=${encodeTotal(total)}`);
  }
  argv.push(
    `--metadata=openinstinct_handle:${handle}`,
    `--metadata=openinstinct_idempotency:${metadataIdempotency(request.idempotencyKey)}`,
    "--request-approval"
  );
  if (request.paymentMethodId) {
    argv.push(`--payment-method-id=${request.paymentMethodId}`);
  }
  if (request.kind === "link_pay_token") {
    argv.push(
      "--execution-method=link_pay_token",
      `--merchant-account-id=${request.merchantAccountId}`
    );
  } else {
    argv.push(
      `--merchant-name=${safeMerchantLabel(request.merchantName, request.merchantOrigin)}`,
      `--merchant-url=${request.merchantOrigin}`,
      `--output-file=${join(directoryPath, `created-card-${handle}.json`)}`
    );
    if (request.test) argv.push("--test");
  }
  return argv;
}

function encodeLineItem(
  item: ParsedLinkSpendRequestInput["lineItems"][number]
) {
  const fields: [string, string | number | undefined][] = [
    ["name", safeApprovalText(item.name, "Checkout item")],
    ["quantity", item.quantity],
    ["unit_amount", item.unitAmount],
  ];
  return fields
    .filter(
      (entry): entry is [string, string | number] => entry[1] !== undefined
    )
    .map(([key, value]) => `${key}:${normalizeCliValue(String(value))}`)
    .join(",");
}

function encodeTotal(total: ParsedLinkSpendRequestInput["totals"][number]) {
  return [
    `type:${total.type}`,
    `display_text:${totalDisplayLabel(total.type)}`,
    `amount:${String(total.amount)}`,
  ].join(",");
}

function normalizeCliValue(value: string) {
  return value
    .normalize("NFKC")
    .replace(/[\r\n,]+/gu, " ")
    .trim();
}

function safeApprovalContext(request: ParsedLinkSpendRequestInput) {
  const merchant = new URL(request.merchantOrigin).hostname;
  const items = request.lineItems
    .slice(0, 3)
    .map(({ name }) => safeApprovalText(name, "checkout item"));
  const itemSummary =
    items.length > 0 ? items.join(", ") : "the inspected checkout items";
  return [
    `OpenInstinct requests approval to purchase ${itemSummary} from ${merchant}.`,
    `The final authorized amount is ${String(request.amount)} minor units in ${request.currency.toUpperCase()}.`,
    "The user initiated this checkout, and the approval is limited to the inspected merchant, browser order, and same-or-lower final charge.",
  ].join(" ");
}

function safeApprovalText(value: string, fallback: string) {
  const normalized = normalizeCliValue(value).slice(0, 200);
  if (!normalized || containsLikelyPersonalData(normalized)) return fallback;
  return normalized;
}

function containsLikelyPersonalData(value: string) {
  return (
    Array.from(value).some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code <= 31 || code === 127;
    }) ||
    /\b[^\s@]+@[^\s@]+\.[^\s@]+\b/iu.test(value) ||
    /(?:\+?\d[\s().-]*){7,}/u.test(value) ||
    /\b\d{5}(?:-\d{4})?\b/u.test(value) ||
    /\b\d{1,6}\s+[\p{L}\d.'-]+(?:\s+[\p{L}\d.'-]+){0,3}\s+(?:street|st|avenue|ave|road|rd|lane|ln|drive|dr|boulevard|blvd|court|ct)\b/iu.test(
      value
    )
  );
}

function totalDisplayLabel(
  type: ParsedLinkSpendRequestInput["totals"][number]["type"]
) {
  return type
    .split("_")
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function metadataIdempotency(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function fingerprintRequest(request: ParsedLinkSpendRequestInput) {
  return createHash("sha256").update(stableStringify(request)).digest("hex");
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }
  if (isObject(value)) {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function safeMerchantLabel(value: string, merchantOrigin: string) {
  return safeApprovalText(value, new URL(merchantOrigin).hostname);
}

async function recoverRemoteSpendRequest(
  session: LinkCliSession,
  row: LinkSpendRow,
  knownRemoteId?: string
) {
  if (knownRemoteId) {
    try {
      return parseLinkSpendProviderResponse(
        await session.run(["spend-request", "retrieve", knownRemoteId])
      );
    } catch {
      // The metadata lookup below is the authoritative replay recovery path.
    }
  }
  const result = await session.run([
    "spend-request",
    "list",
    "--include-history",
  ]);
  const match = readCollection(result, "spend_requests", "data", "items").find(
    (candidate) => metadataMatches(candidate, row)
  );
  return match ? parseLinkSpendProviderResponse(match) : undefined;
}

function metadataMatches(candidate: JsonObject, row: LinkSpendRow) {
  const metadata = objectAt(candidate, "metadata");
  return (
    nullableString(metadata, "openinstinct_handle") === row.id ||
    nullableString(metadata, "openinstinct_idempotency") ===
      metadataIdempotency(row.idempotencyKey)
  );
}

interface ParsedRemoteSpend {
  readonly approvalUrl?: string;
  readonly expiresAt?: string;
  readonly failureCode?: string;
  readonly id: string;
  readonly nextAction?: LinkSpendNextAction;
  readonly status: LinkSpendRequestStatus;
}

export function parseLinkSpendProviderResponse(
  payload: unknown
): ParsedRemoteSpend {
  const value = unwrapNamedObject(payload, "spend_request", "data");
  const id = nullableString(value, "id", "spend_request_id");
  if (!id || !/^lsrq_[a-zA-Z\d_]+$/u.test(id)) {
    throw new LinkCliError("INVALID_CLI_OUTPUT");
  }
  const status = parseStatus(nullableString(value, "status") ?? "failed");
  const nextAction = parseNextAction(value);
  return {
    approvalUrl: findApprovalUrl(value),
    expiresAt: parseRemoteExpiry(value),
    failureCode: remoteFailureCode(value, status),
    id,
    nextAction:
      status === "requires_action"
        ? (nextAction ?? {
            displayMessage:
              "Link requires an account or payment-method update before a new approval.",
            resolution: "new_spend_request",
            type: "unknown",
          })
        : nextAction,
    status,
  };
}

async function persistRemoteSpend(
  scope: AccessScope,
  transaction: LinkWalletTransaction,
  row: LinkSpendRow,
  remote: ParsedRemoteSpend
) {
  if (row.remoteSpendRequestId && row.remoteSpendRequestId !== remote.id) {
    throw new Error("The Link provider request binding changed unexpectedly.");
  }
  const updated = await updateLinkSpendRequest(transaction, scope, row.id, {
    expiresAt: remote.expiresAt ?? row.expiresAt,
    failureCode: remote.failureCode ?? null,
    remoteSpendRequestId: remote.id,
    status: remote.status,
    updatedAt: new Date().toISOString(),
  });
  if (!updated) throw new Error("The Link spend request was lost.");
  if (remote.approvalUrl) {
    await writeSecret({
      database: transaction,
      id: approvalSecretId(row.id),
      namespace: "link",
      scope,
      value: remote.approvalUrl,
    });
  }
  if (
    TERMINAL_STATUSES.has(remote.status) ||
    remote.status === "submission_started"
  ) {
    await deleteApprovalSecret(scope, transaction, row.id);
  }
  if (remote.nextAction) {
    await writeSecret({
      database: transaction,
      id: `${APPROVAL_SECRET_PREFIX}${row.id}:next-action`,
      namespace: "link",
      scope,
      value: JSON.stringify(remote.nextAction),
    });
  }
  return updated;
}

async function publicSpendRequest(
  scope: AccessScope,
  transaction: LinkWalletTransaction,
  row: LinkSpendRow
): Promise<LinkSpendRequest> {
  const status = parseStatus(row.status);
  const approvalUrl = ACTIVE_STATUSES.has(status)
    ? await readApprovalSecret(scope, transaction, row.id)
    : undefined;
  const nextAction =
    status === "requires_action"
      ? await readNextAction(scope, transaction, row.id)
      : undefined;
  return {
    amount: row.amount,
    approvalUrl,
    currency: row.currency,
    failureCode: row.failureCode ?? undefined,
    handle: row.id,
    kind: parseKind(row.kind),
    merchantOrigin: row.merchantOrigin,
    nextAction,
    status,
    updatedAt: row.updatedAt,
  };
}

function findApprovalUrl(value: JsonObject) {
  return (
    readLinkControlledUrl(
      value,
      "approval_url",
      "request_approval_url",
      "approvalUrl",
      "action_url"
    ) ??
    readLinkControlledUrl(
      objectAt(value, "status_details", "statusDetails"),
      "approval_url",
      "action_url"
    )
  );
}

function parseNextAction(value: JsonObject): LinkSpendNextAction | undefined {
  const statusDetails = objectAt(value, "status_details", "statusDetails");
  const requiresAction = objectAt(
    statusDetails,
    "requires_action",
    "requiresAction"
  );
  const nextAction =
    objectAt(requiresAction, "next_action", "nextAction") ??
    objectAt(statusDetails, "next_action", "nextAction") ??
    objectAt(value, "next_action", "nextAction");
  if (!nextAction) return undefined;
  const type = nullableString(nextAction, "type");
  const resolutionValue = nullableString(nextAction, "resolution");
  if (!type) return undefined;
  const resolution =
    resolutionValue === "auto_resume" ? "auto_resume" : "new_spend_request";
  return {
    actionUrl: readUrl(nextAction, "action_url", "actionUrl"),
    displayMessage:
      resolution === "auto_resume"
        ? "Link needs an additional authentication step."
        : "Link requires an account or payment-method update before a new approval.",
    resolution,
    type: sanitizeCode(type).toLowerCase(),
  };
}

function parseRemoteExpiry(value: JsonObject) {
  const raw = value.expires_at ?? value.expiresAt ?? value.valid_until;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return safeIsoDate(raw < 10_000_000_000 ? raw * 1_000 : raw);
  }
  if (typeof raw === "string") {
    const numeric = Number(raw);
    if (raw.trim() && Number.isFinite(numeric)) {
      return safeIsoDate(numeric < 10_000_000_000 ? numeric * 1_000 : numeric);
    }
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  }
  return undefined;
}

function safeIsoDate(value: number) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

function remoteFailureCode(value: JsonObject, status: LinkSpendRequestStatus) {
  if (!["denied", "expired", "canceled", "failed"].includes(status)) {
    return undefined;
  }
  const details = objectAt(value, "status_details", "statusDetails");
  return sanitizeCode(
    nullableString(details, "code", "reason") ?? status.toUpperCase()
  );
}

function parseStatus(value: string): LinkSpendRequestStatus {
  const normalized = value.toLowerCase().replaceAll("-", "_");
  switch (normalized) {
    case "creating":
    case "created":
    case "pending_approval":
    case "approved":
    case "requires_action":
    case "submission_started":
    case "denied":
    case "expired":
    case "canceled":
    case "succeeded":
    case "failed":
      return normalized;
    default:
      throw new LinkCliError("INVALID_CLI_OUTPUT");
  }
}

function parseKind(value: string) {
  if (value === "card" || value === "link_pay_token") return value;
  throw new Error("The Link spend request has an invalid credential route.");
}

function safeFailureCode(error: unknown) {
  return error instanceof LinkCliError ? sanitizeCode(error.code) : "FAILED";
}

function sanitizeCode(value: string) {
  const normalized = value.toUpperCase().replace(/[^A-Z\d_]+/gu, "_");
  return normalized.slice(0, 100) || "FAILED";
}

function parseLinkPayToken(payload: unknown) {
  const value = unwrapNamedObject(payload, "spend_request", "data");
  const token = readString(value, "link_pay_token", "linkPayToken");
  if (!token || !/^lpt_[a-zA-Z\d_-]+$/u.test(token)) {
    throw new LinkCliError("INVALID_CLI_OUTPUT");
  }
  return token;
}

async function validateCredentialFile(filePath: string, remoteId: string) {
  const metadata = await lstat(filePath);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    (metadata.mode & 0o077) !== 0
  ) {
    throw new LinkCliError("INVALID_CREDENTIAL_FILE");
  }
  let credential;
  try {
    credential = linkCardCredentialFileSchema.parse(
      JSON.parse(await readFile(filePath, "utf8"))
    );
  } catch {
    throw new LinkCliError("INVALID_CREDENTIAL_FILE");
  }
  if (credential.spend_request_id !== remoteId) {
    throw new LinkCliError("INVALID_CREDENTIAL_FILE");
  }
}

function buildReportArguments(
  row: LinkSpendRow,
  report: LinkReportOutcomeInput
) {
  const remoteSpendRequestId = row.remoteSpendRequestId;
  if (!remoteSpendRequestId) {
    throw new Error("The Link provider request is unavailable for reporting.");
  }
  const argv = [
    "report",
    `--domain=${new URL(row.merchantOrigin).hostname}`,
    `--outcome=${report.outcome}`,
    `--spend-request-id=${remoteSpendRequestId}`,
  ];
  for (const tag of report.tags) argv.push(`--tag=${tag}`);
  if (report.step) {
    argv.push(`--step=${safeApprovalText(report.step, "checkout")}`);
  }
  if (
    report.freeformContext &&
    !containsLikelyPersonalData(report.freeformContext)
  ) {
    argv.push(
      `--freeform-context=${normalizeCliValue(report.freeformContext)}`
    );
  }
  return argv;
}

async function readApprovalSecret(
  scope: AccessScope,
  transaction: LinkWalletTransaction,
  handle: string
) {
  const value = await readSecret({
    database: transaction,
    id: approvalSecretId(handle),
    namespace: "link",
    scope,
  });
  return value && isLinkControlledUrl(value) ? value : undefined;
}

async function readNextAction(
  scope: AccessScope,
  transaction: LinkWalletTransaction,
  handle: string
) {
  const value = await readSecret({
    database: transaction,
    id: `${APPROVAL_SECRET_PREFIX}${handle}:next-action`,
    namespace: "link",
    scope,
  });
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    const object = asObject(parsed);
    const displayMessage = nullableString(object, "displayMessage");
    const type = nullableString(object, "type");
    const resolution = nullableString(object, "resolution");
    if (!displayMessage || !type) return undefined;
    return {
      actionUrl: readUrl(object, "actionUrl"),
      displayMessage,
      resolution:
        resolution === "auto_resume" ? "auto_resume" : "new_spend_request",
      type,
    } satisfies LinkSpendNextAction;
  } catch {
    return undefined;
  }
}

function approvalSecretId(handle: string) {
  return `${APPROVAL_SECRET_PREFIX}${handle}${APPROVAL_SECRET_SUFFIX}`;
}

async function deleteApprovalSecret(
  scope: AccessScope,
  transaction: LinkWalletTransaction,
  handle: string
) {
  await Promise.all([
    deleteSecret({
      database: transaction,
      id: approvalSecretId(handle),
      namespace: "link",
      scope,
    }),
    deleteSecret({
      database: transaction,
      id: `${APPROVAL_SECRET_PREFIX}${handle}:next-action`,
      namespace: "link",
      scope,
    }),
  ]);
}

function readCollection(payload: unknown, ...keys: string[]): JsonObject[] {
  if (isUnknownArray(payload)) {
    if (payload.length === 1 && isObject(payload[0])) {
      for (const key of keys) {
        const nested = payload[0][key];
        if (isUnknownArray(nested)) return nested.map(asObject);
      }
    }
    return payload.map(asObject);
  }
  const object = asObject(payload);
  for (const key of keys) {
    const value = object[key];
    if (isUnknownArray(value)) return value.map(asObject);
  }
  return [];
}

function unwrapNamedObject(payload: unknown, ...keys: string[]) {
  if (isUnknownArray(payload)) {
    const last = payload.at(-1);
    if (last === undefined) throw new LinkCliError("INVALID_CLI_OUTPUT");
    return unwrapNamedObject(last, ...keys);
  }
  const object = asObject(payload);
  for (const key of keys) {
    if (isObject(object[key])) return object[key];
  }
  return object;
}

function objectAt(value: unknown, ...keys: string[]) {
  if (isUnknownArray(value)) return objectAt(value.at(-1), ...keys);
  if (!isObject(value)) return undefined;
  for (const key of keys) {
    if (isObject(value[key])) return value[key];
  }
  return undefined;
}

function readString(value: unknown, ...keys: string[]) {
  if (isUnknownArray(value)) return readString(value.at(-1), ...keys);
  return (
    nullableString(isObject(value) ? value : undefined, ...keys) ?? undefined
  );
}

function nullableString(value: unknown, ...keys: string[]) {
  if (!isObject(value)) return null;
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }
  return null;
}

function nullableInteger(value: unknown, ...keys: string[]) {
  if (!isObject(value)) return null;
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "number" && Number.isInteger(candidate)) {
      return candidate;
    }
  }
  return null;
}

function readBoolean(value: unknown, ...keys: string[]) {
  if (isUnknownArray(value)) return readBoolean(value.at(-1), ...keys);
  if (!isObject(value)) return undefined;
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "boolean") return candidate;
  }
  return undefined;
}

function readUrl(value: unknown, ...keys: string[]) {
  const candidate = readString(value, ...keys);
  return candidate && isSafeExternalHttpsUrl(candidate) ? candidate : undefined;
}

function readLinkControlledUrl(value: unknown, ...keys: string[]) {
  const candidate = readString(value, ...keys);
  return candidate && isLinkControlledUrl(candidate) ? candidate : undefined;
}

function isLinkControlledUrl(value: string) {
  if (!isSafeExternalHttpsUrl(value)) return false;
  const hostname = new URL(value).hostname.toLowerCase();
  return hostname === "link.com" || hostname.endsWith(".link.com");
}

function isSafeExternalHttpsUrl(value: string) {
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  const hostname = url.hostname.toLowerCase();
  const address =
    hostname.startsWith("[") && hostname.endsWith("]")
      ? hostname.slice(1, -1)
      : hostname;
  return (
    url.protocol === "https:" &&
    !url.username &&
    !url.password &&
    hostname !== "localhost" &&
    !hostname.endsWith(".localhost") &&
    !hostname.endsWith(".local") &&
    isIP(address) === 0
  );
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function asObject(value: unknown): JsonObject {
  if (!isObject(value)) throw new LinkCliError("INVALID_CLI_OUTPUT");
  return value;
}
