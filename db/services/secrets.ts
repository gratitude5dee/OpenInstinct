import { and, eq } from "drizzle-orm";
import type { AccessScope } from "@/lib/access-scope";
import { db, encryptedSecrets } from "@/db";

export type EncryptedSecretNamespace = "link" | "vault";
export type SecretDatabase =
  | typeof db
  | Parameters<Parameters<typeof db.transaction>[0]>[0];

export async function writeEncryptedSecret(
  scope: AccessScope,
  id: string,
  encryptedValue: string,
  namespace: EncryptedSecretNamespace = "vault",
  database: SecretDatabase = db
) {
  const updatedAt = new Date().toISOString();
  await database
    .insert(encryptedSecrets)
    .values({
      encryptedValue,
      id,
      namespace,
      updatedAt,
      workspaceId: scope.workspaceId,
    })
    .onConflictDoUpdate({
      target: [
        encryptedSecrets.workspaceId,
        encryptedSecrets.namespace,
        encryptedSecrets.id,
      ],
      set: { encryptedValue, updatedAt },
    });
}

export async function readEncryptedSecret(
  scope: AccessScope,
  id: string,
  namespace: EncryptedSecretNamespace = "vault",
  database: SecretDatabase = db
) {
  const rows = await database
    .select({ encryptedValue: encryptedSecrets.encryptedValue })
    .from(encryptedSecrets)
    .where(
      and(
        eq(encryptedSecrets.workspaceId, scope.workspaceId),
        eq(encryptedSecrets.namespace, namespace),
        eq(encryptedSecrets.id, id)
      )
    )
    .limit(1);
  return rows[0]?.encryptedValue;
}

export async function deleteEncryptedSecret(
  scope: AccessScope,
  id: string,
  namespace: EncryptedSecretNamespace = "vault",
  database: SecretDatabase = db
) {
  await database
    .delete(encryptedSecrets)
    .where(
      and(
        eq(encryptedSecrets.workspaceId, scope.workspaceId),
        eq(encryptedSecrets.namespace, namespace),
        eq(encryptedSecrets.id, id)
      )
    );
}

export async function deleteEncryptedSecretNamespace(
  scope: AccessScope,
  namespace: EncryptedSecretNamespace,
  database: SecretDatabase = db
) {
  await database
    .delete(encryptedSecrets)
    .where(
      and(
        eq(encryptedSecrets.workspaceId, scope.workspaceId),
        eq(encryptedSecrets.namespace, namespace)
      )
    );
}
