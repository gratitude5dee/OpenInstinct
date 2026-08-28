import { describe, expect, it } from "vitest";
import {
  addressPurposeFromAutocomplete,
  checkoutQuoteCandidatesMatchAmount,
  hasCoherentOrdinaryCardFieldGroup,
  isSafeCheckoutSubmitLabel,
  selectAddressPurposeControls,
} from "../lib/manager/server/kernel-native-autofill";

describe("native Link checkout guards", () => {
  it("requires number, expiry, and CVC in one coherent card group", () => {
    expect(
      hasCoherentOrdinaryCardFieldGroup([["number"], ["expiry", "cvc"]])
    ).toBe(false);
    expect(
      hasCoherentOrdinaryCardFieldGroup([["number", "expiry", "cvc"]])
    ).toBe(true);
  });

  it("accepts only an unambiguous final amount matching the current quote", () => {
    expect(
      checkoutQuoteCandidatesMatchAmount(
        [candidate("Order total $8.00")],
        800,
        "usd"
      )
    ).toBe(true);
    expect(
      checkoutQuoteCandidatesMatchAmount(
        [candidate("Amount due USD 8.00")],
        800,
        "usd"
      )
    ).toBe(true);
    expect(
      checkoutQuoteCandidatesMatchAmount(
        [candidate("Final total $12.00")],
        800,
        "usd"
      )
    ).toBe(false);
  });

  it("does not confuse an item price with the payable total", () => {
    expect(
      checkoutQuoteCandidatesMatchAmount(
        [
          { hint: "line-item", kind: "text", text: "Widget $8.00" },
          candidate("Order total $12.00"),
        ],
        800,
        "usd"
      )
    ).toBe(false);
    expect(
      checkoutQuoteCandidatesMatchAmount(
        [candidate("Order total $8.00, previously $10.00")],
        800,
        "usd"
      )
    ).toBe(false);
    expect(
      checkoutQuoteCandidatesMatchAmount(
        [{ hint: "line-item", kind: "text", text: "Widget $8.00" }],
        800,
        "usd"
      )
    ).toBe(false);
  });

  it("allows lower final charges when the worker supplies that exact amount", () => {
    expect(
      checkoutQuoteCandidatesMatchAmount(
        [candidate("Total payable $9.00")],
        900,
        "usd"
      )
    ).toBe(true);
    expect(
      checkoutQuoteCandidatesMatchAmount(
        [candidate("Total payable $9.00")],
        1_000,
        "usd"
      )
    ).toBe(false);
  });

  it("rejects non-payment submit labels unless they contain the exact total", () => {
    expect(isSafeCheckoutSubmitLabel("Continue", 800, "usd")).toBe(false);
    expect(isSafeCheckoutSubmitLabel("Pay now", 800, "usd")).toBe(true);
    expect(isSafeCheckoutSubmitLabel("Place order", 800, "usd")).toBe(true);
    expect(isSafeCheckoutSubmitLabel("Continue — $8.00", 800, "usd")).toBe(
      true
    );
    expect(isSafeCheckoutSubmitLabel("Continue — $9.00", 800, "usd")).toBe(
      false
    );
    expect(isSafeCheckoutSubmitLabel("Pay $9.00", 800, "usd")).toBe(false);
  });

  it("requires explicit and unambiguous address-section ownership", () => {
    expect(
      addressPurposeFromAutocomplete("section-cart shipping address-line1")
    ).toBe("shipping");
    expect(addressPurposeFromAutocomplete("billing postal-code")).toBe(
      "billing"
    );
    expect(
      addressPurposeFromAutocomplete("billing shipping address-line1")
    ).toBe("ambiguous");

    const billing = addressControl("billing", false, 0);
    const shipping = addressControl("shipping", false, 1);
    const controls = [billing, shipping];
    expect(selectAddressPurposeControls(controls, "billing")).toEqual([
      billing,
    ]);
    expect(() => selectAddressPurposeControls(controls)).toThrow(
      "Both billing and shipping forms are visible"
    );
    expect(
      selectAddressPurposeControls([billing, { ...shipping, focused: true }])
    ).toEqual([{ ...shipping, focused: true }]);
    expect(() => selectAddressPurposeControls([shipping], "billing")).toThrow(
      "No visible billing address form"
    );
  });
});

function candidate(text: string) {
  return { hint: "order-summary", kind: "text" as const, text };
}

function addressControl(
  addressPurpose: "billing" | "shipping",
  focused: boolean,
  formIndex: number
) {
  return {
    addressPurpose,
    focused,
    formIndex,
    frameId: "frame-1",
  };
}
