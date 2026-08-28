import { z } from "zod";

const boundedText = (maximum: number) => z.string().trim().min(1).max(maximum);
const optionalBoundedText = (maximum: number) =>
  z.string().trim().min(1).max(maximum).optional();
const webUrl = z
  .string()
  .trim()
  .max(2_048)
  .refine(
    (value) => {
      if (!URL.canParse(value)) return false;
      return ["http:", "https:"].includes(new URL(value).protocol);
    },
    { message: "Expected an HTTP or HTTPS URL." }
  );
const merchantOrigin = webUrl
  .refine((value) => {
    const url = new URL(value);
    const local =
      url.hostname === "localhost" ||
      url.hostname === "127.0.0.1" ||
      url.hostname === "[::1]";
    return (
      !url.username &&
      !url.password &&
      (url.protocol === "https:" || (url.protocol === "http:" && local))
    );
  }, "Checkout origins must use HTTPS (except localhost development).")
  .transform((value) => new URL(value).origin);
const fingerprint = z
  .string()
  .trim()
  .regex(/^[a-f\d]{64}$/i, "Expected a SHA-256 fingerprint.")
  .transform((value) => value.toLowerCase());
const currency = z
  .string()
  .trim()
  .regex(/^[a-z]{3}$/i, "Expected a three-letter currency code.")
  .transform((value) => value.toLowerCase());
const linkAmount = z
  .number()
  .int()
  .positive()
  .max(
    50_000,
    "Link currently supports at most 50,000 minor units ($500 USD) per spend request."
  );
const sessionId = boundedText(256);

const linkLineItemSchema = z.object({
  description: optionalBoundedText(500),
  imageUrl: webUrl.optional(),
  name: boundedText(200),
  productUrl: webUrl.optional(),
  quantity: z.number().int().positive().max(100_000),
  sku: optionalBoundedText(200),
  unitAmount: z.number().int().nonnegative().max(50_000).optional(),
  url: webUrl.optional(),
});

const linkTotalSchema = z.object({
  amount: z.number().int().min(-50_000).max(50_000),
  displayText: boundedText(100),
  type: z.enum([
    "subtotal",
    "tax",
    "total",
    "items_base_amount",
    "items_discount",
    "discount",
    "fulfillment",
    "shipping",
    "fee",
    "gift_wrap",
    "tip",
    "store_credit",
  ]),
});

const commonSpendRequest = z.object({
  amount: linkAmount,
  browserSessionId: sessionId,
  context: boundedText(2_000).pipe(
    z
      .string()
      .min(
        100,
        "Explain the purchase and rationale in at least 100 characters for Link approval."
      )
  ),
  currency,
  idempotencyKey: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .regex(
      /^[a-zA-Z\d._:-]+$/,
      "Use only letters, numbers, periods, underscores, colons, and hyphens."
    ),
  lineItems: z.array(linkLineItemSchema).min(1).max(100),
  merchantOrigin,
  paymentMethodId: z
    .string()
    .trim()
    .regex(/^csmrpd_[a-zA-Z\d_]+$/, "Expected a Link payment method ID.")
    .optional(),
  rootSessionId: sessionId,
  termsFingerprint: fingerprint,
  totals: z.array(linkTotalSchema).min(1).max(30),
  workerSessionId: sessionId,
});

export const linkSpendRequestInputSchema = z
  .discriminatedUnion("kind", [
    commonSpendRequest.extend({
      kind: z.literal("card"),
      merchantName: boundedText(200),
      test: z.boolean().default(false),
    }),
    commonSpendRequest.extend({
      kind: z.literal("link_pay_token"),
      merchantAccountId: z
        .string()
        .trim()
        .regex(/^acct_[a-zA-Z\d]+$/, "Expected a Stripe merchant account ID."),
    }),
  ])
  .superRefine((request, context) => {
    const totals = request.totals.filter(({ type }) => type === "total");
    if (totals.length !== 1 || totals[0]?.amount !== request.amount) {
      context.addIssue({
        code: "custom",
        message: "Exactly one final total must match the spend amount.",
        path: ["totals"],
      });
    }
  });

export type LinkSpendRequestInput = z.input<typeof linkSpendRequestInputSchema>;

export const linkCheckoutAssertionSchema = z.object({
  browserSessionId: sessionId,
  currency,
  currentAmount: linkAmount,
  handle: z.uuid(),
  merchantAccountId: z
    .string()
    .trim()
    .regex(/^acct_[a-zA-Z\d]+$/)
    .optional(),
  merchantOrigin,
  rootSessionId: sessionId,
  termsFingerprint: fingerprint,
  workerSessionId: sessionId,
});

export type LinkCheckoutAssertion = z.infer<typeof linkCheckoutAssertionSchema>;

export type LinkWalletConnection =
  | { readonly state: "disconnected" }
  | {
      readonly phrase: string;
      readonly state: "pending";
      readonly verificationUrl: string;
    }
  | {
      readonly accountLabel?: string;
      readonly connectedAt?: string;
      readonly state: "connected";
    }
  | { readonly state: "reauthentication-required" }
  | { readonly reason: string; readonly state: "unavailable" };

export type LinkSpendRequestStatus =
  | "creating"
  | "created"
  | "pending_approval"
  | "approved"
  | "requires_action"
  | "submission_started"
  | "denied"
  | "expired"
  | "canceled"
  | "succeeded"
  | "failed";

export interface LinkSpendNextAction {
  readonly actionUrl?: string;
  readonly displayMessage: string;
  readonly resolution: "auto_resume" | "new_spend_request";
  readonly type: string;
}

export interface LinkSpendRequest {
  readonly amount: number;
  readonly approvalUrl?: string;
  readonly currency: string;
  readonly failureCode?: string;
  readonly handle: string;
  readonly kind: "card" | "link_pay_token";
  readonly merchantOrigin: string;
  readonly nextAction?: LinkSpendNextAction;
  readonly status: LinkSpendRequestStatus;
  readonly updatedAt: string;
}

export interface LinkAddress {
  readonly city: string | null;
  readonly country: string | null;
  readonly dependentLocality: string | null;
  readonly line1: string | null;
  readonly line2: string | null;
  readonly name: string | null;
  readonly phone: string | null;
  readonly postalCode: string | null;
  readonly sortingCode: string | null;
  readonly state: string | null;
}

export interface LinkPaymentMethod {
  readonly bankAccount: {
    readonly bankName: string | null;
    readonly last4: string | null;
  } | null;
  readonly billingAddress: LinkAddress | null;
  readonly card: {
    readonly brand: string | null;
    readonly expMonth: number | null;
    readonly expYear: number | null;
    readonly last4: string | null;
  } | null;
  readonly id: string;
  readonly isDefault: boolean;
  readonly nickname: string | null;
  readonly type: string;
}

interface LinkShippingAddress {
  readonly address: LinkAddress | null;
  readonly id: string;
  readonly isDefault: boolean;
  readonly nickname: string | null;
}

export interface LinkProfile {
  readonly contact: {
    readonly email: string | null;
    readonly name: string | null;
    readonly phone: string | null;
  };
  readonly defaultPaymentMethodId: string | null;
  readonly defaultShippingAddressId: string | null;
  readonly paymentMethods: readonly LinkPaymentMethod[];
  readonly shippingAddresses: readonly LinkShippingAddress[];
}

const looseAddressSchema = z.record(z.string(), z.unknown());

export const linkCardCredentialFileSchema = z.object({
  card: z.object({
    billing_address: looseAddressSchema.nullable().optional(),
    cvc: z.string().regex(/^\d{3,4}$/),
    exp_month: z.number().int().min(1).max(12),
    exp_year: z.number().int().min(2_000).max(3_000),
    number: z.string().regex(/^\d{12,19}$/),
    valid_until: z.union([z.string(), z.number()]).optional(),
  }),
  context: z.string().optional(),
  created_at: z.string().optional(),
  merchant_name: z.string().optional(),
  merchant_url: z.string().optional(),
  spend_request_id: z.string(),
});

export type LinkSpendCredentialLease =
  | { readonly filePath: string; readonly kind: "card" }
  | { readonly kind: "link_pay_token"; readonly token: string };

export type LinkSubmissionGuard =
  | { readonly startedAt: string; readonly state: "started" }
  | { readonly startedAt: string; readonly state: "already_started" };

export const linkSubmissionOutcomeSchema = z.object({
  outcome: z.enum(["submitted", "confirmed", "blocked"]),
});

export type LinkSubmissionOutcome = z.infer<typeof linkSubmissionOutcomeSchema>;

export const linkReportOutcomeSchema = z.object({
  assertion: linkCheckoutAssertionSchema,
  freeformContext: z.string().trim().min(1).max(500).optional(),
  outcome: z.enum(["success", "blocked", "abandoned"]),
  step: z.string().trim().min(1).max(500).optional(),
  tags: z
    .array(
      z.enum([
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
      ])
    )
    .max(14)
    .default([]),
});

export type LinkReportOutcomeInput = z.infer<typeof linkReportOutcomeSchema>;
