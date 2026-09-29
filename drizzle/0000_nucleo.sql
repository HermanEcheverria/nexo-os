CREATE TABLE "findings" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"pid" bigint NOT NULL,
	"agent" text NOT NULL,
	"level" text NOT NULL,
	"title" text NOT NULL,
	"detail" text,
	"bytes" bigint,
	"data" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "journal" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"pid" bigint,
	"agent" text,
	"type" text NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memory" (
	"agent" text NOT NULL,
	"key" text NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memory_agent_key_pk" PRIMARY KEY("agent","key")
);
--> statement-breakpoint
CREATE TABLE "processes" (
	"pid" bigserial PRIMARY KEY NOT NULL,
	"agent" text NOT NULL,
	"state" text NOT NULL,
	"trigger" text NOT NULL,
	"attempt" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"error" text
);
--> statement-breakpoint
CREATE INDEX "findings_pid_idx" ON "findings" USING btree ("pid");--> statement-breakpoint
CREATE INDEX "journal_pid_idx" ON "journal" USING btree ("pid");--> statement-breakpoint
CREATE INDEX "journal_at_idx" ON "journal" USING btree ("at");--> statement-breakpoint
CREATE INDEX "processes_agent_idx" ON "processes" USING btree ("agent","created_at");