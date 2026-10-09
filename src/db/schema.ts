import { index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const COMMENT_STATUSES = ['pending', 'sent', 'skipped', 'error'] as const;
export type CommentStatus = (typeof COMMENT_STATUSES)[number];

export const comments = sqliteTable(
  'comments',
  {
    // ID комментария в Instagram
    id: text('id').primaryKey(),
    mediaId: text('media_id').notNull(),
    parentId: text('parent_id'),
    username: text('username'),
    fromId: text('from_id'),
    text: text('text').notNull(),
    mediaCaption: text('media_caption'),
    mediaPermalink: text('media_permalink'),
    // Родительский комментарий в формате "@user: текст" (для ответов в ветке)
    parentText: text('parent_text'),
    draft: text('draft'),
    finalReply: text('final_reply'),
    // Классификация от Claude: normal / question / complaint / spam / abuse
    category: text('category'),
    // Заметка Claude для владельца аккаунта
    draftNote: text('draft_note'),
    // Уточнение для перегенерации (ответ текстом на карточку)
    regenHint: text('regen_hint'),
    status: text('status', { enum: COMMENT_STATUSES }).notNull().default('pending'),
    // Кто из подписчиков отправил / пропустил (для карточки и уведомлений)
    handledBy: text('handled_by'),
    error: text('error'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .notNull()
      .$defaultFn(() => new Date())
      .$onUpdate(() => new Date()),
  },
  (t) => [index('comments_status_idx').on(t.status)],
);

/** Telegram-чаты, которые вошли через /login и получают карточки. */
export const subscribers = sqliteTable('subscribers', {
  chatId: integer('chat_id').primaryKey({ autoIncrement: false }),
  userId: integer('user_id'),
  username: text('username'),
  name: text('name'),
  // Хэш логина+пароля на момент входа: при смене AUTH_* все подписчики разлогиниваются
  authHash: text('auth_hash').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' })
    .notNull()
    .$defaultFn(() => new Date()),
});

/** Копии карточки комментария в каждом чате-подписчике. */
export const cardMessages = sqliteTable(
  'card_messages',
  {
    commentId: text('comment_id').notNull(),
    chatId: integer('chat_id').notNull(),
    messageId: integer('message_id').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.chatId, t.messageId] }),
    index('card_messages_comment_idx').on(t.commentId),
  ],
);

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
    .notNull()
    .$defaultFn(() => new Date())
    .$onUpdate(() => new Date()),
});

export type CommentRow = typeof comments.$inferSelect;
export type NewCommentRow = typeof comments.$inferInsert;
export type Subscriber = typeof subscribers.$inferSelect;
export type NewSubscriber = typeof subscribers.$inferInsert;
export type CardMessage = typeof cardMessages.$inferSelect;
