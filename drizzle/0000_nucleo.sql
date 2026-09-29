CREATE TABLE `findings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`pid` integer NOT NULL,
	`agent` text NOT NULL,
	`level` text NOT NULL,
	`title` text NOT NULL,
	`detail` text,
	`bytes` integer,
	`data` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `findings_pid_idx` ON `findings` (`pid`);--> statement-breakpoint
CREATE TABLE `journal` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`pid` integer,
	`agent` text,
	`type` text NOT NULL,
	`data` text DEFAULT '{}' NOT NULL
);
--> statement-breakpoint
CREATE INDEX `journal_pid_idx` ON `journal` (`pid`);--> statement-breakpoint
CREATE INDEX `journal_at_idx` ON `journal` (`at`);--> statement-breakpoint
CREATE TABLE `memory` (
	`agent` text NOT NULL,
	`key` text NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	PRIMARY KEY(`agent`, `key`)
);
--> statement-breakpoint
CREATE TABLE `processes` (
	`pid` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`agent` text NOT NULL,
	`state` text NOT NULL,
	`trigger` text NOT NULL,
	`attempt` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`started_at` integer,
	`finished_at` integer,
	`error` text
);
--> statement-breakpoint
CREATE INDEX `processes_agent_idx` ON `processes` (`agent`,`created_at`);