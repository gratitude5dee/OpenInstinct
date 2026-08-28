import type { LinkWalletConnection } from "@/lib/link-wallet";

const MASK_MARKER = /(?:\u2022{2,}|\*{2,}|\u2026)/u;

/**
 * Keep Link account metadata useful in the workspace without trusting a
 * provider response to have already removed personally identifying details.
 */
export function maskLinkWalletAccountLabel(label: string | undefined) {
  const value = label?.trim();
  if (!value) return null;
  if (MASK_MARKER.test(value)) return value.slice(0, 200);
  if (value.toLowerCase() === "link account") return "Link account";

  const at = value.lastIndexOf("@");
  if (at > 0 && at < value.length - 1) {
    const domain = value
      .slice(at + 1)
      .trim()
      .toLowerCase();
    if (/^[a-z\d](?:[a-z\d.-]{0,251}[a-z\d])?$/i.test(domain)) {
      return `\u2022\u2022\u2022@${domain}`.slice(0, 200);
    }
  }

  const digits = value.replace(/\D/gu, "");
  if (digits.length >= 4) return `\u2022\u2022\u2022\u2022 ${digits.slice(-4)}`;

  return "Link account";
}

export function toSafeLinkWalletConnection(
  connection: LinkWalletConnection
): LinkWalletConnection {
  switch (connection.state) {
    case "connected": {
      const accountLabel = maskLinkWalletAccountLabel(connection.accountLabel);
      return {
        ...(accountLabel ? { accountLabel } : {}),
        state: "connected",
      };
    }
    case "pending":
      return {
        phrase: connection.phrase,
        state: "pending",
        verificationUrl: connection.verificationUrl,
      };
    case "unavailable":
      return { reason: connection.reason, state: "unavailable" };
    case "reauthentication-required":
      return { state: "reauthentication-required" };
    case "disconnected":
      return { state: "disconnected" };
  }
}
