import { randomUUID } from "node:crypto";
import { ensureScope } from "@/db/services/scope";
import { selectGatewayModel } from "@/db/services/settings";
import {
  createVaultItem as insertVaultItem,
  deleteVaultItem,
} from "@/db/services/vault";
import type { AccessScope } from "../../access-scope";
import { getGoogleWorkspaceConnection } from "../../google-workspace/server";
import { getLinkWalletConnection } from "../../link-wallet/server";
import { getModelSettings } from "../../model-config";
import type { ManagerMutation, ManagerSnapshot } from "..";
import { maskLinkWalletAccountLabel } from "../link-wallet";
import { parsePaymentCardSecret, paymentCardBrand } from "../payment-card";
import { loginAccountHint, parseLoginVaultPayload } from "../vault-payload";
import { deleteSecret, secretStoreStatus, writeSecret } from "./secret-store";
import { readManagerVaultItems } from "./vault";

export async function readManagerSnapshot(scope: AccessScope) {
  const [googleWorkspace, linkWallet, vaultRows, modelSettings] =
    await Promise.all([
      getGoogleWorkspaceConnection(scope),
      getLinkWalletConnection(scope),
      readManagerVaultItems(scope),
      getModelSettings(scope),
    ]);

  return {
    browser: { available: true },
    googleWorkspace,
    linkWallet: toManagerLinkWalletSnapshot(linkWallet),
    runtime: { inference: modelSettings.modelId },
    secretStore: secretStoreStatus(),
    vaultItems: vaultRows,
  };
}

function toManagerLinkWalletSnapshot(
  connection: Awaited<ReturnType<typeof getLinkWalletConnection>>
): ManagerSnapshot["linkWallet"] {
  switch (connection.state) {
    case "connected":
      return {
        accountLabel: maskLinkWalletAccountLabel(connection.accountLabel),
        state: "connected",
      };
    case "pending":
      return { accountLabel: null, state: "connecting" };
    case "reauthentication-required":
      return { accountLabel: null, state: "reauthentication-required" };
    case "unavailable":
      return { accountLabel: null, state: "unavailable" };
    case "disconnected":
      return { accountLabel: null, state: "disconnected" };
  }
}

export async function applyManagerMutation(
  scope: AccessScope,
  mutation: ManagerMutation
) {
  await ensureScope(scope);

  switch (mutation.action) {
    case "model.select":
      await selectGatewayModel(scope, mutation.modelId);
      break;
    case "vault.create":
      await createVaultItem(scope, mutation.input);
      break;
    case "vault.import":
      for (const item of mutation.items) await createVaultItem(scope, item);
      break;
    case "vault.delete":
      await removeVaultItem(scope, mutation.id);
      break;
  }

  return readManagerSnapshot(scope);
}

async function createVaultItem(
  scope: AccessScope,
  input: Extract<ManagerMutation, { action: "vault.create" }>["input"]
) {
  const id = randomUUID();
  const now = new Date().toISOString();
  await writeSecret({ id, namespace: "vault", scope, value: input.secret });

  try {
    await insertVaultItem(scope, {
      account: vaultAccountHint(input),
      createdAt: now,
      id,
      kind: input.kind,
      label: input.label,
      updatedAt: now,
    });
  } catch (error) {
    await deleteSecret({ id, namespace: "vault", scope });
    throw error;
  }
}

function vaultAccountHint(
  input: Extract<ManagerMutation, { action: "vault.create" }>["input"]
) {
  switch (input.kind) {
    case "login": {
      const payload = parseLoginVaultPayload(input.secret);
      if (!payload)
        throw new Error("The saved login is incomplete or invalid.");
      return loginAccountHint(
        payload.identifier,
        "origin" in payload ? payload.origin : undefined
      );
    }
    case "payment": {
      const card = parsePaymentCardSecret(input.secret);
      return `${paymentCardBrand(card.number)} · •••• ${card.number.slice(-4)}`;
    }
    case "address":
    case "contact":
      return "";
  }
}

async function removeVaultItem(scope: AccessScope, id: string) {
  const deleted = await deleteVaultItem(scope, id);
  if (!deleted) return;
  await deleteSecret({ id, namespace: "vault", scope });
}
