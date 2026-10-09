import { SETTING, type Repo } from '../db/repo.js';
import { describeError } from '../errors.js';
import { log } from '../logger.js';
import { refreshLongLivedToken } from './client.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const REFRESH_AFTER_MS = 50 * DAY_MS;
// Если до истечения осталось меньше — обновляем, даже если 50 дней ещё не прошло
const REFRESH_BEFORE_EXPIRY_MS = 7 * DAY_MS;
// Повторные алерты о неудачном обновлении — не чаще раза в сутки
const FAILURE_ALERT_INTERVAL_MS = DAY_MS;

export class TokenManager {
  private token = '';

  constructor(
    private readonly repo: Repo,
    private readonly notify: (text: string) => Promise<void>,
  ) {}

  /** Берёт токен из БД; если там пусто — сидирует из env. */
  init(envToken: string | undefined): void {
    const stored = this.repo.getSetting(SETTING.igAccessToken);
    if (stored) {
      this.token = stored;
      return;
    }
    if (!envToken) {
      throw new Error('В БД нет Instagram-токена и не задан IG_ACCESS_TOKEN');
    }
    this.save(envToken);
    log.info('Instagram-токен взят из IG_ACCESS_TOKEN и сохранён в БД');
  }

  get(): string {
    return this.token;
  }

  /** Ручная замена токена (команда /settoken). Точный возраст неизвестен — считаем, что он свежий. */
  save(token: string, expiresAt?: number): void {
    const now = Date.now();
    this.token = token;
    this.repo.setSetting(SETTING.igAccessToken, token);
    this.repo.setSetting(SETTING.igTokenRefreshedAt, String(now));
    if (expiresAt) this.repo.setSetting(SETTING.igTokenExpiresAt, String(expiresAt));
    else this.repo.deleteSetting(SETTING.igTokenExpiresAt);
    this.repo.deleteSetting(SETTING.igTokenRefreshFailedAt);
  }

  isRefreshDue(now = Date.now()): boolean {
    const refreshedAt = Number(this.repo.getSetting(SETTING.igTokenRefreshedAt) ?? 0);
    const expiresAt = Number(this.repo.getSetting(SETTING.igTokenExpiresAt) ?? 0);
    if (now - refreshedAt >= REFRESH_AFTER_MS) return true;
    return expiresAt > 0 && expiresAt - now <= REFRESH_BEFORE_EXPIRY_MS;
  }

  async refreshIfDue(): Promise<void> {
    if (!this.isRefreshDue()) return;
    await this.refresh();
  }

  async refresh(): Promise<void> {
    try {
      const res = await refreshLongLivedToken(this.token);
      const expiresAt = Date.now() + res.expires_in * 1000;
      this.save(res.access_token, expiresAt);
      log.info(`Instagram-токен обновлён, действует до ${new Date(expiresAt).toISOString()}`);
      await this.notify(
        `🔑 Instagram-токен обновлён. Действует до ${new Date(expiresAt).toLocaleDateString('ru-RU')}.`,
      );
    } catch (err) {
      log.error('Не удалось обновить Instagram-токен:', err);
      const lastAlert = Number(this.repo.getSetting(SETTING.igTokenRefreshFailedAt) ?? 0);
      if (Date.now() - lastAlert >= FAILURE_ALERT_INTERVAL_MS) {
        this.repo.setSetting(SETTING.igTokenRefreshFailedAt, String(Date.now()));
        await this.notify(
          `❗ Не удалось обновить Instagram-токен:\n${describeError(err)}\n\n` +
            'Повторю попытку через час. Если токен уже истёк — сгенерируй новый ' +
            'и пришли его боту командой /settoken <токен>.',
        );
      }
    }
  }
}
