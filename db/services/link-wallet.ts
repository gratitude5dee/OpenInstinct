import { and, eq, inArray } from "drizzle-orm";
import type { AccessScope } from "@/lib/access-scope";
import {
  agentSessions,
  browserSessions,
  linkSpendRequests,
  linkWalletConnections,
} from "@/db";
import type { LinkWalletTransaction } from "./link-wallet-lock";

type ConnectionInsert = typeof linkWalletConnections.$inferInsert;
type SpendInsert = typeof linkSpendRequests.$inferInsert;
type SpendUpdate = Partial<
  Pick<
    SpendInsert,
    | "cardLeasedAt"
    | "expiresAt"
    | "failureCode"
    | "lptLeaseCount"
    | "remoteSpendRequestId"
    | "reportOutcome"
    | "reportedAt"
    | "status"
    | "submissionOutcome"
    | "submissionStartedAt"
    | "submissionUpdatedAt"
    | "updatedAt"
  >
>;

export async function readLinkWalletConnection(
  transaction: LinkWalletTransaction,
  scope: AccessScope
) {
  const rows = await transaction
    .select()
    .from(linkWalletConnections)
    .where(eq(linkWalletConnections.workspaceId, scope.workspaceId))
    .limit(1);
  return rows[0];
}

export async function writeLinkWalletConnection(
  transaction: LinkWalletTransaction,
  scope: AccessScope,
  connection: Omit<ConnectionInsert, "workspaceId">
) {
  const rows = await transaction
    .insert(linkWalletConnections)
    .values({ ...connection, workspaceId: scope.workspaceId })
    .onConflictDoUpdate({
      target: linkWalletConnections.workspaceId,
      set: connection,
    })
    .returning();
  return rows[0];
}

export async function deleteLinkWalletConnection(
  transaction: LinkWalletTransaction,
  scope: AccessScope
) {
  await transaction
    .delete(linkWalletConnections)
    .where(eq(linkWalletConnections.workspaceId, scope.workspaceId));
}

export async function reserveLinkSpendRequest(
  transaction: LinkWalletTransaction,
  input: SpendInsert
) {
  const rows = await transaction
    .insert(linkSpendRequests)
    .values(input)
    .onConflictDoNothing({
      target: [linkSpendRequests.workspaceId, linkSpendRequests.idempotencyKey],
    })
    .returning();
  const row =
    rows[0] ??
    (await readLinkSpendRequestByIdempotencyKey(
      transaction,
      { userId: input.createdByUserId, workspaceId: input.workspaceId },
      input.idempotencyKey
    ));
  return { created: rows[0] !== undefined, row };
}

async function readLinkSpendRequestByIdempotencyKey(
  transaction: LinkWalletTransaction,
  scope: AccessScope,
  idempotencyKey: string
) {
  const rows = await transaction
    .select()
    .from(linkSpendRequests)
    .where(
      and(
        eq(linkSpendRequests.workspaceId, scope.workspaceId),
        eq(linkSpendRequests.idempotencyKey, idempotencyKey)
      )
    )
    .limit(1);
  return rows[0];
}

export async function readLinkSpendRequest(
  transaction: LinkWalletTransaction,
  scope: AccessScope,
  handle: string
) {
  const rows = await transaction
    .select()
    .from(linkSpendRequests)
    .where(
      and(
        eq(linkSpendRequests.id, handle),
        eq(linkSpendRequests.workspaceId, scope.workspaceId)
      )
    )
    .limit(1);
  return rows[0];
}

export async function updateLinkSpendRequest(
  transaction: LinkWalletTransaction,
  scope: AccessScope,
  handle: string,
  update: SpendUpdate
) {
  const rows = await transaction
    .update(linkSpendRequests)
    .set(update)
    .where(
      and(
        eq(linkSpendRequests.id, handle),
        eq(linkSpendRequests.workspaceId, scope.workspaceId)
      )
    )
    .returning();
  return rows[0];
}

export async function listActiveLinkSpendRequests(
  transaction: LinkWalletTransaction,
  scope: AccessScope
) {
  return transaction
    .select()
    .from(linkSpendRequests)
    .where(
      and(
        eq(linkSpendRequests.workspaceId, scope.workspaceId),
        inArray(linkSpendRequests.status, [
          "creating",
          "created",
          "pending_approval",
          "approved",
          "requires_action",
        ])
      )
    );
}

export async function invalidateActiveLinkSpendRequests(
  transaction: LinkWalletTransaction,
  scope: AccessScope,
  now: string
) {
  await transaction
    .update(linkSpendRequests)
    .set({
      failureCode: "LINK_DISCONNECTED",
      status: "canceled",
      updatedAt: now,
    })
    .where(
      and(
        eq(linkSpendRequests.workspaceId, scope.workspaceId),
        inArray(linkSpendRequests.status, [
          "creating",
          "created",
          "pending_approval",
          "approved",
          "requires_action",
        ])
      )
    );
}

export async function assertLinkCheckoutOwnership(
  transaction: LinkWalletTransaction,
  scope: AccessScope,
  input: {
    readonly browserSessionId: string;
    readonly rootSessionId: string;
    readonly workerSessionId: string;
  }
) {
  const [browserRows, agentRows] = await Promise.all([
    transaction
      .select({ sessionId: browserSessions.sessionId })
      .from(browserSessions)
      .where(
        and(
          eq(browserSessions.sessionId, input.browserSessionId),
          eq(browserSessions.workspaceId, scope.workspaceId),
          eq(browserSessions.createdByUserId, scope.userId)
        )
      )
      .limit(1),
    transaction
      .select({ sessionId: agentSessions.sessionId })
      .from(agentSessions)
      .where(
        and(
          eq(agentSessions.workspaceId, scope.workspaceId),
          eq(agentSessions.createdByUserId, scope.userId),
          inArray(agentSessions.sessionId, [
            input.rootSessionId,
            input.workerSessionId,
          ])
        )
      ),
  ]);
  const agentIds = new Set(agentRows.map(({ sessionId }) => sessionId));
  if (
    input.rootSessionId === input.workerSessionId ||
    browserRows.length !== 1 ||
    !agentIds.has(input.rootSessionId) ||
    !agentIds.has(input.workerSessionId)
  ) {
    throw new Error(
      "The Link checkout is not owned by this workspace and worker lineage."
    );
  }
}
