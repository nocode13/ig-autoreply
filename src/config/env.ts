import { z } from 'zod';

const EnvSchema = z
  .object({
    ANTHROPIC_API_KEY: z.string().min(1),
    TELEGRAM_BOT_TOKEN: z.string().regex(/^\d+:[\w-]+$/, 'ожидается токен вида 123456:ABC...'),
    // Логин и пароль для входа в бота (/login). Смена значений разлогинивает всех.
    AUTH_USERNAME: z.string().min(1),
    AUTH_PASSWORD: z.string().min(8, 'минимум 8 символов'),
    // Только начальное значение: если в БД токена ещё нет
    IG_ACCESS_TOKEN: z.string().min(1).optional(),
    IG_USER_ID: z.string().regex(/^\d+$/, 'ожидается числовой ID'),
    META_APP_SECRET: z.string().min(1).optional(),
    META_VERIFY_TOKEN: z.string().min(1).optional(),
    DB_PATH: z.string().min(1).default('./data/app.db'),
    MODE: z.enum(['polling', 'webhook']).default('polling'),
    POLL_INTERVAL_SEC: z.coerce.number().int().min(30).default(120),
    PORT: z.coerce.number().int().positive().default(3000),
  })
  .superRefine((env, ctx) => {
    if (env.MODE !== 'webhook') return;
    for (const key of ['META_APP_SECRET', 'META_VERIFY_TOKEN'] as const) {
      if (!env[key]) {
        ctx.addIssue({ code: 'custom', path: [key], message: 'обязательна при MODE=webhook' });
      }
    }
  });

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  // Пустые строки (KEY=) считаем незаданными, иначе optional/default не сработают
  const cleaned = Object.fromEntries(
    Object.entries(source).filter(([, value]) => value !== undefined && value.trim() !== ''),
  );
  const result = EnvSchema.safeParse(cleaned);
  if (!result.success) {
    console.error(`Некорректные переменные окружения:\n${z.prettifyError(result.error)}`);
    process.exit(1);
  }
  return result.data;
}
