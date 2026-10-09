/**
 * Прогон генерации черновика без Instagram и Telegram.
 *
 *   pnpm test:draft
 *   pnpm test:draft "Narxi qancha?" --caption "Yangi kolleksiya" --username ali
 *   pnpm test:draft "Согласен!" --parent "@shop (это ваш аккаунт): Доставка бесплатная" --hint "предложи промокод"
 *
 * Нужен только ANTHROPIC_API_KEY (из .env или окружения).
 */
import 'dotenv/config';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { buildUserMessage, createDrafter, DRAFT_MODEL, type DraftContext } from '../ai/drafter.js';
import { describeError } from '../errors.js';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    caption: { type: 'string', short: 'c' },
    parent: { type: 'string', short: 'p' },
    username: { type: 'string', short: 'u' },
    hint: { type: 'string' },
    previous: { type: 'string' },
  },
});

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
  console.error('Задай ANTHROPIC_API_KEY в .env или окружении');
  process.exit(1);
}

const ctx: DraftContext = {
  username: values.username ?? 'test_user',
  text: positionals.join(' ') || 'Здравствуйте! Сколько стоит доставка по Ташкенту?',
  caption: values.caption ?? 'Новая коллекция уже в наличии 🌿 Пишите в директ для заказа.',
  parentText: values.parent ?? null,
  hint: values.hint ?? null,
  previousDraft: values.previous ?? null,
};

console.log(`Модель: ${DRAFT_MODEL}\n\n--- Сообщение для Claude ---\n${buildUserMessage(ctx)}\n`);

try {
  const drafter = createDrafter(apiKey, path.resolve('prompts/reply.md'));
  const started = Date.now();
  const draft = await drafter.generate(ctx);
  console.log(`--- Результат (${Date.now() - started} мс) ---`);
  console.log(JSON.stringify(draft, null, 2));
} catch (err) {
  console.error(`Ошибка: ${describeError(err)}`);
  process.exit(1);
}
