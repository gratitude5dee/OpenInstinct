import { describe, expect, it } from "vitest";
import {
  linkWalletActionLabel,
  linkWalletDescription,
} from "./link-wallet-copy";

describe("Link Wallet connection copy", () => {
  it("shows the masked account label for a connected wallet", () => {
    expect(
      linkWalletDescription({
        accountLabel: "a•••@example.com",
        state: "connected",
      })
    ).toBe("a•••@example.com");
    expect(linkWalletActionLabel("connected")).toBe("Manage");
  });

  it.each([
    ["disconnected", "Connect"],
    ["connecting", "Continue"],
    ["reauthentication-required", "Reconnect"],
    ["unavailable", "Unavailable"],
  ] as const)("maps %s to an accessible action", (state, label) => {
    expect(linkWalletActionLabel(state)).toBe(label);
    expect(
      linkWalletDescription({ accountLabel: null, state })
    ).not.toHaveLength(0);
  });
});
