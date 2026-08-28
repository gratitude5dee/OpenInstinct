import { createHash } from "node:crypto";
import { z } from "zod";

const checkoutOptionSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    value: z.string().trim().min(1).max(200),
  })
  .strict();

export const linkCheckoutItemSchema = z
  .object({
    description: z.string().trim().min(1).max(500).optional(),
    imageUrl: z.url().optional(),
    name: z.string().trim().min(1).max(200),
    options: z.array(checkoutOptionSchema).max(20).optional(),
    productUrl: z.url().optional(),
    quantity: z.number().int().min(1).max(1_000),
    sku: z.string().trim().min(1).max(200).optional(),
    unitAmount: z.number().int().nonnegative().max(50_000).optional(),
  })
  .strict();

const linkCheckoutFulfillmentSchema = z
  .object({
    method: z.enum(["digital", "pickup", "shipping"]),
    option: z.string().trim().min(1).max(200).optional(),
  })
  .strict();

const linkCheckoutTotalSchema = z
  .object({
    amount: z.number().int().min(-50_000).max(50_000),
    displayText: z.string().trim().min(1).max(120),
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
  })
  .strict();

export const linkCheckoutQuoteSchema = z
  .object({
    amount: z.number().int().positive().max(50_000),
    context: z.string().trim().min(100).max(2_000),
    currency: z
      .string()
      .trim()
      .regex(/^[a-zA-Z]{3}$/u)
      .transform((value) => value.toLowerCase()),
    fulfillment: linkCheckoutFulfillmentSchema.optional(),
    items: z.array(linkCheckoutItemSchema).min(1).max(100),
    merchantName: z.string().trim().min(1).max(200),
    totals: z.array(linkCheckoutTotalSchema).max(20).optional(),
  })
  .strict();

export function linkCheckoutTermsFingerprint(
  quote: z.infer<typeof linkCheckoutQuoteSchema>,
  merchantAccountId?: string
) {
  const terms = {
    currency: quote.currency,
    fulfillment: quote.fulfillment
      ? {
          method: quote.fulfillment.method,
          option: quote.fulfillment.option ?? null,
        }
      : null,
    items: quote.items.map((item) => ({
      description: item.description ?? null,
      name: item.name,
      options: (item.options ?? [])
        .map(({ name, value }) => ({ name, value }))
        .toSorted((left, right) =>
          `${left.name}\0${left.value}`.localeCompare(
            `${right.name}\0${right.value}`
          )
        ),
      productUrl: item.productUrl ?? null,
      quantity: item.quantity,
      sku: item.sku ?? null,
    })),
    merchantAccountId: merchantAccountId ?? null,
    merchantName: quote.merchantName,
  };
  return createHash("sha256")
    .update(`openinstinct-link-terms\0${JSON.stringify(terms)}`)
    .digest("hex");
}

export function linkSpendIdempotencyKey(input: {
  readonly callId: string;
  readonly rootSessionId: string;
  readonly workerSessionId: string;
  readonly workspaceId: string;
}) {
  return createHash("sha256")
    .update(
      [
        "openinstinct-link-spend",
        input.workspaceId,
        input.rootSessionId,
        input.workerSessionId,
        input.callId,
      ].join("\0")
    )
    .digest("hex");
}

export function linkCheckoutVisibleTerms(
  quote: z.infer<typeof linkCheckoutQuoteSchema>
) {
  return [
    ...quote.items.flatMap((item) => [
      item.name,
      ...(item.options ?? []).map(({ value }) => value),
      ...(item.quantity > 1 ? [String(item.quantity)] : []),
    ]),
    ...(quote.fulfillment?.option ? [quote.fulfillment.option] : []),
  ];
}

export function linkCheckoutItemDescription(
  item: z.infer<typeof linkCheckoutItemSchema>
) {
  const options = (item.options ?? [])
    .map(({ name, value }) => `${name}: ${value}`)
    .join("; ");
  const description = [options, item.description].filter(Boolean).join(" — ");
  return description
    ? Array.from(description).slice(0, 500).join("")
    : undefined;
}
