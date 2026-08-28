/* oxlint-disable vitest/require-mock-type-parameters -- In-memory encrypted-secret fakes are configured per test. */
import { createDecipheriv } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AccessScope } from "../lib/access-scope";
import { env } from "../lib/env";

const mocks = vi.hoisted(() => ({
  encrypted: new Map<string, string>(),
}));

vi.mock("../db/services/secrets", () => ({
  deleteEncryptedSecret: vi.fn(
    async (_scope: AccessScope, id: string, namespace: string) => {
      mocks.encrypted.delete(`${namespace}:${id}`);
    }
  ),
  readEncryptedSecret: vi.fn(
    async (_scope: AccessScope, id: string, namespace: string) =>
      mocks.encrypted.get(`${namespace}:${id}`)
  ),
  writeEncryptedSecret: vi.fn(
    async (
      _scope: AccessScope,
      id: string,
      value: string,
      namespace: string
    ) => {
      mocks.encrypted.set(`${namespace}:${id}`, value);
    }
  ),
}));

const scope: AccessScope = { userId: "user-1", workspaceId: "workspace-1" };

beforeEach(() => {
  mocks.encrypted.clear();
});

describe("encrypted Link namespace", () => {
  it("preserves legacy vault AAD while binding new Link secrets to their namespace", async () => {
    const { readSecret, writeSecret } =
      await import("../lib/manager/server/secret-store");
    await writeSecret({
      id: "item-1",
      namespace: "vault",
      scope,
      value: "legacy-vault-value",
    });
    await writeSecret({
      id: "auth",
      namespace: "link",
      scope,
      value: "link-auth-value",
    });

    const vaultCiphertext = mocks.encrypted.get("vault:item-1");
    const linkCiphertext = mocks.encrypted.get("link:auth");
    if (!vaultCiphertext || !linkCiphertext) {
      throw new Error("Expected encrypted test fixtures to be stored.");
    }
    expect(decryptWithAad(vaultCiphertext, "workspace-1\0item-1")).toBe(
      "legacy-vault-value"
    );
    expect(() =>
      decryptWithAad(vaultCiphertext, "workspace-1\0vault\0item-1")
    ).toThrow(/authenticate|state/iu);
    expect(decryptWithAad(linkCiphertext, "workspace-1\0link\0auth")).toBe(
      "link-auth-value"
    );
    expect(() => decryptWithAad(linkCiphertext, "workspace-1\0auth")).toThrow(
      /authenticate|state/iu
    );
    await expect(
      readSecret({ id: "item-1", namespace: "vault", scope })
    ).resolves.toBe("legacy-vault-value");
    await expect(
      readSecret({ id: "auth", namespace: "link", scope })
    ).resolves.toBe("link-auth-value");
  });
});

function decryptWithAad(value: string, aad: string) {
  const [, encodedIv, encodedTag, encodedCiphertext] = value.split(".");
  if (!encodedIv || !encodedTag || !encodedCiphertext) {
    throw new Error("Expected a versioned encrypted test fixture.");
  }
  const decipher = createDecipheriv(
    "aes-256-gcm",
    Buffer.from(env.SECRET_ENCRYPTION_KEY, "base64"),
    Buffer.from(encodedIv, "base64url")
  );
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(Buffer.from(encodedTag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(encodedCiphertext, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}
