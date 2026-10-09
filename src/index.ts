import 'dotenv/config';
import path from 'node:path';
import { Bot } from 'grammy';
import { createDrafter } from './ai/drafter.js';
import { backupIfDue, sendBackup } from './backup/backup.js';
import { loadEnv, type Env } from './config/env.js';
import { openDatabase } from './db/client.js';
import { Repo, SETTING } from './db/repo.js';
import { describeError } from './errors.js';
import { InstagramClient, type IgApiError } from './instagram/client.js';
import { Poller } from './instagram/poller.js';
import { TokenManager } from './instagram/token.js';
import { log, sleep } from './logger.js';
import { CommentService, type SelfIdentity } from './pipeline/processor.js';
import { createServer } from './server.js';
import { Auth } from './telegram/auth.js';
import { BOT_COMMANDS, registerBotHandlers } from './telegram/bot.js';
import { Broadcaster } from './telegram/broadcast.js';

const HOUR_MS = 60 * 60 * 1000;
const AUTH_ALERT_INTERVAL_MS = 6 * HOUR_MS;

async function resolveSelf(
  ig: InstagramClient,
  env: Env,
  notify: (text: string) => Promise<void>,
): Promise<SelfIdentity> {
  const self: SelfIdentity = { ids: new Set([env.IG_USER_ID]), username: null };
  try {
    const me = await ig.getMe();
    if (me.id) self.ids.add(me.id);
    if (me.user_id) self.ids.add(me.user_id);
    self.username = me.username ?? null;
    if (me.user_id && me.user_id !== env.IG_USER_ID) {
      log.warn(`IG_USER_ID=${env.IG_USER_ID} не совпадает с user_id из /me (${me.user_id})`);
    }
    log.info(`Instagram-аккаунт: @${self.username ?? '?'}`);
  } catch (err) {
    log.error('Не удалось получить профиль Instagram:', describeError(err));
    await notify(`❗ Не удалось получить профиль Instagram (GET /me):\n${describeError(err)}`);
  }
  return self;
}

async function main(): Promise<void> {
  const env = loadEnv();
  const { sqlite, db } = openDatabase(env.DB_PATH);
  const repo = new Repo(db);
  log.info(`БД открыта: ${env.DB_PATH}, режим: ${env.MODE}`);

  // Логин/пароль сменились — вошедшие со старыми данными теряют доступ
  const auth = new Auth(env.AUTH_USERNAME, env.AUTH_PASSWORD);
  const pruned = repo.pruneSubscribers(auth.hash);
  if (pruned.length) log.info(`AUTH_* изменились — разлогинено чатов: ${pruned.length}`);

  // bot.api работает и до запуска long polling — уведомления можно слать сразу
  const bot = new Bot(env.TELEGRAM_BOT_TOKEN);
  const broadcaster = new Broadcaster(bot.api, repo);
  const notify = (text: string) => broadcaster.text(text);

  const token = new TokenManager(repo, notify);
  token.init(env.IG_ACCESS_TOKEN);

  let lastAuthAlert = 0;
  const ig = new InstagramClient(
    () => token.get(),
    (err: IgApiError) => {
      if (Date.now() - lastAuthAlert < AUTH_ALERT_INTERVAL_MS) return;
      lastAuthAlert = Date.now();
      void notify(
        `❗ Instagram отклоняет токен:\n${err.toString()}\n\nСгенерируй новый и пришли его командой /settoken <токен>.`,
      );
    },
  );

  const self = await resolveSelf(ig, env, notify);
  const drafter = createDrafter(env.ANTHROPIC_API_KEY, path.resolve('prompts/reply.md'));
  const service = new CommentService({ repo, ig, drafter, broadcaster, self });

  const backupDeps = { sqlite, broadcaster, repo };
  registerBotHandlers(bot, {
    service,
    repo,
    auth,
    broadcaster,
    token,
    self,
    mode: env.MODE,
    sendBackup: async (chatIds) => {
      await sendBackup(backupDeps, chatIds);
    },
  });

  // --- HTTP: /health и (в режиме webhook) /webhook ---
  const server = createServer({
    mode: env.MODE,
    sqlite,
    webhook:
      env.MODE === 'webhook'
        ? {
            verifyToken: env.META_VERIFY_TOKEN!,
            appSecret: env.META_APP_SECRET!,
            onComment: (c) => service.enqueue(c),
          }
        : undefined,
  });
  await server.listen({ port: env.PORT, host: '0.0.0.0' });
  log.info(`HTTP-сервер слушает порт ${env.PORT}`);

  // --- Telegram long polling (с перезапуском при сетевых сбоях) ---
  let stopping = false;
  const botLoop = (async () => {
    while (!stopping) {
      try {
        await bot.start({
          allowed_updates: ['message', 'callback_query'],
          onStart: (me) => {
            log.info(`Telegram-бот @${me.username} запущен`);
            bot.api.setMyCommands(BOT_COMMANDS).catch((err) => log.warn('setMyCommands:', err));
          },
        });
        return; // штатная остановка через bot.stop()
      } catch (err) {
        if (stopping) return;
        log.error('Long polling Telegram упал, перезапуск через 5 с:', describeError(err));
        await sleep(5000);
      }
    }
  })();

  // --- Источник комментариев ---
  let poller: Poller | undefined;
  if (env.MODE === 'polling') {
    poller = new Poller({ ig, repo, service, intervalMs: env.POLL_INTERVAL_SEC * 1000, notify });
    poller.start();
  } else {
    // Webhook присылает только новые комментарии — первичная инициализация не нужна
    repo.setSetting(SETTING.initialized, '1');
  }

  // --- Ежечасные задачи: токен, бэкап, недоставленные карточки ---
  const maintenance = async () => {
    await token.refreshIfDue().catch((err) => log.error('refreshIfDue:', err));
    await backupIfDue(backupDeps).catch(async (err) => {
      log.error('Бэкап не удался:', err);
      await notify(`❗ Ежедневный бэкап не удался:\n${describeError(err)}`);
    });
    service.recoverUndelivered();
  };
  const firstMaintenance = setTimeout(() => void maintenance(), 30_000);
  const maintenanceInterval = setInterval(() => void maintenance(), HOUR_MS);

  // --- Graceful shutdown ---
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info(`${signal}: останавливаюсь…`);
    setTimeout(() => {
      log.error('Не удалось остановиться за 15 с — выхожу принудительно');
      process.exit(1);
    }, 15_000).unref();

    clearTimeout(firstMaintenance);
    clearInterval(maintenanceInterval);
    try {
      await poller?.stop();
      if (bot.isRunning()) await bot.stop();
      await botLoop;
      await server.close();
      await service.close(10_000);
    } catch (err) {
      log.error('Ошибка при остановке:', err);
    } finally {
      sqlite.close();
      log.info('Остановлен');
      process.exit(0);
    }
  };
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));
}

process.on('unhandledRejection', (err) => log.error('unhandledRejection:', err));

main().catch((err) => {
  log.error('Не удалось запустить сервис:', err);
  process.exit(1);
});
