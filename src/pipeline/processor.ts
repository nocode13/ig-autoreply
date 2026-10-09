import { GrammyError } from 'grammy';
import type { Drafter } from '../ai/drafter.js';
import type { Repo } from '../db/repo.js';
import type { CommentRow, NewCommentRow } from '../db/schema.js';
import { describeError } from '../errors.js';
import type { InstagramClient } from '../instagram/client.js';
import { log, sleep } from '../logger.js';
import type { Broadcaster } from '../telegram/broadcast.js';
import { cardKeyboard, editMarker, renderCard, truncate } from '../telegram/render.js';

/** Комментарий в нормализованном виде — одинаковый для polling и webhook. */
export interface IncomingComment {
  id: string;
  mediaId: string;
  parentId?: string | null;
  username?: string | null;
  fromId?: string | null;
  text: string;
  // undefined — неизвестно (webhook), будет запрошено у API; null — у поста нет подписи
  mediaCaption?: string | null;
  mediaPermalink?: string | null;
}

/** Идентификаторы своего аккаунта: комментарии от них игнорируем, чтобы не было циклов. */
export interface SelfIdentity {
  ids: Set<string>;
  username: string | null;
}

/** Кто нажал кнопку в Telegram. */
export interface Actor {
  chatId: number;
  name: string;
}

interface ServiceDeps {
  repo: Repo;
  ig: InstagramClient;
  drafter: Drafter;
  broadcaster: Broadcaster;
  self: SelfIdentity;
}

interface MediaInfo {
  caption: string | null;
  permalink: string | null;
}

const MEDIA_CACHE_SIZE = 200;

/** Последовательная очередь: новые комментарии обрабатываются по одному. */
class SerialQueue {
  private tail: Promise<void> = Promise.resolve();

  push(task: () => Promise<void>): void {
    this.tail = this.tail.then(task).catch((err) => log.error('Ошибка в очереди обработки:', err));
  }

  idle(): Promise<void> {
    return this.tail;
  }
}

export class CommentService {
  private readonly queue = new SerialQueue();
  private readonly busy = new Set<string>();
  private readonly mediaCache = new Map<string, MediaInfo>();
  private closed = false;

  constructor(private readonly deps: ServiceDeps) {}

  // ---------- Приём комментариев ----------

  /** Новый комментарий из polling/webhook. Дедупликация — по ID комментария. */
  enqueue(c: IncomingComment): void {
    if (this.closed || this.deps.repo.hasComment(c.id)) return;
    this.queue.push(() => this.ingest(c));
  }

  /** Первичная инициализация: записать комментарий как уже виденный, без уведомления. */
  markSeen(c: IncomingComment): boolean {
    return this.deps.repo.insertComment({ ...toRow(c), status: 'skipped' });
  }

  /** Доставить карточки, которые не ушли ни в один чат (Telegram был недоступен или не было подписчиков). */
  recoverUndelivered(): void {
    if (this.deps.broadcaster.chatIds().length === 0) return;
    for (const row of this.deps.repo.listUndelivered()) {
      this.queue.push(() => this.deliver(row.id));
    }
  }

  async close(timeoutMs: number): Promise<void> {
    this.closed = true;
    await Promise.race([this.queue.idle(), sleep(timeoutMs)]);
  }

  private isOwn(c: Pick<IncomingComment, 'fromId' | 'username'>): boolean {
    const { ids, username } = this.deps.self;
    if (c.fromId && ids.has(c.fromId)) return true;
    return !!username && c.username?.toLowerCase() === username.toLowerCase();
  }

  private async ingest(c: IncomingComment): Promise<void> {
    const { repo } = this.deps;
    if (repo.hasComment(c.id)) return;

    if (this.isOwn(c)) {
      repo.insertComment({ ...toRow(c), status: 'skipped' });
      return;
    }

    const media = await this.resolveMedia(c);
    const parentText = c.parentId ? await this.resolveParentText(c.parentId) : null;
    const inserted = repo.insertComment({
      ...toRow(c),
      mediaCaption: media.caption,
      mediaPermalink: media.permalink,
      parentText,
      status: 'pending',
    });
    if (!inserted) return;

    log.info(`Новый комментарий ${c.id} от @${c.username ?? '?'}`);
    await this.deliver(c.id);
  }

  /** Генерирует черновик (если его ещё нет) и рассылает карточку всем подписчикам. */
  private async deliver(id: string): Promise<void> {
    let row = this.deps.repo.getComment(id);
    if (!row || this.deps.repo.listCardMessages(id).length > 0) return;
    if (row.status === 'pending' && !row.draft && !row.category) {
      row = await this.generateDraft(row, { variant: false, failAsError: true });
    }
    if (row.status === 'pending' || row.status === 'error') {
      await this.sendCards(row, this.deps.broadcaster.chatIds());
    }
  }

  private async resolveMedia(c: IncomingComment): Promise<MediaInfo> {
    if (c.mediaCaption !== undefined || c.mediaPermalink !== undefined) {
      return { caption: c.mediaCaption ?? null, permalink: c.mediaPermalink ?? null };
    }
    const cached = this.mediaCache.get(c.mediaId);
    if (cached) return cached;
    try {
      const media = await this.deps.ig.getMedia(c.mediaId);
      const info = { caption: media.caption ?? null, permalink: media.permalink ?? null };
      this.mediaCache.set(c.mediaId, info);
      if (this.mediaCache.size > MEDIA_CACHE_SIZE) {
        const oldest = this.mediaCache.keys().next().value;
        if (oldest !== undefined) this.mediaCache.delete(oldest);
      }
      return info;
    } catch (err) {
      log.warn(`Не удалось получить пост ${c.mediaId}:`, describeError(err));
      return { caption: null, permalink: null };
    }
  }

  private async resolveParentText(parentId: string): Promise<string | null> {
    const format = (username: string | null | undefined, fromId: string | null | undefined, text: string) => {
      const own = this.isOwn({ username, fromId }) ? ' (это ваш аккаунт)' : '';
      return `@${username ?? 'unknown'}${own}: ${text}`;
    };

    const stored = this.deps.repo.getComment(parentId);
    if (stored) return format(stored.username, stored.fromId, stored.text);
    try {
      const parent = await this.deps.ig.getComment(parentId);
      return format(parent.username ?? parent.from?.username, parent.from?.id, parent.text ?? '');
    } catch (err) {
      log.warn(`Не удалось получить родительский комментарий ${parentId}:`, describeError(err));
      return null;
    }
  }

  private async generateDraft(
    row: CommentRow,
    opts: { variant: boolean; failAsError: boolean },
  ): Promise<CommentRow> {
    const { repo, drafter } = this.deps;
    try {
      const draft = await drafter.generate({
        username: row.username,
        text: row.text,
        caption: row.mediaCaption,
        parentText: row.parentText,
        previousDraft: opts.variant ? row.draft : null,
        hint: row.regenHint,
      });
      return repo.updateComment(row.id, {
        draft: draft.reply || null,
        category: draft.category,
        draftNote: draft.note || null,
        // Новый черновик заменяет ранее введённый вручную текст
        finalReply: null,
        status: 'pending',
        error: null,
      })!;
    } catch (err) {
      const message = describeError(err);
      log.error(`Генерация черновика для ${row.id} не удалась:`, message);
      if (!opts.failAsError) throw err;
      return repo.updateComment(row.id, { status: 'error', error: message })!;
    }
  }

  // ---------- Действия из Telegram (возвращают текст для всплывающего уведомления) ----------

  approve(id: string, actor: Actor): Promise<string> {
    return this.exclusive(id, async (row) => {
      const blocked = finalStatusNotice(row);
      if (blocked) return blocked;
      const text = (row.finalReply ?? row.draft)?.trim();
      if (!text) return 'Черновик пуст — нажми «✏️ Изменить»';
      return this.postReply(row, text, actor, 'отправил ответ');
    });
  }

  async startEdit(id: string, actor: Actor): Promise<string> {
    const row = this.deps.repo.getComment(id);
    if (!row) return 'Комментарий не найден';
    const blocked = finalStatusNotice(row);
    if (blocked) return blocked;

    // force_reply уходит только тому, кто нажал «Изменить»
    const card = this.deps.repo.findLatestCardInChat(row.id, actor.chatId);
    await this.deps.broadcaster.api.sendMessage(
      actor.chatId,
      `✏️ Пришли текст ответа для @${row.username ?? 'unknown'} — ответом на это сообщение.\n${editMarker(row.id)}`,
      {
        reply_markup: { force_reply: true, input_field_placeholder: 'Текст ответа' },
        ...(card
          ? { reply_parameters: { message_id: card.messageId, allow_sending_without_reply: true } }
          : {}),
      },
    );
    return 'Жду твой текст';
  }

  submitEdit(id: string, text: string, actor: Actor): Promise<string> {
    return this.exclusive(id, async (row) => {
      const blocked = finalStatusNotice(row);
      if (blocked) return blocked;
      return this.postReply(row, text.trim(), actor, 'отправил свой вариант ответа');
    });
  }

  async saveHint(id: string, hint: string): Promise<string> {
    const row = this.deps.repo.getComment(id);
    if (!row) return 'Комментарий не найден';
    const blocked = finalStatusNotice(row);
    if (blocked) return blocked;
    const updated = this.deps.repo.updateComment(id, { regenHint: hint.trim() })!;
    await this.refreshCards(updated);
    return '✍️ Уточнение сохранено — нажми «🔄 Перегенерировать»';
  }

  regenerate(id: string, actor: Actor): Promise<string> {
    return this.exclusive(id, async (row) => {
      const blocked = finalStatusNotice(row);
      if (blocked) return blocked;
      try {
        const updated = await this.generateDraft(row, { variant: !!row.draft, failAsError: false });
        await this.refreshCards(updated);
        return '🔄 Новый черновик готов';
      } catch (err) {
        await this.notifyChats(row, `❗ Не удалось перегенерировать черновик:\n${describeError(err)}`, {
          onlyChatId: actor.chatId,
        });
        return '❗ Ошибка генерации';
      }
    });
  }

  skip(id: string, actor: Actor): Promise<string> {
    return this.exclusive(id, async (row) => {
      if (row.status === 'sent') return finalStatusNotice(row)!;
      if (row.status === 'skipped') return '⏭ Уже пропущено';
      const updated = this.deps.repo.updateComment(id, { status: 'skipped', handledBy: actor.name })!;
      await this.refreshCards(updated);
      await this.notifyChats(updated, `⏭ ${actor.name} пропустил комментарий ${commentLabel(updated)}`, {
        exceptChatId: actor.chatId,
      });
      return '⏭ Пропущено';
    });
  }

  /** «Повторить» после ошибки: без черновика — генерируем заново, с черновиком — заново отправляем. */
  retry(id: string, actor: Actor): Promise<string> {
    return this.exclusive(id, async (row) => {
      if (row.status !== 'error') return finalStatusNotice(row) ?? 'Ошибки нет — используй кнопки карточки';
      const text = (row.finalReply ?? row.draft)?.trim();
      if (text) return this.postReply(row, text, actor, 'отправил ответ');

      const updated = await this.generateDraft(row, { variant: false, failAsError: true });
      await this.refreshCards(updated);
      return updated.status === 'error' ? '❗ Снова ошибка' : '🔄 Черновик готов';
    });
  }

  /** /pending: переотправить карточки всех pending-комментариев в чат, откуда пришла команда. */
  async resendPending(chatId: number): Promise<number> {
    const rows = this.deps.repo.listByStatus('pending');
    for (let row of rows) {
      if (!row.draft && !row.category) {
        row = await this.generateDraft(row, { variant: false, failAsError: true });
      }
      await this.sendCards(row, [chatId]);
    }
    return rows.length;
  }

  private async exclusive(id: string, fn: (row: CommentRow) => Promise<string>): Promise<string> {
    if (this.busy.has(id)) return '⏳ Уже выполняется…';
    const row = this.deps.repo.getComment(id);
    if (!row) return 'Комментарий не найден';
    this.busy.add(id);
    try {
      return await fn(row);
    } finally {
      this.busy.delete(id);
    }
  }

  private async postReply(row: CommentRow, text: string, actor: Actor, verb: string): Promise<string> {
    const { repo, ig } = this.deps;
    // Instagram поддерживает один уровень вложенности: в ветке отвечаем на верхний
    // комментарий и упоминаем автора, чтобы было понятно, кому ответ.
    const target = row.parentId ?? row.id;
    const message = withMention(row, text);
    try {
      await ig.replyToComment(target, message);
      const updated = repo.updateComment(row.id, {
        status: 'sent',
        finalReply: message,
        handledBy: actor.name,
        error: null,
      })!;
      log.info(`Ответ на ${row.id} отправлен (${actor.name})`);
      await this.refreshCards(updated);
      await this.notifyChats(
        updated,
        `✅ ${actor.name} ${verb} на комментарий ${commentLabel(updated)}:\n«${truncate(message, 300)}»`,
        { exceptChatId: actor.chatId },
      );
      return '✅ Отправлено';
    } catch (err) {
      const error = describeError(err);
      log.error(`Не удалось отправить ответ на ${row.id}:`, error);
      const updated = repo.updateComment(row.id, { status: 'error', error, finalReply: text })!;
      await this.refreshCards(updated);
      await this.notifyChats(updated, `❗ Не удалось отправить ответ в Instagram (${actor.name}):\n${error}`);
      return '❗ Ошибка отправки';
    }
  }

  // ---------- Telegram: карточки во всех чатах ----------

  private async sendCards(row: CommentRow, chatIds: number[]): Promise<void> {
    const { api } = this.deps.broadcaster;
    for (const chatId of chatIds) {
      try {
        const msg = await api.sendMessage(chatId, renderCard(row), {
          parse_mode: 'HTML',
          reply_markup: cardKeyboard(row),
          link_preview_options: { is_disabled: true },
        });
        this.deps.repo.addCardMessage(row.id, chatId, msg.message_id);
      } catch (err) {
        this.deps.broadcaster.handleError(chatId, err);
      }
    }
  }

  /** Обновляет все копии карточки (у каждого подписчика). */
  private async refreshCards(row: CommentRow): Promise<void> {
    const { repo, broadcaster } = this.deps;
    const cards = repo.listCardMessages(row.id);
    if (cards.length === 0) return this.sendCards(row, broadcaster.chatIds());

    for (const card of cards) {
      try {
        await broadcaster.api.editMessageText(card.chatId, card.messageId, renderCard(row), {
          parse_mode: 'HTML',
          reply_markup: cardKeyboard(row) ?? { inline_keyboard: [] },
          link_preview_options: { is_disabled: true },
        });
      } catch (err) {
        if (err instanceof GrammyError && err.description.includes('message is not modified')) continue;
        if (
          err instanceof GrammyError &&
          /message to edit not found|message can't be edited/.test(err.description)
        ) {
          repo.deleteCardMessage(card.chatId, card.messageId);
          if (!repo.findLatestCardInChat(row.id, card.chatId)) await this.sendCards(row, [card.chatId]);
          continue;
        }
        broadcaster.handleError(card.chatId, err);
      }
    }
  }

  /** Сообщение в чаты подписчиков — ответом на их копию карточки. */
  private async notifyChats(
    row: CommentRow,
    text: string,
    opts: { exceptChatId?: number; onlyChatId?: number } = {},
  ): Promise<void> {
    const { repo, broadcaster } = this.deps;
    const chatIds = opts.onlyChatId !== undefined ? [opts.onlyChatId] : broadcaster.chatIds();
    for (const chatId of chatIds) {
      if (chatId === opts.exceptChatId) continue;
      const card = repo.findLatestCardInChat(row.id, chatId);
      try {
        await broadcaster.api.sendMessage(chatId, text, {
          ...(card
            ? { reply_parameters: { message_id: card.messageId, allow_sending_without_reply: true } }
            : {}),
        });
      } catch (err) {
        broadcaster.handleError(chatId, err);
      }
    }
  }
}

function toRow(c: IncomingComment): NewCommentRow {
  return {
    id: c.id,
    mediaId: c.mediaId,
    parentId: c.parentId ?? null,
    username: c.username ?? null,
    fromId: c.fromId ?? null,
    text: c.text,
    mediaCaption: c.mediaCaption ?? null,
    mediaPermalink: c.mediaPermalink ?? null,
  };
}

function commentLabel(row: CommentRow): string {
  return `@${row.username ?? 'unknown'} «${truncate(row.text, 80)}»`;
}

function finalStatusNotice(row: CommentRow): string | null {
  const by = row.handledBy ? ` (${row.handledBy})` : '';
  if (row.status === 'sent') return `Уже отправлено${by}`;
  if (row.status === 'skipped') return `Комментарий пропущен${by}`;
  return null;
}

function withMention(row: CommentRow, text: string): string {
  if (!row.parentId || !row.username) return text;
  const mention = `@${row.username}`;
  return text.toLowerCase().startsWith(mention.toLowerCase()) ? text : `${mention} ${text}`;
}
