import { defineTool } from "eve/tools";
import { z } from "zod";
import { requireOwnedBrowserSession } from "@/agent/subagents/worker/lib/owned-browser";
import { requireWorkerScope } from "@/agent/subagents/worker/lib/access";
import { readVaultItem } from "@/db/services/vault";
import { kernel } from "@/lib/kernel";
import { materializeAutofillClaims } from "@/lib/manager/server/vault-autofill";
import { vaultAutofillProvider } from "@/lib/manager/server/vault-autofill-provider";
import {
  currentKernelPageOrigin,
  fillWithKernelNativeAutofill,
  nativeAutofillTokens,
} from "@/lib/manager/server/kernel-native-autofill";
import { fillFromVaultRequestSchema } from "@/lib/manager/vault-autofill";

const fieldCategorySchema = z.enum([
  "email",
  "full_name",
  "phone",
  "shipping_address",
]);

const inputSchema = fillFromVaultRequestSchema
  .extend({
    fieldCategories: z.array(fieldCategorySchema).min(1).max(4).optional(),
  })
  .strict();

const outputSchema = z.object({
  filledClaims: z.number().int().nonnegative(),
  kind: z.enum(["address", "contact", "login", "payment"]),
  origin: z.string(),
  success: z.literal(true),
});

export default defineTool({
  description:
    "Fill a login, card, contact, or address form with an opaque handle returned by list_vault. Focus one control in the intended form first. During Link checkout, restrict contact fieldCategories to only categories Link reported missing. Never supply vault fields, selectors, origins, or secret values.",
  inputSchema,
  outputSchema,
  async execute(input, context) {
    const scope = await requireWorkerScope(context);

    await requireOwnedBrowserSession(scope, input.browserSessionId);
    const item = await readVaultItem(scope, input.candidateId);
    if (!item) throw new Error("The selected vault item was not found.");
    if (
      item.kind !== "address" &&
      item.kind !== "contact" &&
      item.kind !== "login" &&
      item.kind !== "payment"
    ) {
      throw new Error(
        "Native browser autofill currently supports only logins, cards, contacts, and addresses."
      );
    }
    if (item.kind === "login") {
      const browser = await kernel.browsers.retrieve(
        input.browserSessionId,
        {},
        { signal: context.abortSignal }
      );
      if (!browser.profile_save_changes) {
        throw new Error(
          "Login autofill requires a browser created with save_changes: true. Delete this browser, create a writable browser at the same URL, then focus and fill again."
        );
      }
    }

    const origin = await currentKernelPageOrigin({
      browserSessionId: input.browserSessionId,
      signal: context.abortSignal,
    });
    const surfaceKind =
      item.kind === "payment"
        ? "payment-card"
        : item.kind === "login"
          ? "credentials"
          : item.kind === "contact"
            ? "contact"
            : "postal-address";
    const tokens = nativeAutofillTokens[item.kind];
    const availableTokens = restrictedAutofillTokens(
      item.kind,
      tokens,
      input.fieldCategories
    );
    const surface = {
      fields: availableTokens.map((token) => ({ score: 100, token })),
      id: surfaceKind,
      kind: surfaceKind,
    };

    const claims = await materializeAutofillClaims(
      scope,
      input.candidateId,
      {
        availableTokens: new Set(availableTokens),
        origin,
        surface,
      },
      vaultAutofillProvider
    );
    const result = await fillWithKernelNativeAutofill({
      browserSessionId: input.browserSessionId,
      claims,
      expectedOrigin: origin,
      kind: item.kind,
      signal: context.abortSignal,
    });

    return {
      filledClaims: result.filledClaims,
      kind: item.kind,
      origin: result.origin,
      success: true as const,
    };
  },
});

function restrictedAutofillTokens(
  kind: "address" | "contact" | "login" | "payment",
  tokens: readonly string[],
  categories: readonly z.infer<typeof fieldCategorySchema>[] | undefined
) {
  if (!categories) return [...tokens];
  if (kind === "login" || kind === "payment") {
    throw new Error(
      "Field-category filtering is available only for saved contacts and addresses."
    );
  }
  if (kind === "address") {
    if (!categories.includes("shipping_address")) {
      throw new Error(
        "A saved address can fill only the shipping_address category."
      );
    }
    return [...tokens];
  }

  const selectedTokens = new Set(
    categories.flatMap((category) => {
      switch (category) {
        case "full_name":
          return ["name"];
        case "email":
          return ["email"];
        case "phone":
          return ["tel"];
        case "shipping_address":
          return [];
      }
    })
  );
  const restricted = tokens.filter((token) => selectedTokens.has(token));
  if (restricted.length === 0) {
    throw new Error(
      "The selected contact has no compatible requested field category."
    );
  }
  return restricted;
}
