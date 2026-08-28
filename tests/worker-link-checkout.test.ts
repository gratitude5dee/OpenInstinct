/* oxlint-disable typescript/no-unsafe-type-assertion, typescript/no-unsafe-assignment, typescript/no-unsafe-call, typescript/no-unsafe-member-access, typescript/no-unsafe-return, vitest/require-mock-type-parameters -- Eve owns tool contexts; these tests exercise mocked worker authorization and secret-boundary calls. */
import { beforeEach, describe, expect, it, vi } from "vitest";

const spendHandle = "0d01e667-d128-4bb7-a248-1ae21db72f4f";
const accountId = "acct_123456789";
const scope = { userId: "user-1", workspaceId: "workspace-1" };

const mocks = vi.hoisted(() => ({
  LinkCheckoutBindingError: class LinkCheckoutBindingError extends Error {},
  beginSubmission: vi.fn(),
  cancelSpend: vi.fn(),
  createSpend: vi.fn(),
  currentOrigin: vi.fn(),
  fillAutofill: vi.fn(),
  injectToken: vi.fn(),
  inspectConfirmation: vi.fn(),
  inspectSurface: vi.fn(),
  materializeClaims: vi.fn(),
  pollSpend: vi.fn(),
  readCredentialFile: vi.fn(),
  readLinkProfile: vi.fn(),
  readVaultItem: vi.fn(),
  recordSubmission: vi.fn(),
  reportOutcome: vi.fn(),
  requireOwnedBrowserSession: vi.fn(),
  requireWorkerScope: vi.fn(),
  revalidateQuote: vi.fn(),
  submitAndVerify: vi.fn(),
  verifySubmit: vi.fn(),
  withCredential: vi.fn(),
}));
const missingMerchantBinding = new mocks.LinkCheckoutBindingError();

vi.mock("@/agent/subagents/worker/lib/access", () => ({
  requireWorkerScope: mocks.requireWorkerScope,
}));
vi.mock("node:fs/promises", () => ({
  readFile: mocks.readCredentialFile,
}));
vi.mock("@/agent/subagents/worker/lib/owned-browser", () => ({
  requireOwnedBrowserSession: mocks.requireOwnedBrowserSession,
}));
vi.mock("@/db/services/vault", () => ({
  readVaultItem: mocks.readVaultItem,
}));
vi.mock("@/lib/kernel", () => ({
  kernel: { browsers: { retrieve: vi.fn() } },
}));
vi.mock("@/lib/link-wallet/server", () => ({
  beginLinkSpendSubmission: mocks.beginSubmission,
  cancelLinkSpendRequest: mocks.cancelSpend,
  createOrReuseLinkSpendRequest: mocks.createSpend,
  LinkCheckoutBindingError: mocks.LinkCheckoutBindingError,
  pollLinkSpendRequest: mocks.pollSpend,
  readLinkProfile: mocks.readLinkProfile,
  recordLinkSpendSubmission: mocks.recordSubmission,
  reportLinkSpendRequestOutcome: mocks.reportOutcome,
  withLinkSpendCredential: mocks.withCredential,
}));
vi.mock("@/lib/manager/server/kernel-native-autofill", () => ({
  currentKernelPageOrigin: mocks.currentOrigin,
  fillWithKernelNativeAutofill: mocks.fillAutofill,
  injectLinkPayTokenWithKernel: mocks.injectToken,
  inspectKernelOrderConfirmation: mocks.inspectConfirmation,
  inspectLinkCheckoutSurface: mocks.inspectSurface,
  nativeAutofillTokens: {
    address: [
      "name",
      "street-address",
      "address-line1",
      "address-line2",
      "address-level2",
      "address-level1",
      "postal-code",
      "country",
    ],
    contact: ["name", "email", "tel"],
    login: ["username", "current-password"],
    payment: ["cc-name", "cc-number", "cc-exp-month", "cc-exp-year", "cc-csc"],
  },
  revalidateKernelCheckoutQuote: mocks.revalidateQuote,
  submitKernelCheckoutAndVerify: mocks.submitAndVerify,
  verifyKernelCheckoutSubmitControl: mocks.verifySubmit,
}));
vi.mock("@/lib/manager/server/vault-autofill", () => ({
  materializeAutofillClaims: mocks.materializeClaims,
}));
vi.mock("@/lib/manager/server/vault-autofill-provider", () => ({
  vaultAutofillProvider: {},
}));

import {
  type linkCheckoutQuoteSchema,
  linkCheckoutTermsFingerprint,
} from "../lib/link-wallet";
import completeLinkPayment from "../agent/subagents/worker/tools/complete_link_payment";
import fillCheckoutFromLink from "../agent/subagents/worker/tools/fill_checkout_from_link";
import fillFromVault from "../agent/subagents/worker/tools/fill_from_vault";
import requestLinkSpend from "../agent/subagents/worker/tools/request_link_spend";
import { z } from "zod";

const quoteItem = {
  name: "Cotton shirt",
  options: [{ name: "Color", value: "Blue" }],
  quantity: 1,
  unitAmount: 2_599,
};

const quote: z.input<typeof linkCheckoutQuoteSchema> = {
  amount: 2_599,
  context:
    "Purchase one blue cotton shirt from Example Merchant for the displayed final amount after shipping and tax were calculated.",
  currency: "usd",
  fulfillment: { method: "shipping", option: "Standard" },
  items: [quoteItem],
  merchantName: "Example Merchant",
  totals: [{ amount: 2_599, displayText: "Total", type: "total" }],
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireWorkerScope.mockResolvedValue(scope);
  mocks.requireOwnedBrowserSession.mockResolvedValue({
    sessionId: "browser-1",
  });
  mocks.currentOrigin.mockResolvedValue("https://merchant.example");
  mocks.fillAutofill.mockResolvedValue({
    filledClaims: 1,
    origin: "https://merchant.example",
  });
  mocks.revalidateQuote.mockResolvedValue({
    origin: "https://merchant.example",
  });
  mocks.verifySubmit.mockResolvedValue({ origin: "https://merchant.example" });
  mocks.recordSubmission.mockResolvedValue(undefined);
  mocks.reportOutcome.mockResolvedValue(undefined);
  mocks.cancelSpend.mockResolvedValue(undefined);
  mocks.readCredentialFile.mockResolvedValue("");
});

describe("worker Link checkout", () => {
  it("keeps lower pricing authorized but binds quantities and options", () => {
    const approved = linkCheckoutTermsFingerprint(quote, accountId);
    expect(
      linkCheckoutTermsFingerprint(
        {
          ...quote,
          amount: 2_199,
          items: [{ ...quoteItem, unitAmount: 2_199 }],
          totals: [{ amount: 2_199, displayText: "Total", type: "total" }],
        },
        accountId
      )
    ).toBe(approved);
    expect(
      linkCheckoutTermsFingerprint(
        {
          ...quote,
          items: [{ ...quoteItem, quantity: 2 }],
        },
        accountId
      )
    ).not.toBe(approved);
    expect(
      linkCheckoutTermsFingerprint(
        {
          ...quote,
          items: [
            {
              ...quoteItem,
              options: [{ name: "Color", value: "Red" }],
            },
          ],
        },
        accountId
      )
    ).not.toBe(approved);
  });

  it("fills only requested Link categories and returns no profile values", async () => {
    mocks.readLinkProfile.mockResolvedValue({
      contact: {
        email: "private@example.com",
        name: "Private Person",
        phone: "+12025550123",
      },
      defaultPaymentMethodId: null,
      defaultShippingAddressId: null,
      paymentMethods: [],
      shippingAddresses: [],
    });

    const result = await fillCheckoutFromLink.execute(
      { browserSessionId: "browser-1", categories: ["email"] },
      context() as never
    );

    expect(mocks.fillAutofill).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        claims: [expect.objectContaining({ token: "email" })],
        kind: "contact",
      })
    );
    expect(result).toEqual({
      filled: ["email"],
      missing: [],
      success: true,
    });
    expect(JSON.stringify(result)).not.toContain("private@example.com");
    expect(JSON.stringify(result)).not.toContain("Private Person");
    const input = fillCheckoutFromLink.inputSchema;
    if (!(input instanceof z.ZodObject)) {
      throw new Error("fill_checkout_from_link must have an object schema.");
    }
    expect(
      input.safeParse({
        browserSessionId: "browser-1",
        email: "private@example.com",
      }).success
    ).toBe(false);
  });

  it("treats an ambiguously targetable Link shipping form as missing", async () => {
    mocks.readLinkProfile.mockResolvedValue({
      contact: { email: null, name: null, phone: null },
      defaultPaymentMethodId: null,
      defaultShippingAddressId: "shipping-1",
      paymentMethods: [],
      shippingAddresses: [
        {
          address: {
            city: "Private City",
            country: "US",
            dependentLocality: null,
            line1: "1 Private Street",
            line2: null,
            name: "Private Person",
            phone: null,
            postalCode: "10001",
            sortingCode: null,
            state: "NY",
          },
          id: "shipping-1",
          isDefault: true,
          nickname: null,
        },
      ],
    });
    mocks.fillAutofill.mockRejectedValueOnce(
      new Error(
        "No visible shipping address form has explicit autocomplete ownership."
      )
    );

    const result = await fillCheckoutFromLink.execute(
      {
        browserSessionId: "browser-1",
        categories: ["shipping_address"],
      },
      context() as never
    );

    expect(result).toEqual({
      filled: [],
      missing: ["shipping_address"],
      success: true,
    });
    expect(JSON.stringify(result)).not.toContain("Private");
    expect(mocks.fillAutofill).toHaveBeenCalledWith(
      expect.objectContaining({ addressPurpose: "shipping" })
    );
  });

  it("restricts vault contact fallback to Link-missing categories", async () => {
    mocks.readVaultItem.mockResolvedValue({
      id: "contact-1",
      kind: "contact",
      label: "Checkout",
    });
    mocks.materializeClaims.mockImplementation(
      async (_scope, _candidateId, target) => {
        expect([...target.availableTokens]).toEqual(["email"]);
        return [{ id: crypto.randomUUID(), token: "email", value: "secret" }];
      }
    );

    await fillFromVault.execute(
      {
        browserSessionId: "browser-1",
        candidateId: "contact-1",
        fieldCategories: ["email"],
      },
      context() as never
    );

    expect(mocks.fillAutofill).toHaveBeenCalledWith(
      expect.objectContaining({
        claims: [expect.objectContaining({ token: "email" })],
        kind: "contact",
      })
    );
  });

  it.each([
    ["link_pay_token", accountId, "link_pay_token"],
    ["virtual_card", null, "card"],
  ] as const)(
    "selects the inspected %s route before creating approval",
    async (route, merchantAccountId, kind) => {
      mocks.inspectSurface.mockResolvedValue({
        merchantAccountId,
        origin: "https://merchant.example",
        route,
      });
      mocks.createSpend.mockResolvedValue({
        amount: 2_599,
        approvalUrl: "https://link.com/approve/test",
        currency: "usd",
        handle: spendHandle,
        kind,
        merchantOrigin: "https://merchant.example",
        status: "pending_approval",
        updatedAt: "2026-08-28T00:00:00.000Z",
      });

      const result = await requestLinkSpend.execute(
        { browserSessionId: "browser-1", quote },
        context() as never
      );

      expect(mocks.createSpend).toHaveBeenCalledWith(
        scope,
        expect.objectContaining({
          kind,
          lineItems: [
            expect.objectContaining({
              description: "Color: Blue",
              name: "Cotton shirt",
              quantity: 1,
            }),
          ],
          ...(kind === "link_pay_token" ? { merchantAccountId } : {}),
        })
      );
      expect(mocks.revalidateQuote).toHaveBeenCalledWith(
        expect.objectContaining({
          itemNames: ["Cotton shirt", "Blue", "Standard"],
        })
      );
      expect(result).toMatchObject({
        approvalUrl: "https://link.com/approve/test",
        handle: spendHandle,
        route,
        status: "pending_approval",
      });
      expect(JSON.stringify(result)).not.toContain("lpt_secret_value");
      expect(JSON.stringify(result)).not.toMatch(/"(?:card|cvc|number)"/iu);
    }
  );

  it("keeps a bounded pending approval secret-free and does not submit", async () => {
    mocks.inspectSurface.mockResolvedValue({
      merchantAccountId: accountId,
      origin: "https://merchant.example",
      route: "link_pay_token",
    });
    mocks.pollSpend
      .mockRejectedValueOnce(missingMerchantBinding)
      .mockResolvedValueOnce({
        amount: 2_599,
        currency: "usd",
        handle: spendHandle,
        kind: "link_pay_token",
        merchantOrigin: "https://merchant.example",
        status: "pending_approval",
        updatedAt: "2026-08-28T00:00:00.000Z",
      });
    const termsFingerprint = linkCheckoutTermsFingerprint(quote, accountId);

    const result = await completeLinkPayment.execute(
      submitInput(termsFingerprint),
      context() as never
    );

    expect(result).toMatchObject({
      approvalStatus: "pending_approval",
      needsNewRequest: false,
      state: "awaiting_approval",
      success: false,
    });
    expect(mocks.withCredential).not.toHaveBeenCalled();
    expect(mocks.beginSubmission).not.toHaveBeenCalled();
    expect(mocks.submitAndVerify).not.toHaveBeenCalled();
  });

  it("injects an approved LPT internally, reserves, and submits exactly once", async () => {
    mocks.inspectSurface.mockResolvedValue({
      merchantAccountId: accountId,
      origin: "https://merchant.example",
      route: "link_pay_token",
    });
    mocks.pollSpend
      .mockRejectedValueOnce(missingMerchantBinding)
      .mockResolvedValueOnce({
        amount: 2_599,
        currency: "usd",
        handle: spendHandle,
        kind: "link_pay_token",
        merchantOrigin: "https://merchant.example",
        status: "approved",
        updatedAt: "2026-08-28T00:00:00.000Z",
      });
    mocks.withCredential.mockImplementation(async (_scope, _assertion, use) =>
      use({ kind: "link_pay_token", token: "lpt_secret_value" })
    );
    mocks.injectToken.mockResolvedValue({
      origin: "https://merchant.example",
      savedPaymentState: true,
    });
    mocks.beginSubmission.mockResolvedValue({
      startedAt: "2026-08-28T00:00:00.000Z",
      state: "started",
    });
    mocks.submitAndVerify.mockImplementation(async ({ onSubmitted }) => {
      await onSubmitted();
      return {
        confirmed: true,
        orderIdentifier: "ORDER-12345",
        origin: "https://merchant.example",
      };
    });
    const termsFingerprint = linkCheckoutTermsFingerprint(quote, accountId);

    const result = await completeLinkPayment.execute(
      submitInput(termsFingerprint),
      context() as never
    );

    expect(mocks.injectToken).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ token: "lpt_secret_value" })
    );
    expect(mocks.beginSubmission).toHaveBeenCalledOnce();
    expect(mocks.submitAndVerify).toHaveBeenCalledOnce();
    expect(mocks.revalidateQuote).toHaveBeenCalledTimes(2);
    expect(mocks.revalidateQuote.mock.invocationCallOrder[1]).toBeLessThan(
      mocks.beginSubmission.mock.invocationCallOrder[0] ?? Infinity
    );
    expect(result).toMatchObject({
      orderIdentifier: "ORDER-12345",
      state: "confirmed",
      success: true,
    });
    expect(JSON.stringify(result)).not.toContain("lpt_secret_value");
  });

  it("keeps a virtual card internal and targets billing without touching shipping", async () => {
    mocks.inspectSurface.mockResolvedValue({
      merchantAccountId: null,
      origin: "https://merchant.example",
      route: "virtual_card",
    });
    mocks.pollSpend.mockResolvedValueOnce({
      amount: 2_599,
      currency: "usd",
      handle: spendHandle,
      kind: "card",
      merchantOrigin: "https://merchant.example",
      status: "approved",
      updatedAt: "2026-08-28T00:00:00.000Z",
    });
    mocks.withCredential.mockImplementation(async (_scope, _assertion, use) =>
      use({ filePath: "/tmp/link-card.json", kind: "card" })
    );
    mocks.readCredentialFile.mockResolvedValue(
      JSON.stringify({
        card: {
          billing_address: {
            city: "Private City",
            country: "US",
            line1: "1 Private Street",
            name: "Private Person",
            postal_code: "10001",
            state: "NY",
          },
          cvc: "123",
          exp_month: 12,
          exp_year: 2030,
          number: "4242424242424242",
        },
        spend_request_id: "lsr_test",
      })
    );
    mocks.beginSubmission.mockResolvedValue({
      startedAt: "2026-08-28T00:00:00.000Z",
      state: "started",
    });
    mocks.submitAndVerify.mockImplementation(async ({ onSubmitted }) => {
      await onSubmitted();
      return {
        confirmed: true,
        orderIdentifier: "ORDER-54321",
        origin: "https://merchant.example",
      };
    });
    const termsFingerprint = linkCheckoutTermsFingerprint(quote);

    const result = await completeLinkPayment.execute(
      {
        ...submitInput(termsFingerprint),
        route: "virtual_card",
      },
      context() as never
    );

    expect(mocks.fillAutofill).toHaveBeenCalledWith(
      expect.objectContaining({
        addressPurpose: "billing",
        kind: "address",
      })
    );
    expect(mocks.fillAutofill).toHaveBeenCalledWith(
      expect.objectContaining({
        claims: expect.arrayContaining([
          expect.objectContaining({ token: "cc-number" }),
          expect.objectContaining({ token: "cc-csc" }),
        ]),
        kind: "payment",
      })
    );
    expect(JSON.stringify(result)).not.toContain("4242424242424242");
    expect(JSON.stringify(result)).not.toContain("Private");
    expect(result).toMatchObject({ state: "confirmed", success: true });
  });

  it("does not reserve or click when autofill changes the final checkout", async () => {
    mocks.inspectSurface.mockResolvedValue({
      merchantAccountId: accountId,
      origin: "https://merchant.example",
      route: "link_pay_token",
    });
    mocks.pollSpend
      .mockRejectedValueOnce(missingMerchantBinding)
      .mockResolvedValueOnce({
        amount: 2_599,
        currency: "usd",
        handle: spendHandle,
        kind: "link_pay_token",
        merchantOrigin: "https://merchant.example",
        status: "approved",
        updatedAt: "2026-08-28T00:00:00.000Z",
      });
    mocks.withCredential.mockImplementation(async (_scope, _assertion, use) =>
      use({ kind: "link_pay_token", token: "lpt_secret_value" })
    );
    mocks.injectToken.mockResolvedValue({
      origin: "https://merchant.example",
      savedPaymentState: true,
    });
    mocks.revalidateQuote
      .mockResolvedValueOnce({ origin: "https://merchant.example" })
      .mockRejectedValueOnce(new Error("The final amount increased."));
    const termsFingerprint = linkCheckoutTermsFingerprint(quote, accountId);

    const result = await completeLinkPayment.execute(
      submitInput(termsFingerprint),
      context() as never
    );

    expect(result).toMatchObject({
      needsNewRequest: true,
      state: "needs_new_request",
      success: false,
    });
    expect(mocks.beginSubmission).not.toHaveBeenCalled();
    expect(mocks.submitAndVerify).not.toHaveBeenCalled();
    expect(mocks.cancelSpend).toHaveBeenCalledOnce();
  });

  it("leaves a clicked but unconfirmed order guarded for human resolution", async () => {
    mocks.inspectSurface.mockResolvedValue({
      merchantAccountId: accountId,
      origin: "https://merchant.example",
      route: "link_pay_token",
    });
    mocks.pollSpend
      .mockRejectedValueOnce(missingMerchantBinding)
      .mockResolvedValueOnce({
        amount: 2_599,
        currency: "usd",
        handle: spendHandle,
        kind: "link_pay_token",
        merchantOrigin: "https://merchant.example",
        status: "approved",
        updatedAt: "2026-08-28T00:00:00.000Z",
      });
    mocks.withCredential.mockImplementation(async (_scope, _assertion, use) =>
      use({ kind: "link_pay_token", token: "lpt_secret_value" })
    );
    mocks.injectToken.mockResolvedValue({
      origin: "https://merchant.example",
      savedPaymentState: true,
    });
    mocks.beginSubmission.mockResolvedValue({
      startedAt: "2026-08-28T00:00:00.000Z",
      state: "started",
    });
    mocks.submitAndVerify.mockImplementation(async ({ onSubmitted }) => {
      await onSubmitted();
      throw new Error("3DS challenge is still open.");
    });
    const termsFingerprint = linkCheckoutTermsFingerprint(quote, accountId);

    const result = await completeLinkPayment.execute(
      submitInput(termsFingerprint),
      context() as never
    );

    expect(result).toMatchObject({
      approvalStatus: "submission_started",
      needsNewRequest: false,
      state: "submission_unknown",
      success: false,
    });
    expect(mocks.submitAndVerify).toHaveBeenCalledOnce();
    expect(mocks.recordSubmission).toHaveBeenCalledWith(
      scope,
      expect.any(Object),
      { outcome: "submitted" }
    );
    expect(mocks.reportOutcome).not.toHaveBeenCalled();
  });

  it("never suggests a replacement request after a guarded ambiguous submit", async () => {
    mocks.inspectSurface.mockResolvedValue({
      merchantAccountId: accountId,
      origin: "https://merchant.example",
      route: "link_pay_token",
    });
    mocks.pollSpend
      .mockRejectedValueOnce(missingMerchantBinding)
      .mockResolvedValueOnce({
        amount: 2_599,
        currency: "usd",
        handle: spendHandle,
        kind: "link_pay_token",
        merchantOrigin: "https://merchant.example",
        status: "approved",
        updatedAt: "2026-08-28T00:00:00.000Z",
      });
    mocks.withCredential.mockImplementation(async (_scope, _assertion, use) =>
      use({ kind: "link_pay_token", token: "lpt_secret_value" })
    );
    mocks.injectToken.mockResolvedValue({
      origin: "https://merchant.example",
      savedPaymentState: true,
    });
    mocks.beginSubmission.mockResolvedValue({
      startedAt: "2026-08-28T00:00:00.000Z",
      state: "already_started",
    });
    mocks.inspectConfirmation.mockResolvedValue({
      confirmed: false,
      orderIdentifier: null,
      origin: "https://merchant.example",
    });
    const termsFingerprint = linkCheckoutTermsFingerprint(quote, accountId);

    const result = await completeLinkPayment.execute(
      submitInput(termsFingerprint),
      context() as never
    );

    expect(result).toMatchObject({
      needsNewRequest: false,
      state: "submission_unknown",
      success: false,
    });
    expect(mocks.submitAndVerify).not.toHaveBeenCalled();
  });

  it("recognizes a prior guarded submission before the Stripe surface disappears", async () => {
    mocks.pollSpend.mockResolvedValueOnce({
      amount: 2_599,
      currency: "usd",
      handle: spendHandle,
      kind: "link_pay_token",
      merchantOrigin: "https://merchant.example",
      status: "submission_started",
      updatedAt: "2026-08-28T00:00:00.000Z",
    });
    mocks.inspectConfirmation.mockResolvedValue({
      confirmed: false,
      orderIdentifier: null,
      origin: "https://merchant.example",
    });
    const termsFingerprint = linkCheckoutTermsFingerprint(quote, accountId);

    const result = await completeLinkPayment.execute(
      submitInput(termsFingerprint),
      context() as never
    );

    expect(result).toMatchObject({
      approvalStatus: "submission_started",
      needsNewRequest: false,
      state: "submission_unknown",
      success: false,
    });
    expect(mocks.inspectSurface).not.toHaveBeenCalled();
    expect(mocks.withCredential).not.toHaveBeenCalled();
    expect(mocks.submitAndVerify).not.toHaveBeenCalled();
  });

  it("recognizes a prior virtual-card submission after its card surface disappears", async () => {
    mocks.pollSpend.mockResolvedValueOnce({
      amount: 2_599,
      currency: "usd",
      handle: spendHandle,
      kind: "card",
      merchantOrigin: "https://merchant.example",
      status: "submission_started",
      updatedAt: "2026-08-28T00:00:00.000Z",
    });
    mocks.inspectConfirmation.mockResolvedValue({
      confirmed: false,
      orderIdentifier: null,
      origin: "https://merchant.example",
    });
    const termsFingerprint = linkCheckoutTermsFingerprint(quote);

    const result = await completeLinkPayment.execute(
      {
        ...submitInput(termsFingerprint),
        route: "virtual_card",
      },
      context() as never
    );

    expect(result).toMatchObject({
      approvalStatus: "submission_started",
      needsNewRequest: false,
      state: "submission_unknown",
      success: false,
    });
    expect(mocks.inspectSurface).not.toHaveBeenCalled();
    expect(mocks.withCredential).not.toHaveBeenCalled();
    expect(mocks.beginSubmission).not.toHaveBeenCalled();
    expect(mocks.submitAndVerify).not.toHaveBeenCalled();
  });

  it("refuses to report purchase success without real order confirmation", async () => {
    mocks.inspectConfirmation.mockResolvedValue({
      confirmed: false,
      orderIdentifier: null,
      origin: "https://merchant.example",
    });
    const termsFingerprint = linkCheckoutTermsFingerprint(quote, accountId);

    await expect(
      completeLinkPayment.execute(
        {
          action: "report",
          browserSessionId: "browser-1",
          merchantOrigin: "https://merchant.example",
          outcome: "success",
          quote,
          route: "link_pay_token",
          spendHandle,
          termsFingerprint,
        },
        context() as never
      )
    ).rejects.toThrow("actual order-confirmation page or order identifier");

    expect(mocks.recordSubmission).not.toHaveBeenCalled();
    expect(mocks.reportOutcome).not.toHaveBeenCalled();
  });
});

function context() {
  return {
    abortSignal: new AbortController().signal,
    callId: "call-link-1",
    session: {
      id: "worker-session",
      parent: { rootSessionId: "root-session" },
    },
  };
}

function submitInput(termsFingerprint: string) {
  return {
    action: "submit" as const,
    browserSessionId: "browser-1",
    merchantOrigin: "https://merchant.example",
    quote,
    route: "link_pay_token" as const,
    spendHandle,
    submitLabel: "Pay $25.99",
    termsFingerprint,
  };
}
