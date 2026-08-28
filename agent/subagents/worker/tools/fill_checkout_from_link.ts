import { defineTool } from "eve/tools";
import { z } from "zod";
import { requireWorkerScope } from "@/agent/subagents/worker/lib/access";
import { requireOwnedBrowserSession } from "@/agent/subagents/worker/lib/owned-browser";
import { readLinkProfile } from "@/lib/link-wallet/server";
import type { LinkProfile } from "@/lib/link-wallet";
import {
  currentKernelPageOrigin,
  fillWithKernelNativeAutofill,
} from "@/lib/manager/server/kernel-native-autofill";
import type { AutofillClaim } from "@/lib/manager/vault-autofill-protocol";

const fieldCategorySchema = z.enum([
  "email",
  "full_name",
  "phone",
  "shipping_address",
]);

const outputSchema = z.object({
  filled: z.array(fieldCategorySchema),
  missing: z.array(fieldCategorySchema),
  success: z.literal(true),
});

const inputSchema = z
  .object({
    browserSessionId: z.string().trim().min(1).max(500),
    categories: z.array(fieldCategorySchema).min(1).max(4).optional(),
  })
  .strict();

export default defineTool({
  description:
    "Securely fill selected checkout contact categories or the default shipping address from the connected Link wallet. Focus the intended form first and use categories to avoid overwriting transaction-specific values. Returns only filled or missing field categories; profile values never enter model context. Call before reading tax, shipping, and the final total.",
  inputSchema,
  outputSchema,
  async execute({ browserSessionId, categories }, context) {
    const scope = await requireWorkerScope(context);
    await requireOwnedBrowserSession(scope, browserSessionId);
    const [origin, profile]: [string, LinkProfile] = await Promise.all([
      currentKernelPageOrigin({
        browserSessionId,
        signal: context.abortSignal,
      }),
      readLinkProfile(scope),
    ]);
    const shipping =
      profile.shippingAddresses.find(
        ({ id }) => id === profile.defaultShippingAddressId
      ) ?? profile.shippingAddresses.find(({ isDefault }) => isDefault);
    const requested = new Set(categories ?? fieldCategorySchema.options);
    const filled = new Set<z.infer<typeof fieldCategorySchema>>();

    const contactValues = [
      {
        category: "full_name" as const,
        token: "name",
        value: profile.contact.name ?? shipping?.address?.name,
      },
      {
        category: "email" as const,
        token: "email",
        value: profile.contact.email,
      },
      {
        category: "phone" as const,
        token: "tel",
        value: profile.contact.phone ?? shipping?.address?.phone,
      },
    ]
      .filter(hasAutofillValue)
      .filter(({ category }) => requested.has(category));
    if (contactValues.length > 0) {
      try {
        await fillWithKernelNativeAutofill({
          browserSessionId,
          claims: contactValues.map(({ token, value }) =>
            autofillClaim(token, value)
          ),
          expectedOrigin: origin,
          kind: "contact",
          signal: context.abortSignal,
        });
        for (const { category } of contactValues) filled.add(category);
      } catch (error) {
        if (!isMissingAutofillSurface(error)) throw error;
      }
    }

    if (requested.has("shipping_address") && shipping?.address) {
      const address = shipping.address;
      const addressValues = [
        { token: "name", value: address.name },
        {
          token: "street-address",
          value: [address.line1, address.line2].filter(Boolean).join("\n"),
        },
        { token: "address-line1", value: address.line1 },
        { token: "address-line2", value: address.line2 },
        { token: "address-level2", value: address.city },
        { token: "address-level1", value: address.state },
        { token: "postal-code", value: address.postalCode },
        { token: "country", value: address.country },
        { token: "tel", value: address.phone },
      ].filter(hasAutofillValue);
      if (addressValues.length > 0) {
        try {
          await fillWithKernelNativeAutofill({
            addressPurpose: "shipping",
            browserSessionId,
            claims: addressValues.map(({ token, value }) =>
              autofillClaim(token, value)
            ),
            expectedOrigin: origin,
            kind: "address",
            signal: context.abortSignal,
          });
          filled.add("shipping_address");
        } catch (error) {
          if (!isMissingAutofillSurface(error)) throw error;
        }
      }
    }

    const requestedCategories = fieldCategorySchema.options.filter((category) =>
      requested.has(category)
    );
    return outputSchema.parse({
      filled: requestedCategories.filter((category) => filled.has(category)),
      missing: requestedCategories.filter((category) => !filled.has(category)),
      success: true,
    });
  },
});

function hasAutofillValue<
  T extends { readonly value: string | null | undefined },
>(input: T): input is T & { readonly value: string } {
  return typeof input.value === "string" && input.value.length > 0;
}

function autofillClaim(token: string, value: string): AutofillClaim {
  return { id: crypto.randomUUID(), token, value };
}

function isMissingAutofillSurface(error: unknown) {
  if (!(error instanceof Error)) return false;
  return [
    "No visible form control is available for autofill.",
    "No visible shipping address form has explicit autocomplete ownership.",
    "Chromium could not autofill any visible control.",
  ].some((message) => error.message.includes(message));
}
