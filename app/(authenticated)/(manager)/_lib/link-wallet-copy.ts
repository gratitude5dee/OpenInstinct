import type { ManagerSnapshot } from "@/lib/manager";

type LinkWalletSnapshot = ManagerSnapshot["linkWallet"];

export function linkWalletDescription(connection: LinkWalletSnapshot) {
  switch (connection.state) {
    case "connected":
      return connection.accountLabel ?? "Link Wallet connected.";
    case "connecting":
      return "Finish verification in Link to connect this workspace.";
    case "reauthentication-required":
      return "Reconnect Link to keep browser checkout available.";
    case "unavailable":
      return "Link Wallet is unavailable in this deployment.";
    case "disconnected":
      return "Use saved Link payment and contact details during browser checkouts.";
  }
}

export function linkWalletActionLabel(state: LinkWalletSnapshot["state"]) {
  switch (state) {
    case "connected":
      return "Manage";
    case "connecting":
      return "Continue";
    case "reauthentication-required":
      return "Reconnect";
    case "unavailable":
      return "Unavailable";
    case "disconnected":
      return "Connect";
  }
}
