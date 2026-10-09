import { and, asc, count, eq, inArray, ne, notExists, sql } from 'drizzle-orm';
import type { DB } from './client.js';
import {
  COMMENT_STATUSES,
  cardMessages,
  comments,
  settings,
  subscribers,
  type CardMessage,
  type CommentRow,
  type CommentStatus,
  type NewCommentRow,
  type NewSubscriber,
  type Subscriber,
} from './schema.js';

export const SETTING = {
  igAccessToken: 'ig_access_token',
  igTokenRefreshedAt: 'ig_token_refreshed_at',
  igTokenExpiresAt: 'ig_token_expires_at',
  igTokenRefreshFailedAt: 'ig_token_refresh_failed_at',
  initialized: 'initialized',
  lastBackupAt: 'last_backup_at',
} as const;

export type CommentPatch = Partial<Omit<NewCommentRow, 'id' | 'createdAt'>>;

export class Repo {
  constructor(private readonly db: DB) {}

  // ---------- comments ----------

  getComment(id: string): CommentRow | undefined {
    return this.db.select().from(comments).where(eq(comments.id, id)).get();
  }

  hasComment(id: string): boolean {
    return (
      this.db.select({ id: comments.id }).from(comments).where(eq(comments.id, id)).get() !==
      undefined
    );
  }

  /** Вставляет комментарий, если его ещё нет. Возвращает true, если строка добавлена. */
  insertComment(row: NewCommentRow): boolean {
    return this.db.insert(comments).values(row).onConflictDoNothing().run().changes > 0;
  }

  updateComment(id: string, patch: CommentPatch): CommentRow | undefined {
    return this.db.update(comments).set(patch).where(eq(comments.id, id)).returning().get();
  }

  listByStatus(status: CommentStatus): CommentRow[] {
    return this.db
      .select()
      .from(comments)
      .where(eq(comments.status, status))
      .orderBy(asc(comments.createdAt))
      .all();
  }

  /** Комментарии, карточка по которым не ушла ни в один чат (Telegram был недоступен или не было подписчиков). */
  listUndelivered(): CommentRow[] {
    return this.db
      .select()
      .from(comments)
      .where(
        and(
          inArray(comments.status, ['pending', 'error']),
          notExists(
            this.db
              .select({ one: sql`1` })
              .from(cardMessages)
              .where(eq(cardMessages.commentId, comments.id)),
          ),
        ),
      )
      .orderBy(asc(comments.createdAt))
      .all();
  }

  stats(): Record<CommentStatus, number> {
    const result = Object.fromEntries(COMMENT_STATUSES.map((s) => [s, 0])) as Record<
      CommentStatus,
      number
    >;
    const rows = this.db
      .select({ status: comments.status, n: count() })
      .from(comments)
      .groupBy(comments.status)
      .all();
    for (const row of rows) result[row.status] = row.n;
    return result;
  }

  // ---------- subscribers ----------

  listSubscribers(): Subscriber[] {
    return this.db.select().from(subscribers).orderBy(asc(subscribers.createdAt)).all();
  }

  isSubscriber(chatId: number): boolean {
    return (
      this.db
        .select({ chatId: subscribers.chatId })
        .from(subscribers)
        .where(eq(subscribers.chatId, chatId))
        .get() !== undefined
    );
  }

  addSubscriber(row: NewSubscriber): void {
    const { chatId: _chatId, ...update } = row;
    this.db
      .insert(subscribers)
      .values(row)
      .onConflictDoUpdate({ target: subscribers.chatId, set: update })
      .run();
  }

  removeSubscriber(chatId: number): void {
    this.db.delete(subscribers).where(eq(subscribers.chatId, chatId)).run();
    this.db.delete(cardMessages).where(eq(cardMessages.chatId, chatId)).run();
  }

  /** Удаляет подписчиков, вошедших со старым логином/паролем. Возвращает их chat id. */
  pruneSubscribers(currentAuthHash: string): number[] {
    const stale = this.db
      .select({ chatId: subscribers.chatId })
      .from(subscribers)
      .where(ne(subscribers.authHash, currentAuthHash))
      .all()
      .map((s) => s.chatId);
    for (const chatId of stale) this.removeSubscriber(chatId);
    return stale;
  }

  // ---------- card messages ----------

  addCardMessage(commentId: string, chatId: number, messageId: number): void {
    this.db.insert(cardMessages).values({ commentId, chatId, messageId }).onConflictDoNothing().run();
  }

  listCardMessages(commentId: string): CardMessage[] {
    return this.db.select().from(cardMessages).where(eq(cardMessages.commentId, commentId)).all();
  }

  findCardMessage(chatId: number, messageId: number): CardMessage | undefined {
    return this.db
      .select()
      .from(cardMessages)
      .where(and(eq(cardMessages.chatId, chatId), eq(cardMessages.messageId, messageId)))
      .get();
  }

  /** Последняя карточка комментария в конкретном чате (после /pending их может быть несколько). */
  findLatestCardInChat(commentId: string, chatId: number): CardMessage | undefined {
    return this.listCardMessages(commentId)
      .filter((c) => c.chatId === chatId)
      .sort((a, b) => b.messageId - a.messageId)[0];
  }

  deleteCardMessage(chatId: number, messageId: number): void {
    this.db
      .delete(cardMessages)
      .where(and(eq(cardMessages.chatId, chatId), eq(cardMessages.messageId, messageId)))
      .run();
  }

  // ---------- settings ----------

  getSetting(key: string): string | undefined {
    return this.db.select().from(settings).where(eq(settings.key, key)).get()?.value;
  }

  setSetting(key: string, value: string): void {
    this.db
      .insert(settings)
      .values({ key, value })
      .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date() } })
      .run();
  }

  deleteSetting(key: string): void {
    this.db.delete(settings).where(eq(settings.key, key)).run();
  }
}
