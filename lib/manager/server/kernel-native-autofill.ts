import Kernel from "@onkernel/sdk";
import { z } from "zod";
import { env } from "../../env";
import type { AutofillClaim } from "../vault-autofill-protocol";
import {
  classifyNativeLoginControl,
  nativeLoginAutofillTokens,
  nativeLoginControlInspectionExpression,
  nativeLoginFillFunctionDeclaration,
  selectNativeLoginFills,
  type ClassifiedNativeLoginControl,
} from "./kernel-login-autofill";

const targetListSchema = z.object({
  targetInfos: z.array(
    z.object({
      targetId: z.string(),
      type: z.string(),
      url: z.string(),
    })
  ),
});

const attachedTargetSchema = z.object({ sessionId: z.string() });

const frameTreeSchema = z.object({
  frameTree: z.lazy(() => frameTreeNodeSchema),
});
const frameTreeNodeSchema: z.ZodType<{
  childFrames?: z.infer<typeof frameTreeNodeSchema>[];
  frame: { id: string; url: string };
}> = z.object({
  childFrames: z.array(z.lazy(() => frameTreeNodeSchema)).optional(),
  frame: z.object({ id: z.string(), url: z.string() }),
});

const isolatedWorldSchema = z.object({ executionContextId: z.number() });
const evaluatedValueSchema = z.object({
  result: z.object({ value: z.unknown() }),
});
const evaluatedBooleanSchema = z.object({
  result: z.object({ value: z.boolean() }),
});
const evaluatedNumberSchema = z.object({
  result: z.object({ value: z.number().int().nonnegative() }),
});
const evaluatedObjectSchema = z.object({
  result: z.object({ objectId: z.string().optional() }),
});
const evaluatedStringSchema = z.object({
  result: z.object({ value: z.string() }),
});
const describedNodeSchema = z.object({
  node: z.object({ backendNodeId: z.number().int().positive() }),
});
const controlDescriptorsSchema = z.array(
  z.object({
    autocomplete: z.string(),
    focused: z.boolean(),
    formIndex: z.number().int().nonnegative().nullable(),
    index: z.number().int().nonnegative(),
  })
);
const loginControlDescriptorsSchema = z.array(
  z.object({
    autocomplete: z.string(),
    focused: z.boolean(),
    formIndex: z.number().int().nonnegative().nullable(),
    index: z.number().int().nonnegative(),
    label: z.string(),
    name: z.string(),
    type: z.string(),
  })
);
const linkSteeringInspectionSchema = z.object({
  hasSteering: z.boolean(),
  hasTokenInput: z.boolean(),
  merchantAccountId: z.string().nullable(),
});
const linkTokenInjectionSchema = z.object({
  result: z.object({
    value: z.object({ savedPaymentState: z.boolean() }),
  }),
});
const ordinaryCardFieldSchema = z.enum(["number", "expiry", "cvc"]);
const ordinaryCardInspectionSchema = z
  .array(z.array(ordinaryCardFieldSchema).max(3))
  .max(100);
const checkoutQuoteCandidateSchema = z
  .array(
    z.object({
      hint: z.string().max(500),
      kind: z.enum(["text", "submit"]),
      text: z.string().max(500),
    })
  )
  .max(500);
const checkoutSubmitSchema = z.object({
  result: z.object({ value: z.boolean() }),
});
const orderConfirmationSchema = z.object({
  confirmationText: z.boolean(),
  orderIdentifier: z.string().nullable(),
});

const cardTokens = [
  "cc-name",
  "cc-number",
  "cc-exp-month",
  "cc-exp-year",
  "cc-csc",
] as const;

const addressTokenToChromiumField = {
  name: "NAME_FULL",
  email: "EMAIL_ADDRESS",
  tel: "PHONE_HOME_WHOLE_NUMBER",
  "street-address": "ADDRESS_HOME_STREET_ADDRESS",
  "address-line1": "ADDRESS_HOME_LINE1",
  "address-line2": "ADDRESS_HOME_LINE2",
  "address-level2": "ADDRESS_HOME_CITY",
  "address-level1": "ADDRESS_HOME_STATE",
  "postal-code": "ADDRESS_HOME_ZIP",
  country: "ADDRESS_HOME_COUNTRY",
} as const;

const contactTokenToChromiumField = {
  name: "NAME_FULL",
  email: "EMAIL_ADDRESS",
  tel: "PHONE_HOME_WHOLE_NUMBER",
} as const;

export const nativeAutofillTokens = {
  address: Object.keys(addressTokenToChromiumField),
  contact: Object.keys(contactTokenToChromiumField),
  login: nativeLoginAutofillTokens,
  payment: [...cardTokens],
} as const;

type NativeAutofillKind = "address" | "contact" | "login" | "payment";
export type AddressPurpose = "billing" | "shipping";

export async function currentKernelPageOrigin({
  browserSessionId,
  signal,
}: {
  readonly browserSessionId: string;
  readonly signal?: AbortSignal;
}) {
  return withKernelPage(browserSessionId, signal, async ({ origin }) => origin);
}

export async function inspectLinkCheckoutSurface({
  browserSessionId,
  expectedOrigin,
  signal,
}: {
  readonly browserSessionId: string;
  readonly expectedOrigin?: string;
  readonly signal?: AbortSignal;
}) {
  return withKernelPage(
    browserSessionId,
    signal,
    async ({ connection, origin, sessionId }) => {
      if (expectedOrigin !== undefined && origin !== expectedOrigin) {
        throw new Error(
          "The checkout origin changed before the payment surface was inspected."
        );
      }

      const frames = await inspectLinkFrames(connection, sessionId);
      const eligibleFrames = frames.filter(
        ({ frameUrl, inspection }) =>
          isStripeUrl(frameUrl) &&
          inspection.hasSteering &&
          inspection.hasTokenInput &&
          isStripeAccountId(inspection.merchantAccountId)
      );
      const merchantAccountIds = new Set(
        eligibleFrames.flatMap(({ inspection }) =>
          inspection.merchantAccountId ? [inspection.merchantAccountId] : []
        )
      );
      if (merchantAccountIds.size > 1) {
        throw new Error(
          "The checkout exposes conflicting Stripe merchant bindings."
        );
      }
      const eligible = eligibleFrames[0];
      if (eligible?.inspection.merchantAccountId) {
        return {
          merchantAccountId: eligible.inspection.merchantAccountId,
          origin,
          route: "link_pay_token" as const,
        };
      }

      const cardFieldGroups = (
        await Promise.all(
          sessionId.map((id) => inspectOrdinaryCardFieldGroups(connection, id))
        )
      ).flat();
      if (!hasCoherentOrdinaryCardFieldGroup(cardFieldGroups)) {
        throw new Error(
          "This page exposes neither a verified Stripe Link Pay Token surface nor an ordinary card form."
        );
      }
      return {
        merchantAccountId: null,
        origin,
        route: "virtual_card" as const,
      };
    }
  );
}

export async function revalidateKernelCheckoutQuote({
  browserSessionId,
  currency,
  currentAmount,
  expectedOrigin,
  itemNames,
  signal,
}: {
  readonly browserSessionId: string;
  readonly currency: string;
  readonly currentAmount: number;
  readonly expectedOrigin: string;
  readonly itemNames: readonly string[];
  readonly signal?: AbortSignal;
}) {
  return withKernelPage(
    browserSessionId,
    signal,
    async ({ connection, origin, sessionId }) => {
      if (origin !== expectedOrigin) {
        throw new Error(
          "The checkout origin changed after Link approval was requested."
        );
      }
      const [quoteCandidates, visibleText] = await Promise.all([
        Promise.all(
          sessionId.map((id) => readCheckoutQuoteCandidates(connection, id))
        ).then((candidates) => candidates.flat()),
        Promise.all(
          sessionId.map((id) => readVisibleCheckoutText(connection, id))
        ).then((texts) => normalizeCheckoutText(texts.join("\n"))),
      ]);
      if (
        !checkoutQuoteCandidatesMatchAmount(
          quoteCandidates,
          currentAmount,
          currency
        )
      ) {
        throw new Error(
          "The checkout does not expose one unambiguous final total matching the current Link quote."
        );
      }
      const missingItem = itemNames.find(
        (name) => !visibleText.includes(normalizeCheckoutText(name))
      );
      if (missingItem) {
        throw new Error(
          "The checkout items changed after Link approval was requested."
        );
      }
      return { origin };
    }
  );
}

export async function injectLinkPayTokenWithKernel({
  browserSessionId,
  expectedMerchantAccountId,
  expectedOrigin,
  signal,
  token,
}: {
  readonly browserSessionId: string;
  readonly expectedMerchantAccountId: string;
  readonly expectedOrigin: string;
  readonly signal?: AbortSignal;
  readonly token: string;
}) {
  return withKernelPage(
    browserSessionId,
    signal,
    async ({ connection, origin, sessionId }) => {
      if (origin !== expectedOrigin) {
        throw new Error(
          "The checkout origin changed after Link approval was granted."
        );
      }
      const frames = await inspectLinkFrames(connection, sessionId);
      const surface = frames.find(
        ({ frameUrl, inspection }) =>
          isStripeUrl(frameUrl) &&
          inspection.hasSteering &&
          inspection.hasTokenInput &&
          inspection.merchantAccountId === expectedMerchantAccountId
      );
      if (!surface) {
        throw new Error(
          "The approved Stripe merchant binding is no longer present in the checkout frame."
        );
      }

      const evaluated = evaluatedObjectSchema.parse(
        await connection.send(
          "Runtime.evaluate",
          {
            contextId: surface.executionContextId,
            expression:
              "document.querySelector('input[name=\"link_pay_token\"]')",
          },
          surface.sessionId
        )
      );
      const objectId = evaluated.result.objectId;
      if (!objectId) {
        throw new Error("The Link Pay Token input is no longer available.");
      }

      try {
        const response = linkTokenInjectionSchema.parse(
          await connection.send(
            "Runtime.callFunctionOn",
            {
              arguments: [{ value: token }],
              awaitPromise: true,
              functionDeclaration: linkPayTokenInjectionFunctionDeclaration,
              objectId,
              returnByValue: true,
            },
            surface.sessionId
          )
        );
        return {
          origin,
          savedPaymentState: response.result.value.savedPaymentState,
        };
      } finally {
        await connection
          .send("Runtime.releaseObject", { objectId }, surface.sessionId)
          .catch(() => undefined);
      }
    }
  );
}

export async function submitKernelCheckoutAndVerify({
  browserSessionId,
  currency,
  currentAmount,
  expectedOrigin,
  onSubmitted,
  signal,
  submitLabel,
}: {
  readonly browserSessionId: string;
  readonly currency: string;
  readonly currentAmount: number;
  readonly expectedOrigin: string;
  readonly onSubmitted?: () => Promise<void>;
  readonly signal?: AbortSignal;
  readonly submitLabel: string;
}) {
  const clicked = await withKernelPage(
    browserSessionId,
    signal,
    async ({ connection, origin, sessionId }) => {
      if (origin !== expectedOrigin) {
        throw new Error(
          "The checkout origin changed immediately before payment submission."
        );
      }
      return clickCheckoutSubmit(
        connection,
        sessionId,
        submitLabel,
        currentAmount,
        currency
      );
    }
  );
  if (!clicked) {
    throw new Error(
      "No unambiguous enabled Pay or Place order control was found; payment was not submitted."
    );
  }
  await onSubmitted?.();

  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    const confirmation = await readKernelOrderConfirmation(
      browserSessionId,
      signal
    ).catch(() => null);
    if (confirmation?.confirmed) return confirmation;
    await abortableDelay(750, signal);
  }
  throw new Error(
    "Payment was submitted once, but no order-confirmation page or order identifier appeared. Do not submit again automatically."
  );
}

export async function verifyKernelCheckoutSubmitControl({
  browserSessionId,
  currency,
  currentAmount,
  expectedOrigin,
  signal,
  submitLabel,
}: {
  readonly browserSessionId: string;
  readonly currency: string;
  readonly currentAmount: number;
  readonly expectedOrigin: string;
  readonly signal?: AbortSignal;
  readonly submitLabel: string;
}) {
  return withKernelPage(
    browserSessionId,
    signal,
    async ({ connection, origin, sessionId }) => {
      if (origin !== expectedOrigin) {
        throw new Error(
          "The checkout origin changed before the submit control was verified."
        );
      }
      const candidates = await findCheckoutSubmitTargets(
        connection,
        sessionId,
        submitLabel,
        currentAmount,
        currency
      );
      if (candidates.length !== 1) {
        throw new Error(
          "The supplied checkout submit label does not identify exactly one visible enabled control."
        );
      }
      return { origin };
    }
  );
}

export async function inspectKernelOrderConfirmation({
  browserSessionId,
  signal,
}: {
  readonly browserSessionId: string;
  readonly signal?: AbortSignal;
}) {
  return readKernelOrderConfirmation(browserSessionId, signal);
}

export async function fillWithKernelNativeAutofill({
  addressPurpose,
  browserSessionId,
  claims,
  expectedOrigin,
  kind,
  signal,
}: {
  readonly addressPurpose?: AddressPurpose;
  readonly browserSessionId: string;
  readonly claims: readonly AutofillClaim[];
  readonly expectedOrigin: string;
  readonly kind: NativeAutofillKind;
  readonly signal?: AbortSignal;
}) {
  if (addressPurpose && kind !== "address") {
    throw new Error(
      "An address purpose can only be used with address autofill."
    );
  }
  const payload =
    kind === "login" ? undefined : buildNativeAutofillPayload(kind, claims);

  return withKernelPage(
    browserSessionId,
    signal,
    async ({ connection, origin, sessionId }) => {
      if (origin !== expectedOrigin) {
        throw new Error(
          "The active tab no longer matches the approved origin."
        );
      }

      if (kind === "login") {
        const filledClaims = await fillNativeLoginControls(
          connection,
          sessionId,
          claims
        );
        return { filledClaims, origin };
      }

      const controls = await inspectControls(
        connection,
        sessionId,
        kind,
        addressPurpose
      );
      if (controls.length === 0) {
        throw new Error("No visible form control is available for autofill.");
      }

      let lastError: unknown;
      for (const control of controls) {
        try {
          await markNativeAutofilledControls(connection, control);
          await connection.send(
            "Autofill.trigger",
            {
              fieldId: control.backendNodeId,
              frameId: control.frameId,
              ...payload,
            },
            control.sessionId
          );
        } catch (error) {
          lastError = error;
          continue;
        }
        return { filledClaims: claims.length, origin };
      }

      throw new Error(
        "Chromium could not autofill any visible control. Focus a field in the intended card or address form and retry.",
        { cause: lastError }
      );
    }
  );
}

async function fillNativeLoginControls(
  connection: CdpConnection,
  sessionIds: readonly string[],
  claims: readonly AutofillClaim[]
) {
  const controls = await inspectNativeLoginControls(connection, sessionIds);
  const focused = controls.find((control) => control.focused);
  if (!focused) {
    throw new Error(
      "Focus a visible username, email, phone, or current-password field and retry."
    );
  }
  const sameFrame = controls.filter(
    (control) =>
      control.frameId === focused.frameId &&
      control.sessionId === focused.sessionId
  );
  const fills = selectNativeLoginFills(sameFrame, claims);
  if (fills.length === 0) {
    throw new Error(
      "The focused login form does not accept a field available in this saved login."
    );
  }

  for (const { control, value } of fills) {
    const accepted = await fillNativeLoginControl(connection, control, value);
    if (!accepted) {
      throw new Error("The login form rejected secure credential autofill.");
    }
  }
  return fills.length;
}

async function inspectNativeLoginControls(
  connection: CdpConnection,
  sessionIds: readonly string[]
) {
  return (
    await Promise.all(
      sessionIds.map(async (sessionId) => {
        try {
          await connection.send("Page.enable", undefined, sessionId);
          const { frameTree } = frameTreeSchema.parse(
            await connection.send("Page.getFrameTree", undefined, sessionId)
          );
          return (
            await Promise.all(
              flattenFrames(frameTree).map(({ id: frameId }) =>
                inspectNativeLoginFrame(connection, sessionId, frameId).catch(
                  () => []
                )
              )
            )
          ).flat();
        } catch {
          return [];
        }
      })
    )
  ).flat();
}

async function inspectNativeLoginFrame(
  connection: CdpConnection,
  sessionId: string,
  frameId: string
) {
  const { executionContextId } = isolatedWorldSchema.parse(
    await connection.send(
      "Page.createIsolatedWorld",
      { frameId, worldName: "open-instinct-login-autofill" },
      sessionId
    )
  );
  const response = evaluatedValueSchema.parse(
    await connection.send(
      "Runtime.evaluate",
      {
        contextId: executionContextId,
        expression: nativeLoginControlInspectionExpression,
        returnByValue: true,
      },
      sessionId
    )
  );
  const descriptors = loginControlDescriptorsSchema.parse(
    response.result.value
  );
  return descriptors.flatMap((descriptor) => {
    const classified = classifyNativeLoginControl(descriptor);
    return classified
      ? [{ ...classified, executionContextId, frameId, sessionId }]
      : [];
  });
}

async function fillNativeLoginControl(
  connection: CdpConnection,
  control: ClassifiedNativeLoginControl & {
    readonly executionContextId: number;
    readonly frameId: string;
    readonly sessionId: string;
  },
  value: string
) {
  const evaluated = evaluatedObjectSchema.parse(
    await connection.send(
      "Runtime.evaluate",
      {
        contextId: control.executionContextId,
        expression: `document.querySelectorAll("input").item(${String(control.index)})`,
      },
      control.sessionId
    )
  );
  const objectId = evaluated.result.objectId;
  if (!objectId) return false;

  try {
    const response = evaluatedBooleanSchema.parse(
      await connection.send(
        "Runtime.callFunctionOn",
        {
          arguments: [{ value }],
          awaitPromise: false,
          functionDeclaration: nativeLoginFillFunctionDeclaration,
          objectId,
          returnByValue: true,
        },
        control.sessionId
      )
    );
    return response.result.value;
  } finally {
    await connection
      .send("Runtime.releaseObject", { objectId }, control.sessionId)
      .catch(() => undefined);
  }
}

export function buildNativeAutofillPayload(
  kind: "address" | "contact" | "payment",
  claims: readonly Pick<AutofillClaim, "token" | "value">[]
) {
  const values = new Map(claims.map(({ token, value }) => [token, value]));

  if (kind === "payment") {
    return {
      card: {
        cvc: requiredClaim(values, "cc-csc"),
        expiryMonth: requiredClaim(values, "cc-exp-month"),
        expiryYear: requiredClaim(values, "cc-exp-year"),
        name: requiredClaim(values, "cc-name"),
        number: requiredClaim(values, "cc-number"),
      },
    };
  }

  const tokenMap =
    kind === "contact"
      ? contactTokenToChromiumField
      : addressTokenToChromiumField;
  const fields = Object.entries(tokenMap).flatMap(([token, name]) => {
    const value = values.get(token);
    return value ? [{ name, value }] : [];
  });
  if (fields.length === 0) {
    throw new Error(
      kind === "contact"
        ? "The saved contact is incomplete or invalid."
        : "The saved address is incomplete or invalid."
    );
  }
  return { address: { fields } };
}

async function inspectControls(
  connection: CdpConnection,
  sessionIds: readonly string[],
  kind: "address" | "contact" | "payment",
  addressPurpose?: AddressPurpose
) {
  const controls = (
    await Promise.all(
      sessionIds.map(async (sessionId) => {
        try {
          await connection.send("Page.enable", undefined, sessionId);
          const { frameTree } = frameTreeSchema.parse(
            await connection.send("Page.getFrameTree", undefined, sessionId)
          );
          return (
            await Promise.all(
              flattenFrames(frameTree).map(({ id: frameId }) =>
                inspectFrameControls(
                  connection,
                  sessionId,
                  frameId,
                  kind
                ).catch(() => [])
              )
            )
          ).flat();
        } catch {
          return [];
        }
      })
    )
  ).flat();

  const sorted = controls.toSorted((left, right) => {
    if (left.focused !== right.focused) return left.focused ? -1 : 1;
    if (left.standard !== right.standard) return left.standard ? -1 : 1;
    return left.order - right.order;
  });
  return kind === "address"
    ? selectAddressPurposeControls(sorted, addressPurpose)
    : sorted;
}

async function inspectFrameControls(
  connection: CdpConnection,
  sessionId: string,
  frameId: string,
  kind: "address" | "contact" | "payment"
) {
  const { executionContextId } = isolatedWorldSchema.parse(
    await connection.send(
      "Page.createIsolatedWorld",
      { frameId, worldName: "open-instinct-autofill" },
      sessionId
    )
  );
  const response = evaluatedValueSchema.parse(
    await connection.send(
      "Runtime.evaluate",
      {
        contextId: executionContextId,
        expression: controlInspectionExpression,
        returnByValue: true,
      },
      sessionId
    )
  );
  const descriptors = controlDescriptorsSchema.parse(response.result.value);

  return (
    await Promise.all(
      descriptors.map(async (descriptor, order) => {
        const evaluated = evaluatedObjectSchema.parse(
          await connection.send(
            "Runtime.evaluate",
            {
              contextId: executionContextId,
              expression: `document.querySelectorAll("input, select, textarea").item(${String(descriptor.index)})`,
            },
            sessionId
          )
        );
        const objectId = evaluated.result.objectId;
        if (!objectId) return null;

        try {
          const described = describedNodeSchema.parse(
            await connection.send("DOM.describeNode", { objectId }, sessionId)
          );
          return {
            addressPurpose: addressPurposeFromAutocomplete(
              descriptor.autocomplete
            ),
            backendNodeId: described.node.backendNodeId,
            executionContextId,
            focused: descriptor.focused,
            formIndex: descriptor.formIndex,
            frameId,
            index: descriptor.index,
            order,
            sessionId,
            standard: standardAutocomplete(kind, descriptor.autocomplete),
          };
        } finally {
          await connection
            .send("Runtime.releaseObject", { objectId }, sessionId)
            .catch(() => undefined);
        }
      })
    )
  ).filter((control) => control !== null);
}

const controlInspectionExpression = `(() => {
  const elements = Array.from(document.querySelectorAll("input, select, textarea"));
  const forms = Array.from(document.querySelectorAll("form, [role=form]"));
  return elements.flatMap((element, index) => {
    if (element.disabled || ("readOnly" in element && element.readOnly)) return [];
    if (element instanceof HTMLInputElement && ["hidden", "submit", "button", "reset", "file", "image", "checkbox", "radio"].includes(element.type)) return [];
    const style = getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || element.getClientRects().length === 0) return [];
    const form = element.form || element.closest("form, [role=form]");
    const formIndex = form ? forms.indexOf(form) : null;
    return [{ autocomplete: element.autocomplete || "", focused: document.activeElement === element, formIndex, index }];
  });
})()`;

export function addressPurposeFromAutocomplete(autocomplete: string) {
  const purposes = new Set(
    autocomplete
      .toLowerCase()
      .split(/\s+/u)
      .filter((token): token is AddressPurpose =>
        ["billing", "shipping"].includes(token)
      )
  );
  if (purposes.size > 1) return "ambiguous" as const;
  return purposes.values().next().value ?? null;
}

export function selectAddressPurposeControls<
  T extends {
    readonly addressPurpose: AddressPurpose | "ambiguous" | null;
    readonly focused: boolean;
    readonly formIndex: number | null;
    readonly frameId: string;
  },
>(controls: readonly T[], requestedPurpose?: AddressPurpose) {
  if (
    requestedPurpose &&
    controls.some(({ addressPurpose }) => addressPurpose === "ambiguous")
  ) {
    throw new Error(
      "The checkout has an ambiguous billing and shipping autocomplete section."
    );
  }

  const explicit = controls.filter(
    (control): control is T & { readonly addressPurpose: AddressPurpose } =>
      control.addressPurpose === "billing" ||
      control.addressPurpose === "shipping"
  );
  let purpose = requestedPurpose;
  if (!purpose) {
    const visiblePurposes = new Set(
      explicit.map(({ addressPurpose }) => addressPurpose)
    );
    if (visiblePurposes.size === 0) return [...controls];
    if (visiblePurposes.size === 1) {
      purpose = visiblePurposes.values().next().value;
    } else {
      const focusedPurposes = new Set(
        explicit
          .filter(({ focused }) => focused)
          .map(({ addressPurpose }) => addressPurpose)
      );
      if (focusedPurposes.size !== 1) {
        throw new Error(
          "Both billing and shipping forms are visible. Focus the intended address form and retry."
        );
      }
      purpose = focusedPurposes.values().next().value;
    }
  }
  if (!purpose) {
    throw new Error("The address form purpose could not be determined.");
  }

  const matching = explicit.filter(
    ({ addressPurpose }) => addressPurpose === purpose
  );
  if (matching.length === 0) {
    throw new Error(
      `No visible ${purpose} address form has explicit autocomplete ownership.`
    );
  }
  const groups = new Map<string, T[]>();
  for (const control of matching) {
    const key = `${control.frameId}\u0000${String(control.formIndex)}`;
    groups.set(key, [...(groups.get(key) ?? []), control]);
  }
  if (groups.size === 1) return matching;

  const focusedGroups = [...groups.values()].filter((group) =>
    group.some(({ focused }) => focused)
  );
  if (focusedGroups.length === 1) return focusedGroups[0] ?? [];
  throw new Error(
    `More than one ${purpose} address form is visible. Focus the intended form and retry.`
  );
}

export function nativeAutofillSecretMarkingExpression(index: number) {
  return `(() => {
    const controls = document.querySelectorAll("input, select, textarea");
    const anchor = controls.item(${String(index)});
    if (!anchor) return 0;
    const root = anchor.form || anchor.closest("form") || document;
    let marked = 0;
    for (const element of root.querySelectorAll("input, select, textarea")) {
      if (element.disabled || ("readOnly" in element && element.readOnly)) continue;
      if (element instanceof HTMLInputElement && ["hidden", "submit", "button", "reset", "file", "image", "checkbox", "radio"].includes(element.type)) continue;
      element.dataset.vaultSecret = "true";
      marked += 1;
    }
    return marked;
  })()`;
}

async function markNativeAutofilledControls(
  connection: CdpConnection,
  control: {
    readonly executionContextId: number;
    readonly index: number;
    readonly sessionId: string;
  }
) {
  const response = evaluatedNumberSchema.parse(
    await connection.send(
      "Runtime.evaluate",
      {
        contextId: control.executionContextId,
        expression: nativeAutofillSecretMarkingExpression(control.index),
        returnByValue: true,
      },
      control.sessionId
    )
  );
  if (response.result.value === 0) {
    throw new Error(
      "Vault-filled controls could not be marked for screenshot masking."
    );
  }
}

async function inspectLinkFrames(
  connection: CdpConnection,
  sessionIds: readonly string[]
) {
  return (
    await Promise.all(
      sessionIds.map(async (sessionId) => {
        try {
          await connection.send("Page.enable", undefined, sessionId);
          const { frameTree } = frameTreeSchema.parse(
            await connection.send("Page.getFrameTree", undefined, sessionId)
          );
          return (
            await Promise.all(
              flattenFrames(frameTree).map(({ id: frameId, url: frameUrl }) =>
                inspectLinkFrame(
                  connection,
                  sessionId,
                  frameId,
                  frameUrl
                ).catch(() => null)
              )
            )
          ).filter((value) => value !== null);
        } catch {
          return [];
        }
      })
    )
  ).flat();
}

async function inspectLinkFrame(
  connection: CdpConnection,
  sessionId: string,
  frameId: string,
  frameUrl: string
) {
  const { executionContextId } = isolatedWorldSchema.parse(
    await connection.send(
      "Page.createIsolatedWorld",
      { frameId, worldName: "open-instinct-link-steering" },
      sessionId
    )
  );
  const response = evaluatedValueSchema.parse(
    await connection.send(
      "Runtime.evaluate",
      {
        awaitPromise: true,
        contextId: executionContextId,
        expression: linkSteeringInspectionExpression,
        returnByValue: true,
      },
      sessionId
    )
  );
  return {
    executionContextId,
    frameId,
    frameUrl,
    inspection: linkSteeringInspectionSchema.parse(response.result.value),
    sessionId,
  };
}

const linkSteeringInspectionExpression = `(async () => {
  const container = document.querySelector(".AiAgentPaymentSteering");
  const checkbox = container?.querySelector('input[type="checkbox"]');
  if (checkbox instanceof HTMLInputElement && !checkbox.checked) checkbox.click();

  const deadline = Date.now() + 2500;
  let tokenInput = document.querySelector('input[name="link_pay_token"]');
  let accountNode = container?.matches("[data-stripe-merchant-account]")
    ? container
    : container?.querySelector("[data-stripe-merchant-account]");
  while (container && (!tokenInput || !accountNode) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    tokenInput = document.querySelector('input[name="link_pay_token"]');
    accountNode = container.matches("[data-stripe-merchant-account]")
      ? container
      : container.querySelector("[data-stripe-merchant-account]");
  }
  return {
    hasSteering: Boolean(container && checkbox),
    hasTokenInput: tokenInput instanceof HTMLInputElement,
    merchantAccountId: accountNode?.getAttribute("data-stripe-merchant-account") || null,
  };
})()`;

const linkPayTokenInjectionFunctionDeclaration = `async function(token) {
  const input = this;
  const view = input.ownerDocument?.defaultView;
  if (!(view && input instanceof view.HTMLInputElement)) {
    return { savedPaymentState: false };
  }
  const beforeCardFields = visibleCardFieldCount(input.ownerDocument);
  const beforeSavedState = hasSavedPaymentState(input.ownerDocument);
  input.dataset.vaultSecret = "true";
  const secretRoot = input.form || input.closest("form") || input.closest(".AiAgentPaymentSteering");
  if (secretRoot instanceof view.HTMLElement) secretRoot.dataset.vaultSecret = "true";
  const setter = Object.getOwnPropertyDescriptor(
    view.HTMLInputElement.prototype,
    "value"
  )?.set;
  if (!setter) return { savedPaymentState: false };
  setter.call(input, token);
  input.dispatchEvent(new view.Event("input", { bubbles: true }));
  input.dispatchEvent(new view.Event("change", { bubbles: true }));

  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    const afterCardFields = visibleCardFieldCount(input.ownerDocument);
    const afterSavedState = hasSavedPaymentState(input.ownerDocument);
    if (
      (afterSavedState && !beforeSavedState) ||
      (beforeCardFields > 0 && afterCardFields === 0 && afterSavedState)
    ) {
      return { savedPaymentState: true };
    }
  }
  return { savedPaymentState: false };

  function visibleCardFieldCount(document) {
    return Array.from(document.querySelectorAll("input")).filter((element) => {
      if (!(element instanceof view.HTMLInputElement)) return false;
      const hint = [
        element.autocomplete,
        element.name,
        element.id,
        element.getAttribute("aria-label"),
        element.placeholder,
      ].filter(Boolean).join(" ").toLowerCase();
      if (!/(?:cc-number|card.?number|cardnumber|cc-exp|expir|cc-csc|cvc|cvv)/i.test(hint)) return false;
      const style = view.getComputedStyle(element);
      return !element.disabled && style.display !== "none" && style.visibility !== "hidden" && element.getClientRects().length > 0;
    }).length;
  }

  function hasSavedPaymentState(document) {
    const explicit = document.querySelector([
      '[data-testid*="saved-payment" i]',
      '[data-testid*="payment-method" i]',
      '[class*="SavedPayment" i]',
      '[aria-label*="ending in" i]',
    ].join(","));
    if (explicit) return true;
    const text = document.body?.innerText || "";
    return /(?:ending in|card ending|[•*]{2,}\\s*)\\d{4}\\b/i.test(text);
  }
}`;

async function inspectOrdinaryCardFieldGroups(
  connection: CdpConnection,
  sessionId: string
) {
  try {
    await connection.send("Page.enable", undefined, sessionId);
    const { frameTree } = frameTreeSchema.parse(
      await connection.send("Page.getFrameTree", undefined, sessionId)
    );
    return (
      await Promise.all(
        flattenFrames(frameTree).map(async ({ id: frameId }) => {
          const { executionContextId } = isolatedWorldSchema.parse(
            await connection.send(
              "Page.createIsolatedWorld",
              { frameId, worldName: "open-instinct-link-card-inspection" },
              sessionId
            )
          );
          const response = evaluatedValueSchema.parse(
            await connection.send(
              "Runtime.evaluate",
              {
                contextId: executionContextId,
                expression: ordinaryCardInspectionExpression,
                returnByValue: true,
              },
              sessionId
            )
          );
          return ordinaryCardInspectionSchema.parse(response.result.value);
        })
      )
    ).flat();
  } catch {
    return [];
  }
}

const ordinaryCardInspectionExpression = `(() => {
  const controls = Array.from(document.querySelectorAll("input")).filter((element) => {
    if (!(element instanceof HTMLInputElement) || element.disabled || element.readOnly) return false;
    const style = getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden" && element.getClientRects().length > 0;
  });
  const classify = (element) => {
    const hint = [element.autocomplete, element.name, element.id, element.getAttribute("aria-label"), element.placeholder]
      .filter(Boolean).join(" ").toLowerCase();
    if (/(?:cc-number|card.?number|cardnumber)/i.test(hint)) return "number";
    if (/(?:cc-exp|expir)/i.test(hint)) return "expiry";
    if (/(?:cc-csc|cvc|cvv|security.?code)/i.test(hint)) return "cvc";
    return null;
  };
  const roots = new Set();
  for (const control of controls) {
    if (!classify(control)) continue;
    const form = control.form || control.closest("form, [role=form]");
    if (form) {
      roots.add(form);
      continue;
    }
    for (let ancestor = control.parentElement; ancestor; ancestor = ancestor.parentElement) {
      const fields = new Set(
        controls
          .filter((candidate) => ancestor.contains(candidate))
          .map(classify)
          .filter(Boolean)
      );
      if (
        ancestor !== document.body &&
        ancestor !== document.documentElement &&
        fields.has("number") &&
        fields.has("expiry") &&
        fields.has("cvc")
      ) {
        roots.add(ancestor);
        break;
      }
      const hint = [
        ancestor.id,
        ancestor.getAttribute("class"),
        ancestor.getAttribute("data-testid"),
        ancestor.getAttribute("aria-label"),
        ancestor.getAttribute("role"),
      ].filter(Boolean).join(" ").toLowerCase();
      if (
        ancestor !== document.body &&
        ancestor !== document.documentElement &&
        /(?:checkout|payment|credit.?card|card.?details)/i.test(hint)
      ) {
        roots.add(ancestor);
      }
    }
  }
  return Array.from(roots, (root) => Array.from(new Set(
    controls.filter((control) => root.contains(control)).map(classify).filter(Boolean)
  )));
})()`;

export function hasCoherentOrdinaryCardFieldGroup(
  groups: readonly (readonly z.infer<typeof ordinaryCardFieldSchema>[])[]
) {
  return groups.some(
    (group) =>
      group.includes("number") &&
      group.includes("expiry") &&
      group.includes("cvc")
  );
}

async function readCheckoutQuoteCandidates(
  connection: CdpConnection,
  sessionId: string
) {
  try {
    await connection.send("Page.enable", undefined, sessionId);
    const { frameTree } = frameTreeSchema.parse(
      await connection.send("Page.getFrameTree", undefined, sessionId)
    );
    return (
      await Promise.all(
        flattenFrames(frameTree).map(async ({ id: frameId }) => {
          const { executionContextId } = isolatedWorldSchema.parse(
            await connection.send(
              "Page.createIsolatedWorld",
              { frameId, worldName: "open-instinct-checkout-quote" },
              sessionId
            )
          );
          const response = evaluatedValueSchema.parse(
            await connection.send(
              "Runtime.evaluate",
              {
                contextId: executionContextId,
                expression: checkoutQuoteCandidateInspectionExpression,
                returnByValue: true,
              },
              sessionId
            )
          );
          return checkoutQuoteCandidateSchema.parse(response.result.value);
        })
      )
    ).flat();
  } catch {
    return [];
  }
}

const checkoutQuoteCandidateInspectionExpression = `(() => {
  const visible = (element) => {
    if (!(element instanceof HTMLElement)) return false;
    const style = getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden" && element.getClientRects().length > 0;
  };
  const candidates = new Map();
  for (const element of document.querySelectorAll("body *")) {
    if (!visible(element)) continue;
    const submit = element.matches('button, input[type="submit"]');
    if (submit && (element.disabled || element.getAttribute("aria-disabled") === "true")) continue;
    const text = (element.innerText || element.value || element.getAttribute("aria-label") || "")
      .normalize("NFKC").replace(/\\s+/g, " ").trim();
    if (!/\\d/u.test(text) || text.length === 0 || text.length > 500) continue;
    if (!submit && Array.from(element.children).some((child) => {
      const childText = (child.innerText || child.getAttribute("aria-label") || "")
        .normalize("NFKC").replace(/\\s+/g, " ").trim();
      return /\\d/u.test(childText) && /(?:grand|order|final)?\\s*total|amount\\s+due|payable/iu.test(childText);
    })) continue;
    const hint = [
      element.id,
      element.getAttribute("data-testid"),
      element.getAttribute("aria-label"),
    ].filter(Boolean).join(" ").slice(0, 500);
    const kind = submit ? "submit" : "text";
    candidates.set(kind + "\\u0000" + hint + "\\u0000" + text, { hint, kind, text });
    if (candidates.size >= 500) break;
  }
  return Array.from(candidates.values());
})()`;

async function readVisibleCheckoutText(
  connection: CdpConnection,
  sessionId: string
) {
  try {
    await connection.send("Page.enable", undefined, sessionId);
    const { frameTree } = frameTreeSchema.parse(
      await connection.send("Page.getFrameTree", undefined, sessionId)
    );
    return (
      await Promise.all(
        flattenFrames(frameTree).map(async ({ id: frameId }) => {
          const { executionContextId } = isolatedWorldSchema.parse(
            await connection.send(
              "Page.createIsolatedWorld",
              { frameId, worldName: "open-instinct-checkout-validation" },
              sessionId
            )
          );
          const response = evaluatedStringSchema.parse(
            await connection.send(
              "Runtime.evaluate",
              {
                contextId: executionContextId,
                expression: '(document.body?.innerText || "").slice(0, 250000)',
                returnByValue: true,
              },
              sessionId
            )
          );
          return response.result.value;
        })
      )
    ).join("\n");
  } catch {
    return "";
  }
}

async function findCheckoutSubmitTargets(
  connection: CdpConnection,
  sessionIds: readonly string[],
  submitLabel: string,
  currentAmount: number,
  currency: string
) {
  const targets: { executionContextId: number; sessionId: string }[] = [];
  if (!isSafeCheckoutSubmitLabel(submitLabel, currentAmount, currency)) {
    return targets;
  }
  for (const sessionId of sessionIds) {
    try {
      await connection.send("Page.enable", undefined, sessionId);
      const { frameTree } = frameTreeSchema.parse(
        await connection.send("Page.getFrameTree", undefined, sessionId)
      );
      for (const { id: frameId } of flattenFrames(frameTree)) {
        const { executionContextId } = isolatedWorldSchema.parse(
          await connection.send(
            "Page.createIsolatedWorld",
            { frameId, worldName: "open-instinct-checkout-submit" },
            sessionId
          )
        );
        const response = evaluatedNumberSchema.parse(
          await connection.send(
            "Runtime.evaluate",
            {
              contextId: executionContextId,
              expression: checkoutSubmitCandidateExpression(submitLabel, false),
              returnByValue: true,
            },
            sessionId
          )
        );
        for (let index = 0; index < response.result.value; index += 1) {
          targets.push({ executionContextId, sessionId });
        }
      }
    } catch {
      continue;
    }
  }
  return targets;
}

async function clickCheckoutSubmit(
  connection: CdpConnection,
  sessionIds: readonly string[],
  submitLabel: string,
  currentAmount: number,
  currency: string
) {
  const targets = await findCheckoutSubmitTargets(
    connection,
    sessionIds,
    submitLabel,
    currentAmount,
    currency
  );
  const target = targets[0];
  if (targets.length !== 1 || !target) return false;
  const response = checkoutSubmitSchema.parse(
    await connection.send(
      "Runtime.evaluate",
      {
        contextId: target.executionContextId,
        expression: checkoutSubmitCandidateExpression(submitLabel, true),
        returnByValue: true,
      },
      target.sessionId
    )
  );
  return response.result.value;
}

function checkoutSubmitCandidateExpression(
  submitLabel: string,
  click: boolean
) {
  return `(() => {
  const expectedLabel = ${JSON.stringify(normalizeCheckoutText(submitLabel))};
  const controls = Array.from(document.querySelectorAll('button, input[type="submit"]'));
  const candidates = controls.filter((element) => {
    if (element.disabled || element.getAttribute("aria-disabled") === "true") return false;
    const style = getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || element.getClientRects().length === 0) return false;
    const label = (element.innerText || element.value || element.getAttribute("aria-label") || "")
      .normalize("NFKC").toLowerCase().replace(/\\s+/g, " ").trim();
    return label === expectedLabel;
  });
  if (!${String(click)}) return candidates.length;
  if (candidates.length !== 1) return false;
  candidates[0].click();
  return true;
})()`;
}

async function readKernelOrderConfirmation(
  browserSessionId: string,
  signal?: AbortSignal
) {
  return withKernelPage(
    browserSessionId,
    signal,
    async ({ connection, origin, sessionId }) => {
      for (const id of sessionId) {
        try {
          await connection.send("Page.enable", undefined, id);
          const { frameTree } = frameTreeSchema.parse(
            await connection.send("Page.getFrameTree", undefined, id)
          );
          for (const { id: frameId, url } of flattenFrames(frameTree)) {
            const { executionContextId } = isolatedWorldSchema.parse(
              await connection.send(
                "Page.createIsolatedWorld",
                {
                  frameId,
                  worldName: "open-instinct-order-confirmation",
                },
                id
              )
            );
            const response = evaluatedValueSchema.parse(
              await connection.send(
                "Runtime.evaluate",
                {
                  contextId: executionContextId,
                  expression: orderConfirmationInspectionExpression,
                  returnByValue: true,
                },
                id
              )
            );
            const inspected = orderConfirmationSchema.parse(
              response.result.value
            );
            const confirmationUrl = isConfirmationUrl(url);
            if (
              inspected.orderIdentifier ||
              (confirmationUrl && inspected.confirmationText)
            ) {
              return {
                confirmed: true as const,
                orderIdentifier: inspected.orderIdentifier,
                origin,
              };
            }
          }
        } catch {
          continue;
        }
      }
      return { confirmed: false as const, orderIdentifier: null, origin };
    }
  );
}

const orderConfirmationInspectionExpression = `(() => {
  const text = (document.body?.innerText || "").slice(0, 250000);
  const identifierMatch = text.match(/(?:order|confirmation|receipt)\\s*(?:number|no\\.?|id|#|reference)?\\s*[:#]?\\s*([A-Z0-9][A-Z0-9_-]{4,})/i);
  return {
    confirmationText: /(?:thank you for your (?:order|purchase)|order (?:is )?confirmed|payment (?:was )?(?:successful|complete)|purchase complete)/i.test(text),
    orderIdentifier: identifierMatch?.[1] || null,
  };
})()`;

function isConfirmationUrl(value: string) {
  try {
    return /(?:success|thank|confirm(?:ation|ed)?|complete|receipt|order[-_]?confirmed)/iu.test(
      new URL(value).pathname
    );
  } catch {
    return false;
  }
}

function isStripeUrl(value: string) {
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return hostname === "stripe.com" || hostname.endsWith(".stripe.com");
  } catch {
    return false;
  }
}

function isStripeAccountId(value: string | null) {
  return value !== null && /^acct_[a-zA-Z0-9]+$/u.test(value);
}

function normalizeCheckoutText(value: string) {
  return value.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim();
}

type CheckoutQuoteCandidate = z.infer<
  typeof checkoutQuoteCandidateSchema
>[number];

const finalTotalSemantics =
  /(?:^|[\s:_-])(?:grand[\s_-]+total|order[\s_-]+total|final[\s_-]+total|amount[\s_-]+due|total[\s_-]+due|amount[\s_-]+payable|total[\s_-]+payable|payable[\s_-]+now|due[\s_-]+(?:today|now)|total)(?:[\s:$]|$)/iu;
const nonFinalTotalSemantics =
  /(?:sub[\s_-]*total|item(?:s)?[\s_-]+total|line[\s_-]+total|unit[\s_-]+price|price[\s_-]+per|(?:tax|shipping|discount|savings)[\s_-]+total|total[\s_-]+(?:tax|shipping|discount|savings|items?))/iu;
const paymentSubmitSemantics =
  /(?:^|\b)(?:pay(?:\s+now)?|place\s+order|submit\s+order|complete\s+order|confirm\s+order|buy(?:\s+now)?|purchase)(?:\b|$)/iu;

export function checkoutQuoteCandidatesMatchAmount(
  candidates: readonly CheckoutQuoteCandidate[],
  amount: number,
  currency: string
) {
  const finalCandidates = candidates.filter((candidate) => {
    if (candidate.kind === "submit") {
      const parsed = monetaryMinorAmounts(candidate.text, currency);
      return parsed.ambiguous || parsed.amounts.size > 0;
    }
    const context = normalizeCheckoutText(
      `${candidate.hint} ${candidate.text}`
    );
    return (
      finalTotalSemantics.test(context) && !nonFinalTotalSemantics.test(context)
    );
  });
  if (finalCandidates.length === 0) return false;

  return finalCandidates.every((candidate) => {
    const parsed = monetaryMinorAmounts(candidate.text, currency);
    return (
      !parsed.ambiguous &&
      parsed.amounts.size === 1 &&
      parsed.amounts.has(amount)
    );
  });
}

export function isSafeCheckoutSubmitLabel(
  submitLabel: string,
  currentAmount: number,
  currency: string
) {
  const parsed = monetaryMinorAmounts(submitLabel, currency);
  if (parsed.ambiguous || parsed.amounts.size > 1) return false;
  if (parsed.amounts.size === 1) return parsed.amounts.has(currentAmount);
  return paymentSubmitSemantics.test(normalizeCheckoutText(submitLabel));
}

function monetaryMinorAmounts(value: string, currency: string) {
  const currencyCode = currency.trim().toUpperCase();
  const formatter = new Intl.NumberFormat("en-US", {
    currency: currencyCode,
    currencyDisplay: "narrowSymbol",
    style: "currency",
  });
  const fractionDigits = formatter.resolvedOptions().maximumFractionDigits ?? 2;
  const scale = 10 ** fractionDigits;
  const currencySymbol =
    formatter.formatToParts(0).find(({ type }) => type === "currency")?.value ??
    currencyCode;
  const normalized = value.normalize("NFKC");
  const amountPattern = /(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,3}))?/gu;
  const amounts = new Set<number>();
  let ambiguous = false;

  for (const match of normalized.matchAll(amountPattern)) {
    const token = match[0];
    const fraction = match[1];
    const index = match.index;
    const before = normalized.slice(Math.max(0, index - 16), index);
    const after = normalized.slice(
      index + token.length,
      index + token.length + 16
    );
    if (/^\s*%/u.test(after)) continue;

    const hasCurrency =
      endsWithCurrency(before, currencyCode, currencySymbol) ||
      startsWithCurrency(after, currencyCode, currencySymbol);
    const decimalLooksMonetary =
      fractionDigits > 0 && fraction?.length === fractionDigits;
    if (!hasCurrency && !decimalLooksMonetary) continue;
    if (fraction !== undefined && fraction.length > fractionDigits) {
      ambiguous = true;
      continue;
    }

    const integer = Number.parseInt(
      token.split(".")[0]?.replaceAll(",", "") ?? "",
      10
    );
    if (!Number.isSafeInteger(integer)) {
      ambiguous = true;
      continue;
    }
    const minorFraction = (fraction ?? "").padEnd(fractionDigits, "0");
    const minor = integer * scale + Number.parseInt(minorFraction || "0", 10);
    if (!Number.isSafeInteger(minor) || minor <= 0) {
      ambiguous = true;
      continue;
    }
    const negative = /-\s*$/u.test(
      before
        .replace(
          new RegExp(`${escapeRegularExpression(currencyCode)}\\s*$`, "iu"),
          ""
        )
        .replace(
          new RegExp(`${escapeRegularExpression(currencySymbol)}\\s*$`, "u"),
          ""
        )
    );
    amounts.add(negative ? -minor : minor);
  }

  return { ambiguous, amounts };
}

function endsWithCurrency(
  value: string,
  currencyCode: string,
  currencySymbol: string
) {
  return new RegExp(
    `(?:${escapeRegularExpression(currencyCode)}|${escapeRegularExpression(currencySymbol)})\\s*$`,
    "iu"
  ).test(value);
}

function startsWithCurrency(
  value: string,
  currencyCode: string,
  currencySymbol: string
) {
  return new RegExp(
    `^\\s*(?:${escapeRegularExpression(currencyCode)}|${escapeRegularExpression(currencySymbol)})(?:\\b|\\s|$)`,
    "iu"
  ).test(value);
}

function escapeRegularExpression(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function abortableDelay(milliseconds: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(resolve, milliseconds);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout);
        reject(
          signal.reason instanceof Error
            ? signal.reason
            : new Error("The checkout operation was aborted.")
        );
      },
      { once: true }
    );
  });
}

async function withKernelPage<T>(
  browserSessionId: string,
  signal: AbortSignal | undefined,
  operation: (page: {
    readonly connection: CdpConnection;
    readonly origin: string;
    readonly sessionId: readonly string[];
  }) => Promise<T>
) {
  const browser = await new Kernel({
    apiKey: env.KERNEL_API_KEY,
  }).browsers.retrieve(browserSessionId, {}, { signal });
  const connection = await CdpConnection.connect(browser.cdp_ws_url, signal);

  try {
    const { targetInfos } = targetListSchema.parse(
      await connection.send("Target.getTargets")
    );
    const target = targetInfos.findLast(
      ({ type, url }) => type === "page" && isWebUrl(url)
    );
    if (!target) throw new Error("No active browser tab was found.");

    const { sessionId: pageSessionId } = attachedTargetSchema.parse(
      await connection.send("Target.attachToTarget", {
        flatten: true,
        targetId: target.targetId,
      })
    );
    const sessionIds = [pageSessionId];
    try {
      await connection.send("Page.enable", undefined, pageSessionId);
      const { frameTree } = frameTreeSchema.parse(
        await connection.send("Page.getFrameTree", undefined, pageSessionId)
      );
      const frameIds = new Set(flattenFrames(frameTree).map(({ id }) => id));
      const iframeTargets = targetInfos.filter(
        ({ targetId, type }) => type === "iframe" && frameIds.has(targetId)
      );
      for (const iframeTarget of iframeTargets) {
        const attached = attachedTargetSchema.safeParse(
          await connection
            .send("Target.attachToTarget", {
              flatten: true,
              targetId: iframeTarget.targetId,
            })
            .catch(() => undefined)
        );
        if (attached.success) sessionIds.push(attached.data.sessionId);
      }

      return await operation({
        connection,
        origin: new URL(target.url).origin,
        sessionId: sessionIds,
      });
    } finally {
      await Promise.all(
        sessionIds.map((sessionId) =>
          connection
            .send("Target.detachFromTarget", { sessionId })
            .catch(() => undefined)
        )
      );
    }
  } finally {
    connection.close();
  }
}

class CdpConnection {
  readonly #pending = new Map<
    number,
    {
      readonly reject: (reason?: unknown) => void;
      readonly resolve: (value: unknown) => void;
    }
  >();
  #nextId = 1;

  private constructor(
    private readonly socket: WebSocket,
    signal: AbortSignal | undefined
  ) {
    socket.addEventListener("message", (event) => {
      this.#onMessage(event);
    });
    socket.addEventListener("close", () => {
      this.#rejectPending(new Error("The Kernel CDP connection closed."));
    });
    signal?.addEventListener(
      "abort",
      () => {
        this.close();
      },
      { once: true }
    );
  }

  static async connect(url: string, signal?: AbortSignal) {
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        socket.removeEventListener("open", onOpen);
        socket.removeEventListener("error", onError);
        signal?.removeEventListener("abort", onAbort);
      };
      const onOpen = () => {
        cleanup();
        resolve();
      };
      const onError = () => {
        cleanup();
        reject(new Error("Could not connect to the Kernel browser over CDP."));
      };
      const onAbort = () => {
        cleanup();
        socket.close();
        reject(
          signal?.reason instanceof Error
            ? signal.reason
            : new Error("The CDP connection was aborted.")
        );
      };
      socket.addEventListener("open", onOpen, { once: true });
      socket.addEventListener("error", onError, { once: true });
      signal?.addEventListener("abort", onAbort, { once: true });
    });
    return new CdpConnection(socket, signal);
  }

  send(method: string, params?: object, sessionId?: string) {
    const id = this.#nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`Chromium did not respond to ${method}.`));
      }, 15_000);
      this.#pending.set(id, {
        reject(reason) {
          clearTimeout(timeout);
          reject(
            reason instanceof Error
              ? reason
              : new Error("The Chromium command failed.")
          );
        },
        resolve(value) {
          clearTimeout(timeout);
          resolve(value);
        },
      });
      this.socket.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }

  close() {
    this.socket.close();
  }

  #onMessage(event: MessageEvent) {
    if (typeof event.data !== "string") return;
    let rawMessage: unknown;
    try {
      rawMessage = JSON.parse(event.data);
    } catch {
      return;
    }
    const message = cdpResponseSchema.safeParse(rawMessage);
    if (!message.success || message.data.id === undefined) return;
    const pending = this.#pending.get(message.data.id);
    if (!pending) return;
    this.#pending.delete(message.data.id);
    if (message.data.error) {
      pending.reject(new Error(message.data.error.message));
    } else {
      pending.resolve(message.data.result);
    }
  }

  #rejectPending(error: Error) {
    for (const { reject } of this.#pending.values()) reject(error);
    this.#pending.clear();
  }
}

const cdpResponseSchema = z.object({
  error: z.object({ message: z.string() }).optional(),
  id: z.number().int().optional(),
  result: z.unknown().optional(),
});

function flattenFrames(
  node: z.infer<typeof frameTreeNodeSchema>
): { readonly id: string; readonly url: string }[] {
  return [
    node.frame,
    ...(node.childFrames ?? []).flatMap((child) => flattenFrames(child)),
  ];
}

function standardAutocomplete(
  kind: "address" | "contact" | "payment",
  autocomplete: string
) {
  const token = autocomplete
    .toLowerCase()
    .split(/\s+/u)
    .findLast((value) => Boolean(value));
  if (!token) return false;
  if (kind === "payment") return token.startsWith("cc-");
  if (kind === "contact") return ["name", "email", "tel"].includes(token);
  return [
    "name",
    "email",
    "tel",
    "street-address",
    "address-line1",
    "address-line2",
    "address-line3",
    "address-level1",
    "address-level2",
    "postal-code",
    "country",
    "country-name",
  ].includes(token);
}

function requiredClaim(values: ReadonlyMap<string, string>, token: string) {
  const value = values.get(token);
  if (!value)
    throw new Error("The saved payment card is incomplete or invalid.");
  return value;
}

function isWebUrl(value: string) {
  try {
    return ["http:", "https:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}
