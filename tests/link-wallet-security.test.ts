import { describe, expect, it, vi } from "vitest";
import { linkCliChildEnvironment } from "../lib/link-wallet/cli";
import { maskLinkAccountLabel } from "../lib/link-wallet/safe-output";
import { linkSpendRequestInputSchema } from "../lib/link-wallet/types";

vi.mock("server-only", () => ({}));

const validInput = {
  amount: 2_500,
  browserSessionId: "browser-1",
  context:
    "The user initiated a purchase through the browser agent and reviewed the merchant, items, quantity, shipping, tax, and final total before requesting Link approval.",
  currency: "usd",
  idempotencyKey: "call:root:worker",
  kind: "card" as const,
  lineItems: [{ name: "Running shoes", quantity: 1, unitAmount: 2_500 }],
  merchantName: "Example Shop",
  merchantOrigin: "https://shop.example/checkout?session=secret",
  rootSessionId: "root-1",
  termsFingerprint: "a".repeat(64),
  totals: [{ amount: 2_500, displayText: "Total", type: "total" as const }],
  workerSessionId: "worker-1",
};

describe("Link wallet security boundaries", () => {
  it("requires complete integer checkout terms at the server boundary", () => {
    expect(linkSpendRequestInputSchema.safeParse(validInput).success).toBe(
      true
    );
    expect(
      linkSpendRequestInputSchema.safeParse({
        ...validInput,
        lineItems: [{ name: "Shoes", quantity: 1.5 }],
      }).success
    ).toBe(false);
    expect(
      linkSpendRequestInputSchema.safeParse({ ...validInput, lineItems: [] })
        .success
    ).toBe(false);
    expect(
      linkSpendRequestInputSchema.safeParse({
        ...validInput,
        totals: [{ amount: 2_600, displayText: "Total", type: "total" }],
      }).success
    ).toBe(false);
    expect(
      linkSpendRequestInputSchema.safeParse({
        ...validInput,
        merchantOrigin: "http://shop.example/checkout",
      }).success
    ).toBe(false);
    expect(
      linkSpendRequestInputSchema.safeParse({
        ...validInput,
        merchantOrigin: "http://localhost:3000/checkout",
      }).success
    ).toBe(true);
  });

  it("always masks complete account identifiers", () => {
    expect(maskLinkAccountLabel("person@example.com")).toBe("p•••@e•••.com");
    expect(maskLinkAccountLabel("+1 (415) 555-0199")).toBe("••• ••• 0199");
    expect(maskLinkAccountLabel("Pat Example")).toBe("P•••");
    expect(maskLinkAccountLabel("p***@example.com")).toBe("p•••@e•••.com");
  });

  it("passes only an allowlisted environment to Link CLI", () => {
    const child = linkCliChildEnvironment({
      DATABASE_URL: "postgres://secret",
      KERNEL_API_KEY: "kernel-secret",
      LANG: "en_US.UTF-8",
      LINK_ACCESS_TOKEN: "link-secret",
      NODE_ENV: "test",
      SECRET_ENCRYPTION_KEY: "encryption-secret",
      TMPDIR: "/tmp/safe",
    });

    expect(child).toMatchObject({
      CI: "1",
      LANG: "en_US.UTF-8",
      LINK_CLI_SKIP_SKILL_INSTALL: "1",
      NODE_ENV: "test",
      NO_UPDATE_NOTIFIER: "1",
      TMPDIR: "/tmp/safe",
    });
    expect(child).not.toHaveProperty("DATABASE_URL");
    expect(child).not.toHaveProperty("KERNEL_API_KEY");
    expect(child).not.toHaveProperty("LINK_ACCESS_TOKEN");
    expect(child).not.toHaveProperty("SECRET_ENCRYPTION_KEY");
  });

  it("accepts only Link-controlled device and approval URLs", async () => {
    const { parseLinkDeviceAuthorization, parseLinkSpendProviderResponse } =
      await import("../lib/link-wallet/server");

    expect(
      parseLinkDeviceAuthorization({
        user_code: "BLUE-MOON",
        verification_uri: "https://app.link.com/agent-auth",
      })
    ).toEqual({
      phrase: "BLUE-MOON",
      verificationUrl: "https://app.link.com/agent-auth",
    });
    for (const verificationUrl of [
      "http://app.link.com/agent-auth",
      "https://link.com.evil.example/agent-auth",
      "https://user:pass@app.link.com/agent-auth",
      "https://127.0.0.1/agent-auth",
      "https://[::1]/agent-auth",
    ]) {
      expect(() =>
        parseLinkDeviceAuthorization({
          user_code: "BLUE-MOON",
          verification_uri: verificationUrl,
        })
      ).toThrow(/safely/iu);
    }

    expect(
      parseLinkSpendProviderResponse({
        approval_url: "https://evil.example/approve",
        id: "lsrq_123",
        status: "pending_approval",
      }).approvalUrl
    ).toBeUndefined();
    expect(
      parseLinkSpendProviderResponse({
        approval_url: "https://app.link.com/approve/123",
        id: "lsrq_123",
        status: "pending_approval",
      }).approvalUrl
    ).toBe("https://app.link.com/approve/123");
    expect(
      parseLinkSpendProviderResponse({
        id: "lsrq_123",
        next_action: {
          action_url: "https://localhost/challenge",
          display_message: "Authenticate",
          resolution: "auto_resume",
          type: "three_d_secure",
        },
        status: "requires_action",
      }).nextAction?.actionUrl
    ).toBeUndefined();
    for (const actionUrl of [
      "https://[::1]/challenge",
      "https://[fc00::1]/challenge",
      "https://127.0.0.1/challenge",
    ]) {
      expect(
        parseLinkSpendProviderResponse({
          id: "lsrq_123",
          next_action: {
            action_url: actionUrl,
            display_message: "Authenticate",
            resolution: "auto_resume",
            type: "three_d_secure",
          },
          status: "requires_action",
        }).nextAction?.actionUrl
      ).toBeUndefined();
    }
  });

  it("synthesizes approval context and prevents option injection", async () => {
    const { buildLinkSpendCreateArguments } =
      await import("../lib/link-wallet/server");
    const request = linkSpendRequestInputSchema.parse({
      ...validInput,
      context:
        "--approve Contact jane@example.com at +1 415 555 0199 or 123 Main Street, 90210 before buying. The user reviewed shipping, tax, currency, and the final total.",
      lineItems: [
        {
          name: "--approve jane@example.com",
          quantity: 1,
          unitAmount: 2_500,
        },
      ],
      merchantName: "--test jane@example.com",
    });
    const argv = buildLinkSpendCreateArguments(
      request,
      "00000000-0000-4000-8000-000000000000",
      "/tmp/link-safe"
    );
    const serialized = argv.join("\n");

    expect(argv.slice(0, 2)).toEqual(["spend-request", "create"]);
    expect(argv).not.toContain("--approve");
    expect(argv).not.toContain("--test");
    expect(serialized).not.toContain("jane@example.com");
    expect(serialized).not.toContain("415 555 0199");
    expect(serialized).not.toContain("123 Main Street");
    expect(serialized).toContain("--merchant-name=shop.example");
    expect(
      argv
        .filter(
          (argument) =>
            argument.startsWith("--") && argument !== "--request-approval"
        )
        .every((argument) => argument.includes("="))
    ).toBe(true);
  });
});
