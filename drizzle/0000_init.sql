CREATE TABLE `card_messages` (
	`comment_id` text NOT NULL,
	`chat_id` integer NOT NULL,
	`message_id` integer NOT NULL,
	PRIMARY KEY(`chat_id`, `message_id`)
);
--> statement-breakpoint
CREATE INDEX `card_messages_comment_idx` ON `card_messages` (`comment_id`);--> statement-breakpoint
CREATE TABLE `comments` (
	`id` text PRIMARY KEY NOT NULL,
	`media_id` text NOT NULL,
	`parent_id` text,
	`username` text,
	`from_id` text,
	`text` text NOT NULL,
	`media_caption` text,
	`media_permalink` text,
	`parent_text` text,
	`draft` text,
	`final_reply` text,
	`category` text,
	`draft_note` text,
	`regen_hint` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`handled_by` text,
	`error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `comments_status_idx` ON `comments` (`status`);--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `subscribers` (
	`chat_id` integer PRIMARY KEY NOT NULL,
	`user_id` integer,
	`username` text,
	`name` text,
	`auth_hash` text NOT NULL,
	`created_at` integer NOT NULL
);
