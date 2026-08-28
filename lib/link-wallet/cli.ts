import { execFile } from "node:child_process";
import {
  access,
  chmod,
  lstat,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import type { AccessScope } from "@/lib/access-scope";
import type { LinkWalletTransaction } from "@/db/services/link-wallet-lock";
import {
  deleteSecret,
  readSecret,
  writeSecret,
} from "@/lib/manager/server/secret-store";

const AUTH_SECRET_ID = "auth";
const MAX_AUTH_BYTES = 1_048_576;
const MAX_OUTPUT_BYTES = 2_097_152;
const require = createRequire(import.meta.url);

export class LinkCliError extends Error {
  readonly code: string;
  readonly remoteSpendRequestId?: string;
  readonly retryable: boolean;

  constructor(
    code: string,
    options: {
      readonly remoteSpendRequestId?: string;
      readonly retryable?: boolean;
    } = {}
  ) {
    super(safeCliErrorMessage(code));
    this.name = "LinkCliError";
    this.code = code;
    this.remoteSpendRequestId = options.remoteSpendRequestId;
    this.retryable = options.retryable ?? false;
  }
}

export class LinkCliUnavailableError extends Error {
  constructor() {
    super("Link checkout is unavailable on this deployment.");
    this.name = "LinkCliUnavailableError";
  }
}

export interface LinkCliSession {
  readonly authFilePath: string;
  readonly directoryPath: string;
  run(
    arguments_: readonly string[],
    options?: {
      readonly signal?: AbortSignal;
      readonly timeoutMs?: number;
    }
  ): Promise<unknown>;
}

export async function assertLinkCliAvailable() {
  await resolveLinkCliEntry();
}

export async function withLinkCliSession<T>(
  scope: AccessScope,
  transaction: LinkWalletTransaction,
  operation: (session: LinkCliSession) => Promise<T>
) {
  const cliEntry = await resolveLinkCliEntry();
  const directoryPath = await mkdtemp(join(tmpdir(), "openinstinct-link-"));
  try {
    await chmod(directoryPath, 0o700);
    return await runLinkCliSessionInDirectory(
      scope,
      transaction,
      operation,
      cliEntry,
      directoryPath
    );
  } finally {
    await rm(directoryPath, { force: true, recursive: true });
  }
}

async function runLinkCliSessionInDirectory<T>(
  scope: AccessScope,
  transaction: LinkWalletTransaction,
  operation: (session: LinkCliSession) => Promise<T>,
  cliEntry: string,
  directoryPath: string
) {
  const authFilePath = join(directoryPath, "auth.json");
  const storedAuth = await readSecret({
    database: transaction,
    id: AUTH_SECRET_ID,
    namespace: "link",
    scope,
  });
  if (storedAuth !== undefined) {
    if (Buffer.byteLength(storedAuth, "utf8") > MAX_AUTH_BYTES) {
      throw new LinkCliError("INVALID_AUTH_FILE");
    }
    assertJsonObject(storedAuth);
    await writeFile(authFilePath, storedAuth, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await chmod(authFilePath, 0o600);
  }

  const persistAuth = async () => {
    let metadata;
    try {
      metadata = await lstat(authFilePath);
    } catch (error) {
      if (isNodeError(error, "ENOENT")) {
        await deleteSecret({
          database: transaction,
          id: AUTH_SECRET_ID,
          namespace: "link",
          scope,
        });
        return;
      }
      throw error;
    }
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new LinkCliError("INVALID_AUTH_FILE");
    }
    await chmod(authFilePath, 0o600);
    const value = await readFile(authFilePath, "utf8");
    if (Buffer.byteLength(value, "utf8") > MAX_AUTH_BYTES) {
      throw new LinkCliError("INVALID_AUTH_FILE");
    }
    assertJsonObject(value);
    await writeSecret({
      database: transaction,
      id: AUTH_SECRET_ID,
      namespace: "link",
      scope,
      value,
    });
  };

  const session: LinkCliSession = {
    authFilePath,
    directoryPath,
    async run(arguments_, options = {}) {
      try {
        return await executeLinkCli(
          cliEntry,
          authFilePath,
          arguments_,
          options.timeoutMs ?? 20_000,
          options.signal
        );
      } finally {
        await persistAuth();
      }
    },
  };

  return operation(session);
}

async function resolveLinkCliEntry() {
  try {
    const packagePath = require.resolve("@stripe/link-cli/package.json");
    const entry = join(dirname(packagePath), "dist", "cli.js");
    await access(entry);
    return entry;
  } catch {
    throw new LinkCliUnavailableError();
  }
}

async function executeLinkCli(
  cliEntry: string,
  authFilePath: string,
  arguments_: readonly string[],
  timeoutMs: number,
  signal?: AbortSignal
) {
  // oxlint-disable-next-line eslint/no-restricted-properties -- The child receives only explicitly allowlisted non-secret process settings.
  const childEnvironment = linkCliChildEnvironment(process.env);
  Object.assign(childEnvironment, {
    CI: "1",
    LINK_CLI_SKIP_SKILL_INSTALL: "1",
    NO_UPDATE_NOTIFIER: "1",
  });
  let stdout = "";
  let executionError: unknown;
  try {
    stdout = await new Promise<string>((resolve, reject) => {
      execFile(
        process.execPath,
        [cliEntry, "--auth", authFilePath, "--format", "json", ...arguments_],
        {
          encoding: "utf8",
          env: childEnvironment,
          maxBuffer: MAX_OUTPUT_BYTES,
          signal,
          shell: false,
          timeout: timeoutMs,
          windowsHide: true,
        },
        (error: Error | null, output: string) => {
          stdout = output;
          if (error) reject(error);
          else resolve(output);
        }
      );
    });
  } catch (error) {
    executionError = error;
  }

  const parsed = parseCliJson(stdout);
  const possibleError = isUnknownArray(parsed) ? parsed.at(-1) : parsed;
  if (isCliErrorPayload(possibleError)) {
    throw linkCliErrorFromPayload(possibleError);
  }
  if (executionError) {
    if (signal?.aborted) {
      throw new LinkCliError("OPERATION_ABORTED");
    }
    const timedOut =
      isNodeError(executionError, "ETIMEDOUT") ||
      isNodeError(executionError, "ABORT_ERR");
    throw new LinkCliError(timedOut ? "CLI_TIMEOUT" : "CLI_FAILED", {
      retryable: true,
    });
  }
  if (parsed === undefined) throw new LinkCliError("INVALID_CLI_OUTPUT");
  if (isUnknownArray(parsed) && parsed.length === 0) {
    throw new LinkCliError("INVALID_CLI_OUTPUT");
  }
  return parsed;
}

export function linkCliChildEnvironment(
  environment: NodeJS.ProcessEnv
): NodeJS.ProcessEnv {
  const child: NodeJS.ProcessEnv = {
    CI: "1",
    LINK_CLI_SKIP_SKILL_INSTALL: "1",
    NODE_ENV: environment.NODE_ENV,
    NO_UPDATE_NOTIFIER: "1",
  };
  for (const name of [
    "LANG",
    "LC_ALL",
    "TEMP",
    "TMP",
    "TMPDIR",
    "TZ",
  ] as const) {
    if (environment[name]) child[name] = environment[name];
  }
  return child;
}

function parseCliJson(output: string): unknown {
  const trimmed = output.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
}

function isCliErrorPayload(
  value: unknown
): value is { code: string; message?: string; retryable?: boolean } {
  return (
    typeof value === "object" &&
    value !== null &&
    "code" in value &&
    typeof value.code === "string"
  );
}

function linkCliErrorFromPayload(payload: {
  readonly code: string;
  readonly message?: string;
  readonly retryable?: boolean;
}) {
  const upperCode = payload.code.toUpperCase();
  const normalizedCode = /^[A-Z\d_]+$/.test(upperCode) ? upperCode : "UNKNOWN";
  const remoteSpendRequestId = payload.message?.match(
    /\blsrq_[a-zA-Z\d_]+\b/
  )?.[0];
  return new LinkCliError(normalizedCode, {
    remoteSpendRequestId,
    retryable:
      payload.retryable ??
      ["POLLING_TIMEOUT", "RATE_LIMITED", "TEMPORARILY_UNAVAILABLE"].includes(
        normalizedCode
      ),
  });
}

function safeCliErrorMessage(code: string) {
  switch (code) {
    case "NOT_AUTHENTICATED":
    case "INVALID_GRANT":
      return "Link needs to be connected again.";
    case "POLLING_TIMEOUT":
      return "Link is still waiting for approval.";
    case "NOT_FOUND":
      return "The Link spend request was not found.";
    case "INVALID_INPUT":
      return "Link rejected the checkout request details.";
    case "CLI_TIMEOUT":
      return "Link did not respond before this request ended.";
    case "OPERATION_ABORTED":
      return "The Link operation was canceled.";
    case "INVALID_AUTH_FILE":
      return "The stored Link connection could not be read safely.";
    default:
      return "Link could not complete the request safely.";
  }
}

function assertJsonObject(value: string) {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
    ) {
      return;
    }
  } catch {
    // The safe error below intentionally excludes the credential file content.
  }
  throw new LinkCliError("INVALID_AUTH_FILE");
}

function isNodeError(error: unknown, code: string) {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    error.code === code
  );
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}
