import { describe, expect, it } from "vitest";
import {
  maskLinkWalletAccountLabel,
  toSafeLinkWalletConnection,
} from "./link-wallet";

describe("maskLinkWalletAccountLabel", () => {
  it("preserves provider labels that are already masked", () => {
    expect(maskLinkWalletAccountLabel("a\u2022\u2022\u2022@example.com")).toBe(
      "a\u2022\u2022\u2022@example.com"
    );
    expect(
      maskLinkWalletAccountLabel("Visa \u2022\u2022\u2022\u2022 4242")
    ).toBe("Visa \u2022\u2022\u2022\u2022 4242");
  });

  it("reveals only a domain or final four digits from raw identifiers", () => {
    expect(maskLinkWalletAccountLabel("person@example.com")).toBe(
      "\u2022\u2022\u2022@example.com"
    );
    expect(maskLinkWalletAccountLabel("+1 (415) 555-1234")).toBe(
      "\u2022\u2022\u2022\u2022 1234"
    );
  });

  it("replaces unrecognized personal labels with a generic label", () => {
    expect(maskLinkWalletAccountLabel("Ada Lovelace")).toBe("Link account");
    expect(maskLinkWalletAccountLabel("Ada * Lovelace")).toBe("Link account");
    expect(maskLinkWalletAccountLabel(undefined)).toBeNull();
  });

  it("strips service-only fields from protected connection responses", () => {
    expect(
      toSafeLinkWalletConnection({
        accessToken: "must-not-leave-the-server",
        accountLabel: "person@example.com",
        connectedAt: "2026-08-28T12:00:00.000Z",
        state: "connected",
      } as Parameters<typeof toSafeLinkWalletConnection>[0] & {
        accessToken: string;
      })
    ).toEqual({ accountLabel: "•••@example.com", state: "connected" });
  });
});
