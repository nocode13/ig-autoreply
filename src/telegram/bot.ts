import type { Bot, Context } from 'grammy';
import type { Repo } from '../db/repo.js';
import { describeError } from '../errors.js';
import { InstagramClient } from '../instagram/client.js';
import type { TokenManager } from '../instagram/token.js';
import { log } from '../logger.js';
import type { Actor, CommentService, SelfIdentity } from '../pipeline/processor.js';
import type { Auth } from './auth.js';
import type { Broadcaster } from './broadcast.js';
import { CALLBACK, EDIT_MARKER_RE } from './render.js';

export const BOT_COMMANDS = [
  { command: 'start', description: 'Проверить, что бот жив' },
  { command: 'stats', description: 'Статистика по комментариям' },
  { command: 'pending', description: 'Повторно прислать все ожидающие' },
  { command: 'backup', description: 'Прислать бэкап базы сейчас' },
  { command: 'settoken', description: 'Заменить Instagram-токен' },
  { command: 'logout', description: 'Перестать получать комментарии' },
];

const LOGIN_HINT = '🔒 Чтобы получать комментарии, войди:\n/login <логин> <пароль>';
// Команды, доступные без входа
const PUBLIC_COMMAND_RE = /^\/(start|login)(@\w+)?(\s|$)/;

interface BotDeps {
  service: CommentService;
  repo: Repo;
  auth: Auth;
  broadcaster: Broadcaster;
  token: TokenManager;
  self: SelfIdentity;
  mode: string;
  sendBackup: (chatIds: number[]) => Promise<void>;
}

function displayName(ctx: Context): string {
  const from = ctx.from;
  if (!from) return 'кто-то';
  if (from.username) return `@${from.username}`;
  return [from.first_name, from.last_name].filter(Boolean).join(' ');
}

function actorOf(ctx: Context): Actor {
  return { chatId: ctx.chat!.id, name: displayName(ctx) };
}

export function registerBotHandlers(bot: Bot, deps: BotDeps): void {
  const { service, repo, auth, broadcaster } = deps;

  // Доступ только у вошедших чатов; без входа — /start и /login
  bot.use(async (ctx, next) => {
    const chat = ctx.chat;
    if (!chat) return;
    if (repo.isSubscriber(chat.id)) return next();

    const text = ctx.message?.text ?? '';
    if (PUBLIC_COMMAND_RE.test(text)) return next();
    if (ctx.callbackQuery) {
      await ctx.answerCallbackQuery({ text: '🔒 Нет доступа. Войди: /login' }).catch(() => undefined);
      return;
    }
    // В группах молчим, чтобы не спамить на каждое сообщение
    if (ctx.message && chat.type === 'private') await ctx.reply(LOGIN_HINT);
  });

  bot.command('start', async (ctx) => {
    if (!repo.isSubscriber(ctx.chat.id)) {
      await ctx.reply(LOGIN_HINT);
      return;
    }
    const stats = repo.stats();
    const account = deps.self.username ? `@${deps.self.username}` : 'не определён';
    await ctx.reply(
      `✅ Бот жив.\nРежим: ${deps.mode}\nInstagram: ${account}\n` +
        `Ожидают ответа: ${stats.pending}\nПодписчиков бота: ${repo.listSubscribers().length}`,
    );
  });

  bot.command('login', async (ctx) => {
    // Сообщение с паролем не оставляем в истории чата
    await ctx.deleteMessage().catch(() => undefined);
    if (repo.isSubscriber(ctx.chat.id)) {
      await ctx.reply('Ты уже вошёл 👌');
      return;
    }

    const [username = '', ...rest] = ctx.match.trim().split(/\s+/);
    const password = rest.join(' ');
    if (!username || !password) {
      await ctx.reply('Использование: /login <логин> <пароль>');
      return;
    }

    const result = auth.check(ctx.chat.id, username, password);
    if (!result.ok) {
      log.warn(`Неудачный вход из чата ${ctx.chat.id} (${displayName(ctx)})`);
      await ctx.reply(
        result.reason === 'locked'
          ? `⛔ Слишком много попыток. Попробуй через ${result.retryInMin} мин.`
          : '❌ Неверный логин или пароль',
      );
      return;
    }

    const name = displayName(ctx);
    repo.addSubscriber({
      chatId: ctx.chat.id,
      userId: ctx.from?.id ?? null,
      username: ctx.from?.username ?? null,
      name: ctx.chat.type === 'private' ? name : (ctx.chat.title ?? name),
      authHash: auth.hash,
    });
    log.info(`Вход: чат ${ctx.chat.id} (${name})`);

    const pending = repo.stats().pending;
    await ctx.reply(
      '🔓 Готово! Теперь сюда будут приходить новые комментарии.\n' +
        (pending ? `Ожидают ответа: ${pending} — прислать их: /pending\n` : '') +
        'Выйти: /logout',
    );
    await broadcaster.text(`👤 В бота вошёл ${name}`, { exceptChatId: ctx.chat.id });
    // Комментарии, которые пришли, пока подписчиков не было
    service.recoverUndelivered();
  });

  bot.command('logout', async (ctx) => {
    repo.removeSubscriber(ctx.chat.id);
    log.info(`Выход: чат ${ctx.chat.id} (${displayName(ctx)})`);
    await ctx.reply('👋 Ты вышел. Комментарии сюда больше не придут.');
  });

  bot.command('stats', async (ctx) => {
    const s = repo.stats();
    await ctx.reply(
      [
        '📊 Комментарии:',
        `⏳ pending: ${s.pending}`,
        `✅ sent: ${s.sent}`,
        `⏭ skipped: ${s.skipped}`,
        `❗ error: ${s.error}`,
      ].join('\n'),
    );
  });

  bot.command('pending', async (ctx) => {
    const count = await service.resendPending(ctx.chat.id);
    if (count === 0) await ctx.reply('Нет комментариев в ожидании 👌');
  });

  bot.command('backup', async (ctx) => {
    try {
      await deps.sendBackup([ctx.chat.id]);
    } catch (err) {
      await ctx.reply(`❗ Бэкап не удался: ${describeError(err)}`);
    }
  });

  bot.command('settoken', async (ctx) => {
    const token = ctx.match.trim();
    // Сообщение с токеном не оставляем в истории чата
    await ctx.deleteMessage().catch(() => undefined);
    if (!token) {
      await ctx.reply('Использование: /settoken <long-lived токен Instagram>');
      return;
    }
    try {
      const me = await new InstagramClient(() => token).getMe();
      deps.token.save(token);
      await ctx.reply(`🔑 Токен сохранён (аккаунт @${me.username ?? '?'}). Следующее автообновление — через 50 дней.`);
      await broadcaster.text(`🔑 ${displayName(ctx)} обновил Instagram-токен`, { exceptChatId: ctx.chat.id });
    } catch (err) {
      await ctx.reply(`❗ Токен не подошёл: ${describeError(err)}`);
    }
  });

  bot.on('callback_query:data', async (ctx) => {
    const data = ctx.callbackQuery.data;
    const sep = data.indexOf(':');
    const action = data.slice(0, sep);
    const id = data.slice(sep + 1);
    const actor = actorOf(ctx);

    let toast: string;
    try {
      switch (action) {
        case CALLBACK.send:
          toast = await service.approve(id, actor);
          break;
        case CALLBACK.edit:
          toast = await service.startEdit(id, actor);
          break;
        case CALLBACK.regen:
          toast = await service.regenerate(id, actor);
          break;
        case CALLBACK.skip:
          toast = await service.skip(id, actor);
          break;
        case CALLBACK.retry:
          toast = await service.retry(id, actor);
          break;
        default:
          toast = 'Неизвестное действие';
      }
    } catch (err) {
      log.error(`Ошибка действия ${action} для ${id}:`, err);
      toast = `❗ ${describeError(err)}`;
    }
    // Ответ на старый callback может упасть («query is too old») — это не страшно
    await ctx.answerCallbackQuery({ text: toast.slice(0, 190) }).catch(() => undefined);
  });

  bot.on('message:text', async (ctx) => {
    const text = ctx.message.text.trim();
    if (text.startsWith('/')) return;

    const replyTo = ctx.message.reply_to_message;
    const replyParams = { reply_parameters: { message_id: ctx.message.message_id } };

    if (!replyTo) {
      if (ctx.chat.type !== 'private') return;
      await ctx.reply(
        'Чтобы отправить свой текст — нажми «✏️ Изменить» на карточке.\n' +
          'Чтобы уточнить черновик — ответь текстом на карточку и нажми «🔄 Перегенерировать».',
      );
      return;
    }

    // Ответ на force_reply-запрос «✏️ Изменить»
    const marker = replyTo.from?.id === ctx.me.id ? replyTo.text?.match(EDIT_MARKER_RE) : null;
    if (marker?.[1]) {
      await ctx.reply(await service.submitEdit(marker[1], text, actorOf(ctx)), replyParams);
      return;
    }

    // Ответ текстом на карточку — уточнение для перегенерации
    const card = repo.findCardMessage(ctx.chat.id, replyTo.message_id);
    if (card) {
      await ctx.reply(await service.saveHint(card.commentId, text), replyParams);
    }
  });

  bot.catch((err) => {
    log.error('Ошибка в обработчике Telegram:', err.error);
  });
}
