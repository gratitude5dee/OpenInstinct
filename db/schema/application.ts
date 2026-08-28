import { sql } from "drizzle-orm";
import {
  check,
  doublePrecision,
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const workspaces = pgTable("workspaces", {
  id: text("id").primaryKey(),
  createdAt: text("created_at").notNull(),
});

export const workspaceMemberships = pgTable(
  "workspace_memberships",
  {
    workspaceId: text("workspace_id").notNull(),
    userId: text("user_id").notNull(),
    role: text("role").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.workspaceId, table.userId],
      name: "workspace_memberships_pkey",
    }),
    foreignKey({
      name: "workspace_memberships_workspace_id_fkey",
      columns: [table.workspaceId],
      foreignColumns: [workspaces.id],
    }).onDelete("cascade"),
    check("workspace_memberships_role_check", sql`${table.role} = 'owner'`),
  ]
);

export const vaultItems = pgTable(
  "vault_items",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    kind: text("kind").notNull(),
    label: text("label").notNull(),
    account: text("account").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    foreignKey({
      name: "vault_items_workspace_id_fkey",
      columns: [table.workspaceId],
      foreignColumns: [workspaces.id],
    }).onDelete("cascade"),
    check(
      "vault_items_kind_check",
      sql`${table.kind} IN ('login', 'payment', 'address', 'contact', 'phone', 'identity', 'token')`
    ),
    index("vault_items_workspace_updated_idx").on(
      table.workspaceId,
      table.updatedAt.desc().nullsFirst()
    ),
  ]
);

export const settings = pgTable(
  "settings",
  {
    workspaceId: text("workspace_id").notNull(),
    key: text("key").notNull(),
    value: text("value").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.workspaceId, table.key],
      name: "settings_pkey",
    }),
    foreignKey({
      name: "settings_workspace_id_fkey",
      columns: [table.workspaceId],
      foreignColumns: [workspaces.id],
    }).onDelete("cascade"),
    check("settings_key_check", sql`${table.key} = 'gateway_model'`),
  ]
);

export const agentSessions = pgTable(
  "agent_sessions",
  {
    sessionId: text("session_id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    createdByUserId: text("created_by_user_id").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    foreignKey({
      name: "agent_sessions_membership_fkey",
      columns: [table.workspaceId, table.createdByUserId],
      foreignColumns: [
        workspaceMemberships.workspaceId,
        workspaceMemberships.userId,
      ],
    }).onDelete("cascade"),
    index("agent_sessions_workspace_idx").on(
      table.workspaceId,
      table.createdAt.desc().nullsFirst()
    ),
  ]
);

export const browserSessions = pgTable(
  "browser_sessions",
  {
    sessionId: text("session_id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    createdByUserId: text("created_by_user_id").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    foreignKey({
      name: "browser_sessions_membership_fkey",
      columns: [table.workspaceId, table.createdByUserId],
      foreignColumns: [
        workspaceMemberships.workspaceId,
        workspaceMemberships.userId,
      ],
    }).onDelete("cascade"),
    index("browser_sessions_workspace_idx").on(
      table.workspaceId,
      table.createdAt.desc().nullsFirst()
    ),
  ]
);

export const browserImageArtifacts = pgTable(
  "browser_image_artifacts",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    createdByUserId: text("created_by_user_id").notNull(),
    rootSessionId: text("root_session_id").notNull(),
    workerSessionId: text("worker_session_id").notNull(),
    browserSessionId: text("browser_session_id").notNull(),
    status: text("status").notNull(),
    label: text("label").notNull(),
    filename: text("filename"),
    mediaType: text("media_type"),
    byteSize: integer("byte_size"),
    contentHash: text("content_hash"),
    storagePathname: text("storage_pathname").notNull(),
    sourceKind: text("source_kind").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    foreignKey({
      name: "browser_image_artifacts_membership_fkey",
      columns: [table.workspaceId, table.createdByUserId],
      foreignColumns: [
        workspaceMemberships.workspaceId,
        workspaceMemberships.userId,
      ],
    }).onDelete("cascade"),
    check(
      "browser_image_artifacts_status_check",
      sql`${table.status} IN ('pending', 'ready')`
    ),
    check(
      "browser_image_artifacts_source_kind_check",
      sql`${table.sourceKind} IN ('element', 'full_page', 'image_resource', 'viewport')`
    ),
    check(
      "browser_image_artifacts_ready_fields_check",
      sql`${table.status} = 'pending' OR (${table.filename} IS NOT NULL AND ${table.mediaType} IS NOT NULL AND ${table.byteSize} > 0 AND ${table.contentHash} IS NOT NULL)`
    ),
    uniqueIndex("browser_image_artifacts_workspace_idempotency_uidx").on(
      table.workspaceId,
      table.idempotencyKey
    ),
    index("browser_image_artifacts_workspace_created_idx").on(
      table.workspaceId,
      table.createdAt.desc().nullsFirst()
    ),
  ]
);

export const chats = pgTable(
  "chats",
  {
    sessionId: text("session_id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    title: text("title").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    costUsd: doublePrecision("cost_usd"),
  },
  (table) => [
    foreignKey({
      name: "chats_workspace_id_fkey",
      columns: [table.workspaceId],
      foreignColumns: [workspaces.id],
    }).onDelete("cascade"),
    check("chats_input_tokens_check", sql`${table.inputTokens} >= 0`),
    check("chats_output_tokens_check", sql`${table.outputTokens} >= 0`),
    check(
      "chats_cost_usd_check",
      sql`${table.costUsd} IS NULL OR ${table.costUsd} >= 0`
    ),
    index("chats_workspace_updated_idx").on(
      table.workspaceId,
      table.updatedAt.desc().nullsFirst()
    ),
  ]
);

export const encryptedSecrets = pgTable(
  "encrypted_secrets",
  {
    workspaceId: text("workspace_id").notNull(),
    namespace: text("namespace").notNull(),
    id: text("id").notNull(),
    encryptedValue: text("encrypted_value").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.workspaceId, table.namespace, table.id],
      name: "encrypted_secrets_pkey",
    }),
    foreignKey({
      name: "encrypted_secrets_workspace_id_fkey",
      columns: [table.workspaceId],
      foreignColumns: [workspaces.id],
    }).onDelete("cascade"),
    check(
      "encrypted_secrets_namespace_check",
      sql`${table.namespace} IN ('vault', 'link')`
    ),
  ]
);

export const linkWalletConnections = pgTable(
  "link_wallet_connections",
  {
    workspaceId: text("workspace_id").primaryKey(),
    status: text("status").notNull(),
    accountLabel: text("account_label"),
    connectedAt: text("connected_at"),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    foreignKey({
      name: "link_wallet_connections_workspace_id_fkey",
      columns: [table.workspaceId],
      foreignColumns: [workspaces.id],
    }).onDelete("cascade"),
    check(
      "link_wallet_connections_status_check",
      sql`${table.status} IN ('pending', 'connected', 'reauthentication_required')`
    ),
  ]
);

export const linkSpendRequests = pgTable(
  "link_spend_requests",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    createdByUserId: text("created_by_user_id").notNull(),
    browserSessionId: text("browser_session_id").notNull(),
    workerSessionId: text("worker_session_id").notNull(),
    rootSessionId: text("root_session_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    requestFingerprint: text("request_fingerprint").notNull(),
    termsFingerprint: text("terms_fingerprint").notNull(),
    kind: text("kind").notNull(),
    amount: integer("amount").notNull(),
    currency: text("currency").notNull(),
    merchantOrigin: text("merchant_origin").notNull(),
    merchantLabel: text("merchant_label"),
    merchantAccountId: text("merchant_account_id"),
    remoteSpendRequestId: text("remote_spend_request_id"),
    status: text("status").notNull(),
    failureCode: text("failure_code"),
    cardLeasedAt: text("card_leased_at"),
    lptLeaseCount: integer("lpt_lease_count").notNull().default(0),
    submissionStartedAt: text("submission_started_at"),
    submissionOutcome: text("submission_outcome"),
    submissionUpdatedAt: text("submission_updated_at"),
    reportOutcome: text("report_outcome"),
    reportedAt: text("reported_at"),
    expiresAt: text("expires_at").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    foreignKey({
      name: "link_spend_requests_membership_fkey",
      columns: [table.workspaceId, table.createdByUserId],
      foreignColumns: [
        workspaceMemberships.workspaceId,
        workspaceMemberships.userId,
      ],
    }).onDelete("cascade"),
    check(
      "link_spend_requests_kind_check",
      sql`${table.kind} IN ('card', 'link_pay_token')`
    ),
    check(
      "link_spend_requests_merchant_binding_check",
      sql`(${table.kind} = 'link_pay_token' AND ${table.merchantAccountId} IS NOT NULL) OR (${table.kind} = 'card' AND ${table.merchantAccountId} IS NULL)`
    ),
    check(
      "link_spend_requests_amount_check",
      sql`${table.amount} > 0 AND ${table.amount} <= 50000`
    ),
    check(
      "link_spend_requests_currency_check",
      sql`char_length(${table.currency}) = 3`
    ),
    check(
      "link_spend_requests_status_check",
      sql`${table.status} IN ('creating', 'created', 'pending_approval', 'approved', 'requires_action', 'submission_started', 'denied', 'expired', 'canceled', 'succeeded', 'failed')`
    ),
    check(
      "link_spend_requests_report_outcome_check",
      sql`${table.reportOutcome} IS NULL OR ${table.reportOutcome} IN ('success', 'blocked', 'abandoned')`
    ),
    check(
      "link_spend_requests_lpt_lease_count_check",
      sql`${table.lptLeaseCount} >= 0 AND ${table.lptLeaseCount} <= 2`
    ),
    check(
      "link_spend_requests_submission_outcome_check",
      sql`${table.submissionOutcome} IS NULL OR ${table.submissionOutcome} IN ('submitted', 'confirmed', 'blocked')`
    ),
    uniqueIndex("link_spend_requests_workspace_idempotency_uidx").on(
      table.workspaceId,
      table.idempotencyKey
    ),
    uniqueIndex("link_spend_requests_workspace_remote_uidx").on(
      table.workspaceId,
      table.remoteSpendRequestId
    ),
    index("link_spend_requests_workspace_created_idx").on(
      table.workspaceId,
      table.createdAt.desc().nullsFirst()
    ),
  ]
);
