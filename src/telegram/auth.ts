import crypto from 'node:crypto';

const MAX_FAILED_ATTEMPTS = 5;
const LOCK_MS = 15 * 60 * 1000;

const sha256 = (value: string) => crypto.createHash('sha256').update(value).digest();

/** Хэш пары логин/пароль: хранится у подписчика, чтобы смена пароля разлогинивала всех. */
export function authHash(username: string, password: string): string {
  return sha256(`${username}\n${password}`).toString('hex');
}

type LoginResult = { ok: true } | { ok: false; reason: 'invalid' | 'locked'; retryInMin?: number };

export class Auth {
  private readonly failures = new Map<number, { count: number; lockedUntil: number }>();
  readonly hash: string;

  constructor(
    private readonly username: string,
    private readonly password: string,
  ) {
    this.hash = authHash(username, password);
  }

  /** Проверка с ограничением попыток: после 5 неудач чат блокируется на 15 минут. */
  check(chatId: number, username: string, password: string): LoginResult {
    const now = Date.now();
    let state = this.failures.get(chatId);
    if (state && state.lockedUntil > now) {
      return { ok: false, reason: 'locked', retryInMin: Math.ceil((state.lockedUntil - now) / 60_000) };
    }
    // Блокировка истекла — считаем попытки заново
    if (state?.lockedUntil) state = undefined;

    // Сравниваем хэши фиксированной длины за постоянное время
    const userOk = crypto.timingSafeEqual(sha256(username), sha256(this.username));
    const passOk = crypto.timingSafeEqual(sha256(password), sha256(this.password));
    if (userOk && passOk) {
      this.failures.delete(chatId);
      return { ok: true };
    }

    const count = (state?.count ?? 0) + 1;
    if (count >= MAX_FAILED_ATTEMPTS) {
      this.failures.set(chatId, { count, lockedUntil: now + LOCK_MS });
      return { ok: false, reason: 'locked', retryInMin: LOCK_MS / 60_000 };
    }
    this.failures.set(chatId, { count, lockedUntil: 0 });
    return { ok: false, reason: 'invalid' };
  }
}
