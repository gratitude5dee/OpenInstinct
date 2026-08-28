import { readFile } from "node:fs/promises";
import { defineTool } from "eve/tools";
import { z } from "zod";
import { requireWorkerScope } from "@/agent/subagents/worker/lib/access";
import {
  linkCardCredentialFileSchema,
  linkCheckoutQuoteSchema,
  linkCheckoutTermsFingerprint,
  linkCheckoutVisibleTerms,
  type LinkCheckoutAssertion,
  type LinkSpendCredentialLease,
} from "@/lib/link-wallet";
import { requireOwnedBrowserSession } from "@/agent/subagents/worker/lib/owned-browser";
import {
  beginLinkSpendSubmission,
  cancelLinkSpendRequest,
  LinkCheckoutBindingError,
  pollLinkSpendRequest,
  recordLinkSpendSubmission,
  reportLinkSpendRequestOutcome,
  withLinkSpendCredential,
} from "@/lib/link-wallet/server";
import {
  currentKernelPageOrigin,
  fillWithKernelNativeAutofill,
  injectLinkPayTokenWithKernel,
  inspectKernelOrderConfirmation,
  inspectLinkCheckoutSurface,
  revalidateKernelCheckoutQuote,
  submitKernelCheckoutAndVerify,
  verifyKernelCheckoutSubmitControl,
} from "@/lib/manager/server/kernel-native-autofill";
import type { AutofillClaim } from "@/lib/manager/vault-autofill-protocol";

const approvalStatusSchema = z.enum([
  "creating",
  "created",
  "pending_approval",
  "approved",
  "requires_action",
  "submission_started",
  "denied",
  "expired",
  "canceled",
  "succeeded",
  "failed",
]);

const nextActionSchema = z.object({
  actionUrl: z.url().optional(),
  displayMessage: z.string().trim().min(1).max(500),
  resolution: z.enum(["auto_resume", "new_spend_request"]),
  type: z.string().trim().min(1).max(100),
});

const reportTagSchema = z.enum([
  "stripe_checkout",
  "captcha",
  "anti_bot_script",
  "cdn_block",
  "waf_block",
  "dns_block",
  "rate_limited",
  "login_required",
  "3ds_challenge",
  "page_inaccessible",
  "timeout",
  "site_error",
  "payment_declined",
  "other",
]);

const commonInput = {
  browserSessionId: z.string().trim().min(1).max(256),
  merchantOrigin: z.url().transform((value) => new URL(value).origin),
  quote: linkCheckoutQuoteSchema,
  route: z.enum(["link_pay_token", "virtual_card"]),
  spendHandle: z.uuid(),
  termsFingerprint: z.string().regex(/^[a-f\d]{64}$/u),
};

const inputSchema = z.discriminatedUnion("action", [
  z
    .object({
      ...commonInput,
      action: z.literal("submit"),
      submitLabel: z.string().trim().min(1).max(160),
    })
    .strict(),
  z
    .object({
      ...commonInput,
      action: z.literal("report"),
      freeformContext: z.string().trim().min(1).max(500).optional(),
      outcome: z.enum(["success", "blocked", "abandoned"]),
      step: z.string().trim().min(1).max(500).optional(),
      tags: z.array(reportTagSchema).max(14).optional(),
    })
    .strict(),
]);

const outputSchema = z.object({
  approvalStatus: approvalStatusSchema.optional(),
  handle: z.uuid(),
  needsNewRequest: z.boolean(),
  nextAction: nextActionSchema.optional(),
  orderIdentifier: z.string().trim().min(1).max(200).nullable().optional(),
  state: z.enum([
    "awaiting_approval",
    "confirmed",
    "human_action",
    "needs_new_request",
    "reported",
    "submission_unknown",
    "terminal",
  ]),
  success: z.boolean(),
});

export default defineTool({
  description:
    "Continue an existing Link-approved checkout on the same owned browser. The submit action polls briefly, revalidates the bound origin and same-or-lower quote, injects the credential internally, reserves one final submission, clicks the uniquely labeled control once, and requires order confirmation. The report action records a safe terminal outcome without retrieving credentials or clicking.",
  inputSchema,
  outputSchema,
  async execute(input, context) {
    const scope = await requireWorkerScope(context);
    await requireOwnedBrowserSession(scope, input.browserSessionId);
    const parent = context.session.parent;
    if (!parent) throw new Error("Link checkout requires a delegated worker.");

    let assertion: LinkCheckoutAssertion | undefined;
    try {
      if (input.action === "report") {
        assertion = {
          browserSessionId: input.browserSessionId,
          currency: input.quote.currency,
          currentAmount: input.quote.amount,
          handle: input.spendHandle,
          merchantOrigin: input.merchantOrigin,
          rootSessionId: parent.rootSessionId,
          termsFingerprint: input.termsFingerprint,
          workerSessionId: context.session.id,
        };
        if (input.outcome === "success") {
          const confirmation = await inspectKernelOrderConfirmation({
            browserSessionId: input.browserSessionId,
            signal: context.abortSignal,
          });
          if (!confirmation.confirmed) {
            throw new Error(
              "A successful Link outcome requires an actual order-confirmation page or order identifier."
            );
          }
          await recordLinkSpendSubmission(scope, assertion, {
            outcome: "confirmed",
          });
        } else {
          await recordLinkSpendSubmission(scope, assertion, {
            outcome: "blocked",
          });
        }
        await reportLinkSpendRequestOutcome(scope, {
          assertion,
          freeformContext: input.freeformContext,
          outcome: input.outcome,
          step: input.step,
          tags: input.tags ?? [],
        });
        return outputSchema.parse({
          handle: input.spendHandle,
          needsNewRequest: false,
          state: "reported",
          success: true,
        });
      }

      const preSurfaceSpend = await pollLinkSpendBeforeSurface(scope, {
        browserSessionId: input.browserSessionId,
        currency: input.quote.currency,
        currentAmount: input.quote.amount,
        handle: input.spendHandle,
        merchantOrigin: input.merchantOrigin,
        rootSessionId: parent.rootSessionId,
        termsFingerprint: input.termsFingerprint,
        workerSessionId: context.session.id,
      });
      if (
        preSurfaceSpend?.status === "submission_started" ||
        preSurfaceSpend?.status === "succeeded"
      ) {
        const confirmation = await inspectKernelOrderConfirmation({
          browserSessionId: input.browserSessionId,
          signal: context.abortSignal,
        });
        return outputSchema.parse({
          approvalStatus: preSurfaceSpend.status,
          handle: preSurfaceSpend.handle,
          needsNewRequest: false,
          orderIdentifier: confirmation.orderIdentifier,
          state: confirmation.confirmed ? "confirmed" : "submission_unknown",
          success: confirmation.confirmed,
        });
      }

      const { surface, termsFingerprint } = await revalidateApprovedCheckout(
        input,
        context.abortSignal
      );
      assertion = {
        browserSessionId: input.browserSessionId,
        currency: input.quote.currency,
        currentAmount: input.quote.amount,
        handle: input.spendHandle,
        merchantAccountId:
          input.route === "link_pay_token"
            ? requiredMerchantAccountId(surface.merchantAccountId)
            : undefined,
        merchantOrigin: input.merchantOrigin,
        rootSessionId: parent.rootSessionId,
        termsFingerprint,
        workerSessionId: context.session.id,
      };

      const spend =
        preSurfaceSpend ?? (await pollLinkSpendRequest(scope, assertion));
      if (
        spend.status === "creating" ||
        spend.status === "created" ||
        spend.status === "pending_approval"
      ) {
        return outputSchema.parse({
          approvalStatus: spend.status,
          handle: spend.handle,
          needsNewRequest: false,
          state: "awaiting_approval",
          success: false,
        });
      }
      if (spend.status === "requires_action") {
        const needsNewRequest = spend.nextAction?.resolution !== "auto_resume";
        return outputSchema.parse({
          approvalStatus: spend.status,
          handle: spend.handle,
          needsNewRequest,
          nextAction: spend.nextAction,
          state: needsNewRequest ? "needs_new_request" : "human_action",
          success: false,
        });
      }
      if (
        spend.status === "succeeded" ||
        spend.status === "submission_started"
      ) {
        const confirmation = await inspectKernelOrderConfirmation({
          browserSessionId: input.browserSessionId,
          signal: context.abortSignal,
        });
        return outputSchema.parse({
          approvalStatus: spend.status,
          handle: spend.handle,
          needsNewRequest: false,
          orderIdentifier: confirmation.orderIdentifier,
          state: confirmation.confirmed ? "confirmed" : "submission_unknown",
          success: confirmation.confirmed,
        });
      }
      if (spend.status !== "approved") {
        return outputSchema.parse({
          approvalStatus: spend.status,
          handle: spend.handle,
          needsNewRequest: true,
          state: "terminal",
          success: false,
        });
      }
      if (
        (spend.kind === "link_pay_token") !==
        (input.route === "link_pay_token")
      ) {
        throw new Error(
          "The approved Link credential route does not match the current checkout."
        );
      }

      await verifyKernelCheckoutSubmitControl({
        browserSessionId: input.browserSessionId,
        currency: input.quote.currency,
        currentAmount: input.quote.amount,
        expectedOrigin: input.merchantOrigin,
        signal: context.abortSignal,
        submitLabel: input.submitLabel,
      });
      if (spend.kind === "link_pay_token") {
        await injectApprovedLinkPayToken(
          scope,
          assertion,
          input.browserSessionId,
          input.merchantOrigin,
          requiredMerchantAccountId(surface.merchantAccountId),
          context.abortSignal
        );
      } else {
        await injectApprovedVirtualCard(
          scope,
          assertion,
          input.browserSessionId,
          input.merchantOrigin,
          context.abortSignal
        );
      }

      await revalidatePostInjectionQuote(input, context.abortSignal);

      const reservation = await beginLinkSpendSubmission(scope, assertion);
      if (reservation.state === "already_started") {
        const confirmation = await inspectKernelOrderConfirmation({
          browserSessionId: input.browserSessionId,
          signal: context.abortSignal,
        });
        return outputSchema.parse({
          approvalStatus: spend.status,
          handle: spend.handle,
          needsNewRequest: false,
          orderIdentifier: confirmation.orderIdentifier,
          state: confirmation.confirmed ? "confirmed" : "submission_unknown",
          success: confirmation.confirmed,
        });
      }

      const submissionAssertion = assertion;
      try {
        const confirmation = await submitKernelCheckoutAndVerify({
          browserSessionId: input.browserSessionId,
          currency: input.quote.currency,
          currentAmount: input.quote.amount,
          expectedOrigin: input.merchantOrigin,
          onSubmitted: () =>
            recordLinkSpendSubmission(scope, submissionAssertion, {
              outcome: "submitted",
            }).then(() => undefined),
          signal: context.abortSignal,
          submitLabel: input.submitLabel,
        });
        await recordLinkSpendSubmission(scope, assertion, {
          outcome: "confirmed",
        });
        await reportLinkSpendRequestOutcome(scope, {
          assertion,
          outcome: "success",
          tags: input.route === "link_pay_token" ? ["stripe_checkout"] : [],
        }).catch(() => undefined);
        return outputSchema.parse({
          approvalStatus: "succeeded",
          handle: spend.handle,
          needsNewRequest: false,
          orderIdentifier: confirmation.orderIdentifier,
          state: "confirmed",
          success: true,
        });
      } catch {
        // The guarded click may already have reached the merchant even when
        // confirmation, 3DS, or a network transition is still unresolved.
        // Leave the durable state as submission_started and never click or
        // create another spend request automatically. A later report action
        // records the verified human-resolved outcome.
        return outputSchema.parse({
          approvalStatus: "submission_started",
          handle: spend.handle,
          needsNewRequest: false,
          state: "submission_unknown",
          success: false,
        });
      }
    } catch (error) {
      if (error instanceof LinkCheckoutChangedError) {
        if (assertion) {
          await cancelLinkSpendRequest(scope, assertion).catch(() => undefined);
        }
        return outputSchema.parse({
          handle: input.spendHandle,
          needsNewRequest: true,
          state: "needs_new_request",
          success: false,
        });
      }
      if (context.abortSignal.aborted && assertion) {
        await cancelLinkSpendRequest(scope, assertion).catch(() => undefined);
      }
      throw error;
    }
  },
});

async function injectApprovedLinkPayToken(
  scope: Awaited<ReturnType<typeof requireWorkerScope>>,
  assertion: LinkCheckoutAssertion,
  browserSessionId: string,
  expectedOrigin: string,
  expectedMerchantAccountId: string,
  signal?: AbortSignal
) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const savedPaymentStates = new Set<boolean>();
    await withLinkSpendCredential(
      scope,
      assertion,
      async (lease: LinkSpendCredentialLease) => {
        if (lease.kind !== "link_pay_token") {
          throw new Error("Link returned an unexpected credential route.");
        }
        const result = await injectLinkPayTokenWithKernel({
          browserSessionId,
          expectedMerchantAccountId,
          expectedOrigin,
          signal,
          token: lease.token,
        });
        savedPaymentStates.add(result.savedPaymentState);
      }
    );
    if (savedPaymentStates.has(true)) return;
  }
  throw new Error(
    "The Stripe checkout did not enter the saved-payment state after one fresh Link Pay Token retry."
  );
}

async function injectApprovedVirtualCard(
  scope: Awaited<ReturnType<typeof requireWorkerScope>>,
  assertion: LinkCheckoutAssertion,
  browserSessionId: string,
  expectedOrigin: string,
  signal?: AbortSignal
) {
  await withLinkSpendCredential(
    scope,
    assertion,
    async (lease: LinkSpendCredentialLease) => {
      if (lease.kind !== "card") {
        throw new Error("Link returned an unexpected credential route.");
      }
      let credential: z.infer<typeof linkCardCredentialFileSchema>;
      try {
        credential = linkCardCredentialFileSchema.parse(
          JSON.parse(await readFile(lease.filePath, "utf8"))
        );
      } catch {
        throw new Error(
          "Link returned an invalid virtual-card credential file."
        );
      }
      const billing = credential.card.billing_address;
      if (billing) {
        const addressClaims = [
          claim("name", stringField(billing, "name")),
          claim(
            "street-address",
            [stringField(billing, "line1"), stringField(billing, "line2")]
              .filter(Boolean)
              .join("\n")
          ),
          claim("address-line1", stringField(billing, "line1")),
          claim("address-line2", stringField(billing, "line2")),
          claim("address-level2", stringField(billing, "city")),
          claim("address-level1", stringField(billing, "state")),
          claim("postal-code", stringField(billing, "postal_code")),
          claim("country", stringField(billing, "country")),
          claim("tel", stringField(billing, "phone")),
        ].filter(isAutofillClaim);
        if (addressClaims.length > 0) {
          await fillWithKernelNativeAutofill({
            addressPurpose: "billing",
            browserSessionId,
            claims: addressClaims,
            expectedOrigin,
            kind: "address",
            signal,
          }).catch(() => {
            signal?.throwIfAborted();
            // Billing data is optional when there is no explicitly tagged
            // billing section. Never fall back to shipping or an ambiguous
            // address form.
          });
        }
      }
      const cardholderName = billing ? stringField(billing, "name") : undefined;
      if (!cardholderName) {
        throw new Error(
          "The Link virtual card is missing a cardholder name required by native autofill."
        );
      }
      await fillWithKernelNativeAutofill({
        browserSessionId,
        claims: [
          requiredClaim("cc-name", cardholderName),
          requiredClaim("cc-number", credential.card.number),
          requiredClaim("cc-exp-month", String(credential.card.exp_month)),
          requiredClaim("cc-exp-year", String(credential.card.exp_year)),
          requiredClaim("cc-csc", credential.card.cvc),
        ],
        expectedOrigin,
        kind: "payment",
        signal,
      });
    }
  );
}

class LinkCheckoutChangedError extends Error {}

async function pollLinkSpendBeforeSurface(
  scope: Awaited<ReturnType<typeof requireWorkerScope>>,
  assertion: LinkCheckoutAssertion
) {
  try {
    return await pollLinkSpendRequest(scope, assertion);
  } catch (error) {
    if (error instanceof LinkCheckoutBindingError) {
      return undefined;
    }
    throw error;
  }
}

async function revalidateApprovedCheckout(
  input: Extract<z.infer<typeof inputSchema>, { action: "submit" }>,
  signal?: AbortSignal
) {
  try {
    const currentOrigin = await currentKernelPageOrigin({
      browserSessionId: input.browserSessionId,
      signal,
    });
    if (currentOrigin !== input.merchantOrigin) {
      throw new Error("The active browser origin changed.");
    }
    await revalidateKernelCheckoutQuote({
      browserSessionId: input.browserSessionId,
      currency: input.quote.currency,
      currentAmount: input.quote.amount,
      expectedOrigin: input.merchantOrigin,
      itemNames: linkCheckoutVisibleTerms(input.quote),
      signal,
    });
    const surface = await inspectLinkCheckoutSurface({
      browserSessionId: input.browserSessionId,
      expectedOrigin: input.merchantOrigin,
      signal,
    });
    if (surface.route !== input.route) {
      throw new Error("The checkout payment route changed.");
    }
    const termsFingerprint = linkCheckoutTermsFingerprint(
      input.quote,
      surface.merchantAccountId ?? undefined
    );
    if (termsFingerprint !== input.termsFingerprint) {
      throw new Error("The merchant, order, options, or fulfillment changed.");
    }
    return { surface, termsFingerprint };
  } catch (error) {
    throw new LinkCheckoutChangedError(
      "The approved checkout could not be revalidated and requires a new Link approval.",
      { cause: error }
    );
  }
}

async function revalidatePostInjectionQuote(
  input: Extract<z.infer<typeof inputSchema>, { action: "submit" }>,
  signal?: AbortSignal
) {
  try {
    const currentOrigin = await currentKernelPageOrigin({
      browserSessionId: input.browserSessionId,
      signal,
    });
    if (currentOrigin !== input.merchantOrigin) {
      throw new Error("The active browser origin changed after autofill.");
    }
    await revalidateKernelCheckoutQuote({
      browserSessionId: input.browserSessionId,
      currency: input.quote.currency,
      currentAmount: input.quote.amount,
      expectedOrigin: input.merchantOrigin,
      itemNames: linkCheckoutVisibleTerms(input.quote),
      signal,
    });
  } catch (error) {
    throw new LinkCheckoutChangedError(
      "The checkout total or cart changed after credential injection and requires a new Link approval.",
      { cause: error }
    );
  }
}

function claim(token: string, value: string | undefined) {
  return value ? requiredClaim(token, value) : null;
}

function requiredClaim(token: string, value: string): AutofillClaim {
  return { id: crypto.randomUUID(), token, value };
}

function isAutofillClaim(value: AutofillClaim | null): value is AutofillClaim {
  return value !== null;
}

function stringField(record: Record<string, unknown>, key: string) {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function requiredMerchantAccountId(value: string | null) {
  if (!value)
    throw new Error("The approved Stripe merchant binding is missing.");
  return value;
}
