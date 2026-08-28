/* oxlint-disable promise/no-callback-in-promise, typescript/no-confusing-void-expression, typescript/no-unsafe-type-assertion, vitest/require-mock-type-parameters -- The child-process fake verifies callback output isolation and temporary-file behavior. */
import { access, lstat, writeFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import type { AccessScope } from "../lib/access-scope";

const mocks = vi.hoisted(() => ({
  deleteSecret: vi.fn().mockResolvedValue(undefined),
  execFile: vi.fn(),
  readSecret: vi.fn().mockResolvedValue(undefined),
  writeSecret: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("node:child_process", () => ({ execFile: mocks.execFile }));
vi.mock("../lib/manager/server/secret-store", () => ({
  deleteSecret: mocks.deleteSecret,
  readSecret: mocks.readSecret,
  writeSecret: mocks.writeSecret,
}));

describe("Link CLI process isolation", () => {
  it("never attaches credential-bearing stdout to thrown errors", async () => {
    let directoryPath: string | undefined;
    let childEnvironment: NodeJS.ProcessEnv | undefined;
    mocks.execFile.mockImplementation(
      (
        _file: string,
        _arguments: string[],
        options: { env: NodeJS.ProcessEnv },
        callback: (error: Error, stdout: string) => void
      ) => {
        childEnvironment = options.env;
        callback(
          Object.assign(new Error("provider failed"), { code: "EPIPE" }),
          JSON.stringify({
            card: { cvc: "123", number: "4242424242424242" },
            link_pay_token: "lpt_never_log_this",
          })
        );
        return {};
      }
    );
    vi.stubEnv("DATABASE_URL", "postgres://should-not-inherit");
    vi.stubEnv("KERNEL_API_KEY", "kernel-should-not-inherit");

    const { withLinkCliSession } = await import("../lib/link-wallet/cli");
    const scope: AccessScope = { userId: "user-1", workspaceId: "workspace-1" };
    let failure: unknown;
    try {
      await withLinkCliSession(scope, {} as never, async (session) => {
        directoryPath = session.directoryPath;
        await session.run(["auth", "status"]);
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe(
      "Link could not complete the request safely."
    );
    expect(JSON.stringify(failure)).not.toContain("lpt_never_log_this");
    expect(JSON.stringify(failure)).not.toContain("4242424242424242");
    expect(failure).not.toHaveProperty("capturedStdout");
    expect(childEnvironment).not.toHaveProperty("DATABASE_URL");
    expect(childEnvironment).not.toHaveProperty("KERNEL_API_KEY");
    if (!directoryPath) throw new Error("Expected a temporary directory.");
    await expect(access(directoryPath)).rejects.toThrow(/ENOENT/u);
  });

  it("persists refreshed auth from a 0600 random temporary file and cleans it up", async () => {
    let directoryPath: string | undefined;
    let authFilePath: string | undefined;
    mocks.execFile.mockImplementation(
      (
        _file: string,
        arguments_: string[],
        _options: unknown,
        callback: (error: Error | null, stdout: string) => void
      ) => {
        const path = arguments_.at(arguments_.indexOf("--auth") + 1);
        if (!path) throw new Error("Expected a Link auth-file argument.");
        void writeFile(
          path,
          JSON.stringify({ refresh_token: "refresh-secret" }),
          {
            flag: "wx",
            mode: 0o600,
          }
        ).then(() => callback(null, JSON.stringify([{ authenticated: true }])));
        return {};
      }
    );

    const { withLinkCliSession } = await import("../lib/link-wallet/cli");
    const scope: AccessScope = { userId: "user-1", workspaceId: "workspace-1" };
    await withLinkCliSession(scope, {} as never, async (session) => {
      directoryPath = session.directoryPath;
      authFilePath = session.authFilePath;
      await session.run(["auth", "status"]);
      expect((await lstat(session.directoryPath)).mode & 0o077).toBe(0);
      expect((await lstat(session.authFilePath)).mode & 0o077).toBe(0);
    });

    expect(mocks.writeSecret).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "auth",
        namespace: "link",
        value: JSON.stringify({ refresh_token: "refresh-secret" }),
      })
    );
    if (!directoryPath || !authFilePath) {
      throw new Error("Expected Link temporary paths to be captured.");
    }
    await expect(access(directoryPath)).rejects.toThrow(/ENOENT/u);
    await expect(access(authFilePath)).rejects.toThrow(/ENOENT/u);
  });
});
