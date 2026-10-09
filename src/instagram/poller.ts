import { SETTING, type Repo } from '../db/repo.js';
import { describeError } from '../errors.js';
import { log } from '../logger.js';
import type { CommentService, IncomingComment } from '../pipeline/processor.js';
import type { IgComment, IgMedia, InstagramClient } from './client.js';

const MEDIA_LIMIT = 20;
// Раз в N циклов перечитываем комментарии всех постов, даже если comments_count не изменился
// (например, один комментарий удалили, а другой добавили за один интервал)
const FULL_SCAN_EVERY = 10;

interface PollerDeps {
  ig: InstagramClient;
  repo: Repo;
  service: CommentService;
  intervalMs: number;
  notify: (text: string) => Promise<void>;
}

export class Poller {
  private timer: NodeJS.Timeout | undefined;
  private current: Promise<void> | undefined;
  private stopped = false;
  private cycleNo = 0;
  private lastError: string | null = null;
  // comments_count по постам с прошлого цикла (включает ответы)
  private readonly lastCounts = new Map<string, number>();

  constructor(private readonly deps: PollerDeps) {}

  start(): void {
    this.schedule(0);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.current;
  }

  // Следующий цикл планируется только после завершения текущего — циклы не перекрываются
  private schedule(delayMs: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.current = this.cycle().finally(() => {
        this.current = undefined;
        this.schedule(this.deps.intervalMs);
      });
    }, delayMs);
  }

  private async cycle(): Promise<void> {
    const { ig, repo, service, notify } = this.deps;
    const initial = repo.getSetting(SETTING.initialized) !== '1';
    const fullScan = initial || this.cycleNo % FULL_SCAN_EVERY === 0;
    this.cycleNo++;

    try {
      const media = await ig.listRecentMedia(MEDIA_LIMIT);
      let seen = 0;

      for (const m of media) {
        if (this.stopped) return;
        const count = m.comments_count;
        if (!fullScan && count !== undefined && this.lastCounts.get(m.id) === count) continue;

        const list = await ig.listComments(m.id);
        list.sort((a, b) => (a.timestamp ?? '').localeCompare(b.timestamp ?? ''));
        for (const c of list) {
          const incoming = toIncoming(c, m);
          if (initial) {
            if (service.markSeen(incoming)) seen++;
          } else {
            service.enqueue(incoming);
          }
        }
        if (count !== undefined) this.lastCounts.set(m.id, count);
      }

      if (initial) {
        repo.setSetting(SETTING.initialized, '1');
        log.info(`Первичная инициализация: ${seen} комментариев помечены как просмотренные`);
        await notify(
          `🚀 Первый запуск: ${seen} существующих комментариев помечены как просмотренные. ` +
            'Дальше буду присылать только новые.',
        );
      }
      if (this.lastError) {
        this.lastError = null;
        await notify('✅ Опрос Instagram снова работает');
      }
    } catch (err) {
      const message = describeError(err);
      log.error('Ошибка опроса Instagram:', message);
      // Не спамим одной и той же ошибкой каждый цикл
      if (message !== this.lastError) {
        this.lastError = message;
        await notify(
          `❗ Ошибка опроса Instagram:\n${message}\n\nПовторю через ${Math.round(this.deps.intervalMs / 1000)} с.`,
        );
      }
    }
  }
}

function toIncoming(c: IgComment, m: IgMedia): IncomingComment {
  return {
    id: c.id,
    mediaId: m.id,
    parentId: c.parent_id ?? null,
    username: c.username ?? c.from?.username ?? null,
    fromId: c.from?.id ?? null,
    text: c.text ?? '',
    mediaCaption: m.caption ?? null,
    mediaPermalink: m.permalink ?? null,
  };
}
