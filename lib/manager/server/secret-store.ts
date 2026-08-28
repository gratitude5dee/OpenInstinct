import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import {
  deleteEncryptedSecret,
  readEncryptedSecret,
  writeEncryptedSecret,
  type EncryptedSecretNamespace,
  type SecretDatabase,
} from "@/db/services/secrets";
import type { AccessScope } from "../../access-scope";
import { env } from "@/lib/env";

export function secretStoreStatus() {
  return {
    available: true,
    description:
      "Secrets are encrypted for this workspace before database storage.",
    kind: "Encrypted vault",
  };
}

export async function writeSecret({
  id,
  database,
  namespace,
  scope,
  value,
}: {
  readonly database?: SecretDatabase;
  readonly id: string;
  readonly namespace: EncryptedSecretNamespace;
  readonly scope: AccessScope;
  readonly value: string;
}) {
  await writeEncryptedSecret(
    scope,
    id,
    encryptSecret(scope, namespace, id, value),
    namespace,
    database
  );
}

export async function readSecret({
  database,
  id,
  namespace,
  scope,
}: {
  readonly database?: SecretDatabase;
  readonly id: string;
  readonly namespace: EncryptedSecretNamespace;
  readonly scope: AccessScope;
}) {
  const encrypted = await readEncryptedSecret(scope, id, namespace, database);
  return encrypted ? decryptSecret(scope, namespace, id, encrypted) : undefined;
}

export async function hasSecret({
  database,
  id,
  namespace,
  scope,
}: {
  readonly database?: SecretDatabase;
  readonly id: string;
  readonly namespace: EncryptedSecretNamespace;
  readonly scope: AccessScope;
}) {
  return (
    (await readEncryptedSecret(scope, id, namespace, database)) !== undefined
  );
}

export async function deleteSecret({
  database,
  id,
  namespace,
  scope,
}: {
  readonly database?: SecretDatabase;
  readonly id: string;
  readonly namespace: EncryptedSecretNamespace;
  readonly scope: AccessScope;
}) {
  await deleteEncryptedSecret(scope, id, namespace, database);
}

function encryptSecret(
  scope: AccessScope,
  namespace: EncryptedSecretNamespace,
  id: string,
  value: string
) {
  const iv = randomBytes(12);
  const cipher = createCipheriv(
    "aes-256-gcm",
    Buffer.from(env.SECRET_ENCRYPTION_KEY, "base64"),
    iv
  );
  cipher.setAAD(secretAad(scope, namespace, id));
  const ciphertext = Buffer.concat([
    cipher.update(value, "utf8"),
    cipher.final(),
  ]);
  return [
    "v1",
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

function decryptSecret(
  scope: AccessScope,
  namespace: EncryptedSecretNamespace,
  id: string,
  value: string
) {
  const [version, encodedIv, encodedTag, encodedCiphertext] = value.split(".");
  if (version !== "v1" || !encodedIv || !encodedTag || !encodedCiphertext) {
    throw new Error("The stored secret uses an unsupported format.");
  }

  const decipher = createDecipheriv(
    "aes-256-gcm",
    Buffer.from(env.SECRET_ENCRYPTION_KEY, "base64"),
    Buffer.from(encodedIv, "base64url")
  );
  decipher.setAAD(secretAad(scope, namespace, id));
  decipher.setAuthTag(Buffer.from(encodedTag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(encodedCiphertext, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

function secretAad(
  scope: AccessScope,
  namespace: EncryptedSecretNamespace,
  id: string
) {
  // Vault rows predate namespaces in their authenticated data. Keep that byte
  // sequence stable so every existing one-click deployment can still decrypt
  // its saved vault after Link is added. New namespaces are explicitly bound.
  return Buffer.from(
    namespace === "vault"
      ? `${scope.workspaceId}\u0000${id}`
      : `${scope.workspaceId}\u0000${namespace}\u0000${id}`
  );
}
