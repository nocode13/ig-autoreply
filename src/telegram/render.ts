import { InlineKeyboard } from 'grammy';
import type { CommentRow } from '../db/schema.js';

export const CALLBACK = {
  send: 's',
  edit: 'e',
  regen: 'r',
  skip: 'x',
  retry: 't',
} as const;
export type CallbackAction = (typeof CALLBACK)[keyof typeof CALLBACK];

/** Маркер в тексте force_reply-запроса, по которому находим комментарий после ответа админа. */
export const EDIT_MARKER_RE = /#c(\d+)/;
export const editMarker = (commentId: string) => `#c${commentId}`;

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function truncate(text: string, max: number): string {
  const clean = text.trim();
  return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean;
}

const quote = (text: string, max: number) => `<blockquote>${escapeHtml(truncate(text, max))}</blockquote>`;

/** Разделитель между блоками карточки (в HTML-режиме Telegram нет <hr>). */
const SEPARATOR = '━━━━━━━━━━━━━━━━';

export function renderCard(c: CommentRow): string {
  const sections: string[][] = [];

  // Шапка
  const flagged = c.category === 'spam' || c.category === 'abuse';
  sections.push([flagged ? '⚠️ <b>КОММЕНТАРИЙ — похоже на спам/оскорбление</b>' : '💬 <b>НОВЫЙ КОММЕНТАРИЙ</b>']);

  // Пост
  const link = c.mediaPermalink ? ` · <a href="${escapeHtml(c.mediaPermalink)}">открыть</a>` : '';
  sections.push([
    `📌 <b>ПОСТ</b>${link}`,
    c.mediaCaption ? quote(c.mediaCaption, 150) : '<i>без подписи</i>',
  ]);

  // Комментарий
  const comment = [`👤 <b>КОММЕНТАРИЙ от @${escapeHtml(c.username ?? 'unknown')}</b>`];
  if (c.parentText) comment.push(`↪️ <i>в ответ на:</i>`, quote(c.parentText, 300));
  comment.push(quote(c.text, 1200));
  sections.push(comment);

  // Ответ бота
  const draft = ['🤖 <b>ОТВЕТ БОТА</b> <i>(черновик)</i>'];
  if (flagged) draft.push('🚫 <b>Рекомендую «Пропустить».</b>');
  if (c.draft) {
    draft.push(quote(c.draft, 1200));
  } else if (c.status === 'pending') {
    draft.push('<i>Черновика нет — нажми «Перегенерировать» или «Изменить».</i>');
  }
  if (c.draftNote) draft.push(`🗒 <i>${escapeHtml(truncate(c.draftNote, 300))}</i>`);
  if (c.regenHint && c.status === 'pending') {
    draft.push(`✍️ Уточнение: <i>${escapeHtml(truncate(c.regenHint, 300))}</i>`);
  }
  if (draft.length > 1) sections.push(draft);

  // Итог
  const by = c.handledBy ? ` (${escapeHtml(c.handledBy)})` : '';
  switch (c.status) {
    case 'sent':
      sections.push([`✅ <b>ОТПРАВЛЕНО${by}</b>`, quote(c.finalReply ?? '', 1000)]);
      break;
    case 'skipped':
      sections.push([`⏭ <b>ПРОПУЩЕНО${by}</b>`]);
      break;
    case 'error':
      sections.push([
        `❗ <b>ОШИБКА</b>`,
        `<code>${escapeHtml(truncate(c.error ?? 'неизвестная ошибка', 500))}</code>`,
      ]);
      break;
    case 'pending':
      break;
  }

  return sections.map((s) => s.join('\n')).join(`\n${SEPARATOR}\n`);
}

export function cardKeyboard(c: CommentRow): InlineKeyboard | undefined {
  const cb = (action: CallbackAction) => `${action}:${c.id}`;
  if (c.status === 'pending') {
    return new InlineKeyboard()
      .text('✅ Отправить', cb(CALLBACK.send))
      .text('✏️ Изменить', cb(CALLBACK.edit))
      .row()
      .text('🔄 Перегенерировать', cb(CALLBACK.regen))
      .text('❌ Пропустить', cb(CALLBACK.skip));
  }
  if (c.status === 'error') {
    return new InlineKeyboard()
      .text('🔁 Повторить', cb(CALLBACK.retry))
      .text('✏️ Изменить', cb(CALLBACK.edit))
      .row()
      .text('❌ Пропустить', cb(CALLBACK.skip));
  }
  return undefined;
}
