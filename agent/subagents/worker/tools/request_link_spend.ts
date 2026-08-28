import { defineTool } from "eve/tools";
import { z } from "zod";
import { requireWorkerScope } from "@/agent/subagents/worker/lib/access";
import {
  linkCheckoutItemDescription,
  linkCheckoutQuoteSchema,
  linkCheckoutTermsFingerprint,
  linkCheckoutVisibleTerms,
  linkSpendIdempotencyKey,
} from "@/lib/link-wallet";
import { requireOwnedBrowserSession } from "@/agent/subagents/worker/lib/owned-browser";
import { createOrReuseLinkSpendRequest } from "@/lib/link-wallet/server";
import {
  currentKernelPageOrigin,
  inspectLinkCheckoutSurface,
  revalidateKernelCheckoutQuote,
} from "@/lib/manager/server/kernel-native-autofill";

const approvalStatusSchema = z.enum([
  "creating",
  "created",
  "pending_approval",
  "approved",
  "requires_action",
  "submission_started",
  "denied",
  "canceled",
  "expired",
  "failed",
  "succeeded",
]);

const nextActionSchema = z.object({
  actionUrl: z.url().optional(),
  displayMessage: z.string().trim().min(1).max(500),
  resolution: z.enum(["auto_resume", "new_spend_request"]),
  type: z.string().trim().min(1).max(100),
});

const outputSchema = z.object({
  approvalUrl: z.url().optional(),
  handle: z.uuid(),
  merchantOrigin: z.url(),
  needsNewRequest: z.boolean(),
  nextAction: nextActionSchema.optional(),
  route: z.enum(["link_pay_token", "virtual_card"]),
  status: approvalStatusSchema,
  termsFingerprint: z.string().regex(/^[a-f\d]{64}$/u),
});

export default defineTool({
  description:
    "Inspect the owned checkout, select a verified Link Pay Token route or ordinary-card fallback, and idempotently request Link approval for the final quote. Returns only an opaque handle, safe state, and approval/action URL. Link approval is the purchase confirmation; preserve this browser while approval is pending.",
  inputSchema: z
    .object({
      browserSessionId: z.string().trim().min(1).max(500),
      quote: linkCheckoutQuoteSchema,
    })
    .strict(),
  outputSchema,
  async execute({ browserSessionId, quote }, context) {
    const scope = await requireWorkerScope(context);
    await requireOwnedBrowserSession(scope, browserSessionId);
    assertFinalTotal(quote);

    const { origin } = await revalidateKernelCheckoutQuote({
      browserSessionId,
      currency: quote.currency,
      currentAmount: quote.amount,
      expectedOrigin: await currentOwnedOrigin(
        browserSessionId,
        context.abortSignal
      ),
      itemNames: linkCheckoutVisibleTerms(quote),
      signal: context.abortSignal,
    });
    const surface = await inspectLinkCheckoutSurface({
      browserSessionId,
      expectedOrigin: origin,
      signal: context.abortSignal,
    });
    const termsFingerprint = linkCheckoutTermsFingerprint(
      quote,
      surface.merchantAccountId ?? undefined
    );
    const parent = context.session.parent;
    if (!parent) throw new Error("Link checkout requires a delegated worker.");
    const ownership = {
      browserSessionId,
      merchantOrigin: origin,
      rootSessionId: parent.rootSessionId,
      termsFingerprint,
      workerSessionId: context.session.id,
    };
    const common = {
      ...ownership,
      amount: quote.amount,
      context: quote.context,
      currency: quote.currency,
      idempotencyKey: linkSpendIdempotencyKey({
        callId: context.callId,
        rootSessionId: ownership.rootSessionId,
        workerSessionId: ownership.workerSessionId,
        workspaceId: scope.workspaceId,
      }),
      lineItems: quote.items.map((item) => ({
        description: linkCheckoutItemDescription(item),
        imageUrl: item.imageUrl,
        name: item.name,
        productUrl: item.productUrl,
        quantity: item.quantity,
        sku: item.sku,
        unitAmount: item.unitAmount,
      })),
      totals: quote.totals ?? [
        { amount: quote.amount, displayText: "Total", type: "total" as const },
      ],
    };
    const result =
      surface.route === "link_pay_token"
        ? await createOrReuseLinkSpendRequest(scope, {
            ...common,
            kind: "link_pay_token",
            merchantAccountId: requiredMerchantAccountId(
              surface.merchantAccountId
            ),
          })
        : await createOrReuseLinkSpendRequest(scope, {
            ...common,
            kind: "card",
            merchantName: quote.merchantName,
          });
    const expectedKind =
      surface.route === "link_pay_token" ? "link_pay_token" : "card";
    if (result.kind !== expectedKind) {
      throw new Error(
        "The Link spend request route does not match the inspected checkout."
      );
    }
    const nextAction = result.nextAction ?? undefined;
    return outputSchema.parse({
      approvalUrl: result.approvalUrl ?? undefined,
      handle: result.handle,
      merchantOrigin: origin,
      needsNewRequest:
        nextAction !== undefined && nextAction.resolution !== "auto_resume",
      nextAction,
      route: surface.route,
      status: result.status,
      termsFingerprint,
    });
  },
});

async function currentOwnedOrigin(
  browserSessionId: string,
  signal?: AbortSignal
) {
  return currentKernelPageOrigin({ browserSessionId, signal });
}

function assertFinalTotal(quote: z.infer<typeof linkCheckoutQuoteSchema>) {
  const total = quote.totals?.find(({ type }) => type === "total");
  if (total && total.amount !== quote.amount) {
    throw new Error(
      "The Link spend amount must equal the checkout's final total."
    );
  }
}

function requiredMerchantAccountId(value: string | null) {
  if (!value) {
    throw new Error("The verified Stripe merchant account is unavailable.");
  }
  return value;
}
