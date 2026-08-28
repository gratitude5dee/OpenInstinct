import { sql } from "drizzle-orm";
import type { AccessScope } from "@/lib/access-scope";
import { db } from "@/db";

export type LinkWalletTransaction = Parameters<
  Parameters<typeof db.transaction>[0]
>[0];

export async function withLinkWalletWorkspaceLock<T>(
  scope: AccessScope,
  operation: (transaction: LinkWalletTransaction) => Promise<T>
) {
  return db.transaction(async (transaction) => {
    await transaction.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`openinstinct:link:${scope.workspaceId}`}, 0))`
    );
    return operation(transaction);
  });
}
