import { describe, expect, it } from "vitest";
import { linkWalletSnapshotSchema, managerSnapshotSchema } from ".";

describe("linkWalletSnapshotSchema", () => {
  it.each([
    "connected",
    "connecting",
    "disconnected",
    "reauthentication-required",
    "unavailable",
  ] as const)("accepts the %s state", (state) => {
    expect(
      linkWalletSnapshotSchema.parse({ accountLabel: null, state })
    ).toEqual({ accountLabel: null, state });
  });

  it("does not expose the service-only pending state", () => {
    expect(
      linkWalletSnapshotSchema.safeParse({
        accountLabel: null,
        state: "pending",
      }).success
    ).toBe(false);
    expect(
      linkWalletSnapshotSchema.safeParse({
        accountLabel: "should-not-appear",
        state: "unavailable",
      }).success
    ).toBe(false);
  });

  it("strips service-only Link data from a manager snapshot", () => {
    const snapshot = managerSnapshotSchema.parse({
      browser: { available: true },
      googleWorkspace: { accountLabel: null, state: "disconnected" },
      linkWallet: {
        accessToken: "must-not-leave-the-server",
        accountLabel: "\u2022\u2022\u2022@example.com",
        connectedAt: "2026-08-28T12:00:00.000Z",
        phrase: "secret phrase",
        state: "connected",
        verificationUrl: "https://example.com/verify",
      },
      runtime: { inference: "openai/gpt-5" },
      secretStore: {
        available: true,
        description: "Encrypted",
        kind: "database",
      },
      vaultItems: [],
    });

    expect(snapshot.linkWallet).toEqual({
      accountLabel: "\u2022\u2022\u2022@example.com",
      state: "connected",
    });
    expect(JSON.stringify(snapshot)).not.toContain("must-not-leave-the-server");
    expect(JSON.stringify(snapshot)).not.toContain("secret phrase");
    expect(JSON.stringify(snapshot)).not.toContain("verificationUrl");
  });
});
