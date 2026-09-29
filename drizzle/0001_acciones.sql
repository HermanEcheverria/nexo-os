CREATE TABLE `actions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`pid` integer NOT NULL,
	`agent` text NOT NULL,
	`tool` text NOT NULL,
	`input` text NOT NULL,
	`fingerprint` text NOT NULL,
	`title` text NOT NULL,
	`detail` text,
	`bytes` integer,
	`state` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`decided_at` integer,
	`executed_at` integer,
	`result` text,
	`error` text
);
--> statement-breakpoint
CREATE INDEX `actions_state_idx` ON `actions` (`state`);--> statement-breakpoint
CREATE INDEX `actions_fingerprint_idx` ON `actions` (`fingerprint`);