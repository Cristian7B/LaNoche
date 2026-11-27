CREATE TYPE "public"."category" AS ENUM('photo', 'sticker');--> statement-breakpoint
CREATE TYPE "public"."event_status" AS ENUM('open', 'closed', 'results_published');--> statement-breakpoint
CREATE TYPE "public"."intake_status" AS ENUM('processing', 'ready', 'claimed', 'expired', 'failed');--> statement-breakpoint
CREATE TYPE "public"."media_kind" AS ENUM('image', 'video');--> statement-breakpoint
CREATE TYPE "public"."submission_source" AS ENUM('web', 'whatsapp', 'admin');--> statement-breakpoint
CREATE TYPE "public"."submission_status" AS ENUM('published', 'deleted');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('participant', 'admin');--> statement-breakpoint
CREATE TABLE "admin_actions" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "admin_actions_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"admin_id" uuid NOT NULL,
	"action" text NOT NULL,
	"target_type" text,
	"target_id" text,
	"payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "admin_actions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "event_settings" (
	"id" smallint PRIMARY KEY DEFAULT 1 NOT NULL,
	"status" "event_status" DEFAULT 'open' NOT NULL,
	"closes_at" timestamp with time zone,
	"results_published_at" timestamp with time zone,
	"max_votes_per_category" smallint DEFAULT 5 NOT NULL,
	"max_photo_submissions" smallint DEFAULT 2 NOT NULL,
	"max_sticker_submissions" smallint DEFAULT 3 NOT NULL,
	"allow_self_vote" boolean DEFAULT false NOT NULL,
	"show_author_in_public_results" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	CONSTRAINT "event_settings_id_check" CHECK ("event_settings"."id" = 1),
	CONSTRAINT "event_max_votes_check" CHECK ("event_settings"."max_votes_per_category" between 1 and 10)
);
--> statement-breakpoint
ALTER TABLE "event_settings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "profiles" (
	"id" uuid PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"display_name" text NOT NULL,
	"avatar_url" text,
	"role" "user_role" DEFAULT 'participant' NOT NULL,
	"is_blocked" boolean DEFAULT false NOT NULL,
	"human_verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "profiles" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "submission_media" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"submission_id" uuid NOT NULL,
	"position" smallint NOT NULL,
	"kind" "media_kind" NOT NULL,
	"storage_path" text NOT NULL,
	"thumb_path" text NOT NULL,
	"mime_type" text NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"duration_ms" integer,
	"size_bytes" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "submission_media_position_uq" UNIQUE("submission_id","position"),
	CONSTRAINT "submission_media_position_check" CHECK ("submission_media"."position" >= 1)
);
--> statement-breakpoint
ALTER TABLE "submission_media" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "submissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"category" "category" NOT NULL,
	"title" varchar(120) NOT NULL,
	"description" text NOT NULL,
	"author_id" uuid,
	"author_label" text,
	"source" "submission_source" NOT NULL,
	"intake_id" uuid,
	"status" "submission_status" DEFAULT 'published' NOT NULL,
	"deleted_at" timestamp with time zone,
	"deleted_by" uuid,
	"delete_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "submissions_intake_id_unique" UNIQUE("intake_id"),
	CONSTRAINT "submissions_id_category_uq" UNIQUE("id","category"),
	CONSTRAINT "submissions_author_check" CHECK ("submissions"."author_id" is not null or "submissions"."author_label" is not null)
);
--> statement-breakpoint
ALTER TABLE "submissions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "vote_attempts" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "vote_attempts_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"voter_id" uuid NOT NULL,
	"ip" "inet",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "vote_attempts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "vote_audit" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "vote_audit_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"voter_id" uuid NOT NULL,
	"category" "category" NOT NULL,
	"ballot" uuid[] NOT NULL,
	"ip" "inet",
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "vote_audit" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "votes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"voter_id" uuid NOT NULL,
	"category" "category" NOT NULL,
	"submission_id" uuid NOT NULL,
	"position" smallint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "votes_position_uq" UNIQUE("voter_id","category","position"),
	CONSTRAINT "votes_candidate_uq" UNIQUE("voter_id","submission_id"),
	CONSTRAINT "votes_position_check" CHECK ("votes"."position" >= 1)
);
--> statement-breakpoint
ALTER TABLE "votes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "webhook_inbox" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "webhook_inbox_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"message_id" text NOT NULL,
	"media_id" text,
	"media_mime_type" text,
	"media_sha256" text,
	"media_animated" boolean,
	"sender_hash" text,
	"sender_ciphertext" text,
	"message_type" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" smallint DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "webhook_inbox_message_uq" UNIQUE("message_id")
);
--> statement-breakpoint
ALTER TABLE "webhook_inbox" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "whatsapp_intakes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"wa_message_id" text NOT NULL,
	"wa_media_id" text NOT NULL,
	"wa_id" text,
	"wa_sender_hash" text NOT NULL,
	"category" "category" DEFAULT 'sticker' NOT NULL,
	"status" "intake_status" DEFAULT 'processing' NOT NULL,
	"token_hash" text,
	"token_ciphertext" text,
	"source_mime" text,
	"is_animated" boolean,
	"kind" "media_kind",
	"storage_path" text,
	"thumb_path" text,
	"mime_type" text,
	"width" integer,
	"height" integer,
	"duration_ms" integer,
	"size_bytes" integer,
	"attempts" smallint DEFAULT 0 NOT NULL,
	"error" text,
	"reply_sent_at" timestamp with time zone,
	"claimed_by" uuid,
	"claimed_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "whatsapp_intakes_message_uq" UNIQUE("wa_message_id"),
	CONSTRAINT "whatsapp_intakes_token_hash_uq" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "whatsapp_intakes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "admin_actions" ADD CONSTRAINT "admin_actions_admin_id_profiles_id_fk" FOREIGN KEY ("admin_id") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_settings" ADD CONSTRAINT "event_settings_updated_by_profiles_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_id_users_id_fk" FOREIGN KEY ("id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submission_media" ADD CONSTRAINT "submission_media_submission_id_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."submissions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_author_id_profiles_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_intake_id_whatsapp_intakes_id_fk" FOREIGN KEY ("intake_id") REFERENCES "public"."whatsapp_intakes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_deleted_by_profiles_id_fk" FOREIGN KEY ("deleted_by") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vote_attempts" ADD CONSTRAINT "vote_attempts_voter_id_profiles_id_fk" FOREIGN KEY ("voter_id") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vote_audit" ADD CONSTRAINT "vote_audit_voter_id_profiles_id_fk" FOREIGN KEY ("voter_id") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "votes" ADD CONSTRAINT "votes_voter_id_profiles_id_fk" FOREIGN KEY ("voter_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "votes" ADD CONSTRAINT "votes_submission_id_category_submissions_id_category_fk" FOREIGN KEY ("submission_id","category") REFERENCES "public"."submissions"("id","category") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "whatsapp_intakes" ADD CONSTRAINT "whatsapp_intakes_claimed_by_profiles_id_fk" FOREIGN KEY ("claimed_by") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "admin_actions_created_idx" ON "admin_actions" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "profiles_email_uq" ON "profiles" USING btree (lower("email"));--> statement-breakpoint
CREATE INDEX "submissions_list_idx" ON "submissions" USING btree ("category","status");--> statement-breakpoint
CREATE INDEX "submissions_author_idx" ON "submissions" USING btree ("author_id","category") WHERE "submissions"."status" = 'published';--> statement-breakpoint
CREATE INDEX "vote_attempts_user_idx" ON "vote_attempts" USING btree ("voter_id","created_at");--> statement-breakpoint
CREATE INDEX "vote_audit_voter_idx" ON "vote_audit" USING btree ("voter_id","created_at");--> statement-breakpoint
CREATE INDEX "votes_submission_idx" ON "votes" USING btree ("submission_id");--> statement-breakpoint
CREATE INDEX "webhook_inbox_pending_idx" ON "webhook_inbox" USING btree ("status","updated_at");--> statement-breakpoint
CREATE INDEX "intakes_sender_idx" ON "whatsapp_intakes" USING btree ("wa_sender_hash","created_at");--> statement-breakpoint
CREATE INDEX "intakes_status_idx" ON "whatsapp_intakes" USING btree ("status","updated_at");--> statement-breakpoint
INSERT INTO "event_settings" ("id") VALUES (1) ON CONFLICT ("id") DO NOTHING;
