CREATE TABLE "link_spend_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"created_by_user_id" text NOT NULL,
	"browser_session_id" text NOT NULL,
	"worker_session_id" text NOT NULL,
	"root_session_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_fingerprint" text NOT NULL,
	"terms_fingerprint" text NOT NULL,
	"kind" text NOT NULL,
	"amount" integer NOT NULL,
	"currency" text NOT NULL,
	"merchant_origin" text NOT NULL,
	"merchant_label" text,
	"merchant_account_id" text,
	"remote_spend_request_id" text,
	"status" text NOT NULL,
	"failure_code" text,
	"card_leased_at" text,
	"lpt_lease_count" integer DEFAULT 0 NOT NULL,
	"submission_started_at" text,
	"submission_outcome" text,
	"submission_updated_at" text,
	"report_outcome" text,
	"reported_at" text,
	"expires_at" text NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "link_spend_requests_kind_check" CHECK ("link_spend_requests"."kind" IN ('card', 'link_pay_token')),
	CONSTRAINT "link_spend_requests_amount_check" CHECK ("link_spend_requests"."amount" > 0 AND "link_spend_requests"."amount" <= 50000),
	CONSTRAINT "link_spend_requests_currency_check" CHECK (char_length("link_spend_requests"."currency") = 3),
	CONSTRAINT "link_spend_requests_status_check" CHECK ("link_spend_requests"."status" IN ('creating', 'created', 'pending_approval', 'approved', 'requires_action', 'submission_started', 'denied', 'expired', 'canceled', 'succeeded', 'failed')),
	CONSTRAINT "link_spend_requests_report_outcome_check" CHECK ("link_spend_requests"."report_outcome" IS NULL OR "link_spend_requests"."report_outcome" IN ('success', 'blocked', 'abandoned')),
	CONSTRAINT "link_spend_requests_lpt_lease_count_check" CHECK ("link_spend_requests"."lpt_lease_count" >= 0 AND "link_spend_requests"."lpt_lease_count" <= 2),
	CONSTRAINT "link_spend_requests_submission_outcome_check" CHECK ("link_spend_requests"."submission_outcome" IS NULL OR "link_spend_requests"."submission_outcome" IN ('submitted', 'confirmed', 'blocked'))
);
--> statement-breakpoint
CREATE TABLE "link_wallet_connections" (
	"workspace_id" text PRIMARY KEY NOT NULL,
	"status" text NOT NULL,
	"account_label" text,
	"connected_at" text,
	"updated_at" text NOT NULL,
	CONSTRAINT "link_wallet_connections_status_check" CHECK ("link_wallet_connections"."status" IN ('pending', 'connected', 'reauthentication_required'))
);
--> statement-breakpoint
ALTER TABLE "encrypted_secrets" DROP CONSTRAINT "encrypted_secrets_namespace_check";--> statement-breakpoint
ALTER TABLE "link_spend_requests" ADD CONSTRAINT "link_spend_requests_membership_fkey" FOREIGN KEY ("workspace_id","created_by_user_id") REFERENCES "public"."workspace_memberships"("workspace_id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "link_wallet_connections" ADD CONSTRAINT "link_wallet_connections_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "link_spend_requests_workspace_idempotency_uidx" ON "link_spend_requests" USING btree ("workspace_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "link_spend_requests_workspace_created_idx" ON "link_spend_requests" USING btree ("workspace_id","created_at" DESC NULLS FIRST);--> statement-breakpoint
ALTER TABLE "encrypted_secrets" ADD CONSTRAINT "encrypted_secrets_namespace_check" CHECK ("encrypted_secrets"."namespace" IN ('vault', 'link'));