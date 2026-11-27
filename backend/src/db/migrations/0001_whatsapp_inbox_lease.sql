ALTER TABLE "webhook_inbox" ADD COLUMN "lease_token" text;--> statement-breakpoint
ALTER TABLE "webhook_inbox" ADD COLUMN "lease_until" timestamp with time zone;