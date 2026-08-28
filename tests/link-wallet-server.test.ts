/* oxlint-disable typescript/no-unsafe-assignment, typescript/no-unsafe-member-access, typescript/no-unsafe-type-assertion, vitest/require-mock-type-parameters -- Hoisted database and CLI fakes are configured per test. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AccessScope } from "../lib/access-scope";

const mocks = vi.hoisted(() => ({
  assertLinkCheckoutOwnership: vi.fn().mockResolvedValue(undefined),
  assertLinkCliAvailable: vi.fn().mockResolvedValue(undefined),
  deleteApproval: vi.fn().mockResolvedValue(undefined),
  deleteConnection: vi.fn().mockResolvedValue(undefined),
  deleteEncryptedNamespace: vi.fn().mockResolvedValue(undefined),
  deleteSecret: vi.fn().mockResolvedValue(undefined),
  ensureScope: vi.fn().mockResolvedValue(undefined),
  invalidateActive: vi.fn().mockResolvedValue(undefined),
  listActive: vi.fn().mockResolvedValue([]),
  readConnection: vi.fn(),
  readSecret: vi.fn().mockResolvedValue(undefined),
  reserveSpend: vi.fn(),
  run: vi.fn(),
  updateSpend: vi.fn(),
  withLock: vi.fn(),
  withSession: vi.fn(),
  writeConnection: vi.fn().mockResolvedValue(undefined),
  writeSecret: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("server-only", () => ({}));
vi.mock("../db/services/scope", () => ({ ensureScope: mocks.ensureScope }));
vi.mock("../db/services/link-wallet-lock", () => ({
  withLinkWalletWorkspaceLock: mocks.withLock,
}));
vi.mock("../db/services/link-wallet", () => ({
  assertLinkCheckoutOwnership: mocks.assertLinkCheckoutOwnership,
  deleteLinkWalletConnection: mocks.deleteConnection,
  invalidateActiveLinkSpendRequests: mocks.invalidateActive,
  listActiveLinkSpendRequests: mocks.listActive,
  readLinkSpendRequest: vi.fn(),
  readLinkWalletConnection: mocks.readConnection,
  reserveLinkSpendRequest: mocks.reserveSpend,
  updateLinkSpendRequest: mocks.updateSpend,
  writeLinkWalletConnection: mocks.writeConnection,
}));
vi.mock("../db/services/secrets", () => ({
  deleteEncryptedSecretNamespace: mocks.deleteEncryptedNamespace,
}));
vi.mock("../lib/manager/server/secret-store", () => ({
  deleteSecret: mocks.deleteSecret,
  readSecret: mocks.readSecret,
  writeSecret: mocks.writeSecret,
}));
vi.mock("../lib/link-wallet/cli", () => {
  class MockLinkCliError extends Error {
    readonly code: string;
    readonly remoteSpendRequestId?: string;
    readonly retryable: boolean;

    constructor(
      code: string,
      options: {
        readonly remoteSpendRequestId?: string;
        readonly retryable?: boolean;
      } = {}
    ) {
      super("Link could not complete the request safely.");
      this.code = code;
      this.remoteSpendRequestId = options.remoteSpendRequestId;
      this.retryable = options.retryable ?? false;
    }
  }
  return {
    assertLinkCliAvailable: mocks.assertLinkCliAvailable,
    LinkCliError: MockLinkCliError,
    LinkCliUnavailableError: class extends Error {},
    withLinkCliSession: mocks.withSession,
  };
});

const scope: AccessScope = {
  userId: "user-1",
  workspaceId: "workspace-1",
};

const input = {
  amount: 2_500,
  browserSessionId: "browser-1",
  context:
    "The user initiated this checkout and reviewed the merchant, item quantities, shipping, tax, currency, and final total before requesting Link purchase approval.",
  currency: "usd",
  idempotencyKey: "call:root:worker",
  kind: "card" as const,
  lineItems: [{ name: "Running shoes", quantity: 1, unitAmount: 2_500 }],
  merchantName: "Example Shop",
  merchantOrigin: "https://shop.example/checkout",
  rootSessionId: "root-1",
  termsFingerprint: "a".repeat(64),
  totals: [{ amount: 2_500, displayText: "Total", type: "total" as const }],
  workerSessionId: "worker-1",
};

function spendRow() {
  return {
    amount: 2_500,
    browserSessionId: "browser-1",
    cardLeasedAt: null,
    createdAt: "2026-08-28T00:00:00.000Z",
    createdByUserId: "user-1",
    currency: "usd",
    expiresAt: "2099-08-28T00:10:00.000Z",
    failureCode: null,
    id: "00000000-0000-4000-8000-000000000000",
    idempotencyKey: "call:root:worker",
    kind: "card",
    lptLeaseCount: 0,
    merchantAccountId: null,
    merchantLabel: "Example Shop",
    merchantOrigin: "https://shop.example",
    remoteSpendRequestId: null,
    reportOutcome: null,
    reportedAt: null,
    requestFingerprint: "request-fingerprint",
    rootSessionId: "root-1",
    status: "creating",
    submissionOutcome: null,
    submissionStartedAt: null,
    submissionUpdatedAt: null,
    termsFingerprint: "a".repeat(64),
    updatedAt: "2026-08-28T00:00:00.000Z",
    workerSessionId: "worker-1",
    workspaceId: "workspace-1",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.withLock.mockImplementation(
    async (_scope: AccessScope, operation: (transaction: object) => unknown) =>
      operation({})
  );
  mocks.withSession.mockImplementation(
    async (
      _scope: AccessScope,
      _transaction: object,
      operation: (session: object) => unknown
    ) =>
      operation({
        authFilePath: "/tmp/auth.json",
        directoryPath: "/tmp/link-session",
        run: mocks.run,
      })
  );
  mocks.readConnection.mockResolvedValue({ status: "connected" });
  mocks.readSecret.mockResolvedValue(undefined);
});

describe("Link wallet service", () => {
  it("never creates a second provider request after an ambiguous first call", async () => {
    const { createOrReuseLinkSpendRequest } =
      await import("../lib/link-wallet/server");
    const { LinkCliError } = await import("../lib/link-wallet/cli");
    const row = spendRow();
    // The service computes this value before reservation; reflect it in the
    // fake database record through the insert payload.
    mocks.reserveSpend
      .mockImplementationOnce(async (_transaction, inserted) => ({
        created: true,
        row: { ...row, requestFingerprint: inserted.requestFingerprint },
      }))
      .mockImplementationOnce(async (_transaction, inserted) => ({
        created: false,
        row: { ...row, requestFingerprint: inserted.requestFingerprint },
      }));
    mocks.run.mockImplementation(async (arguments_: string[]) => {
      if (arguments_[1] === "create") {
        throw new LinkCliError("CLI_FAILED", { retryable: true });
      }
      if (arguments_[1] === "list") return [];
      throw new Error("unexpected command");
    });

    await expect(
      createOrReuseLinkSpendRequest(scope, input)
    ).resolves.toMatchObject({
      status: "creating",
    });
    await expect(
      createOrReuseLinkSpendRequest(scope, input)
    ).resolves.toMatchObject({
      status: "creating",
    });

    const createCalls = mocks.run.mock.calls.filter(
      ([arguments_]) => (arguments_ as string[])[1] === "create"
    );
    expect(createCalls).toHaveLength(1);
  });

  it("serializes all profile commands against the workspace auth file", async () => {
    const { readLinkProfile } = await import("../lib/link-wallet/server");
    let active = 0;
    let maximumActive = 0;
    const order: string[] = [];
    mocks.run.mockImplementation(async (arguments_: string[]) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      order.push(arguments_.slice(0, 2).join(" "));
      await Promise.resolve();
      active -= 1;
      if (arguments_[0] === "user-info") {
        return [{ email: "person@example.com", name: "Person", phone: null }];
      }
      if (arguments_[0] === "payment-methods") {
        return [{ id: "csmrpd_123", is_default: true, type: "card" }];
      }
      return [
        {
          address: { city: "Seattle", country: "US", line1: "1 Main" },
          id: "addr_123",
          is_default: true,
        },
      ];
    });

    await expect(readLinkProfile(scope)).resolves.toMatchObject({
      contact: { email: "person@example.com" },
      defaultPaymentMethodId: "csmrpd_123",
      defaultShippingAddressId: "addr_123",
    });
    expect(maximumActive).toBe(1);
    expect(order).toEqual([
      "user-info retrieve",
      "payment-methods list",
      "shipping-address list",
    ]);
  });

  it("masks even an accidentally raw stored account label", async () => {
    const { getLinkWalletConnection } =
      await import("../lib/link-wallet/server");
    mocks.readConnection.mockResolvedValue({
      accountLabel: "person@example.com",
      connectedAt: "2026-08-28T00:00:00.000Z",
      status: "connected",
    });

    await expect(getLinkWalletConnection(scope)).resolves.toEqual({
      accountLabel: "p•••@e•••.com",
      connectedAt: "2026-08-28T00:00:00.000Z",
      state: "connected",
    });
  });
});
