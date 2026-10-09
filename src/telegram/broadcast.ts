import { GrammyError, type Api } from 'grammy';
import type { Repo } from '../db/repo.js';
import { describeError } from '../errors.js';
import { log } from '../logger.js';

/** Чат больше недоступен боту (заблокировал, удалил, бота кикнули) — подписчика можно удалять. */
export function isChatGone(err: unknown): boolean {
  if (!(err instanceof GrammyError)) return false;
  if (err.error_code === 403) return true;
  return err.error_code === 400 && /chat not found|user is deactivated/i.test(err.description);
}

/** Рассылка всем подписчикам бота. */
export class Broadcaster {
  constructor(
    readonly api: Api,
    private readonly repo: Repo,
  ) {}

  chatIds(): number[] {
    return this.repo.listSubscribers().map((s) => s.chatId);
  }

  /** Обработать ошибку отправки в чат: недоступный чат удаляется из подписчиков. */
  handleError(chatId: number, err: unknown): void {
    if (isChatGone(err)) {
      log.warn(`Чат ${chatId} недоступен (${describeError(err)}) — удаляю из подписчиков`);
      this.repo.removeSubscriber(chatId);
      return;
    }
    log.error(`Не удалось отправить сообщение в чат ${chatId}:`, describeError(err));
  }

  async text(text: string, opts: { exceptChatId?: number } = {}): Promise<void> {
    for (const chatId of this.chatIds()) {
      if (chatId === opts.exceptChatId) continue;
      try {
        await this.api.sendMessage(chatId, text);
      } catch (err) {
        this.handleError(chatId, err);
      }
    }
  }
}
