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

export function renderCard(c: CommentRow): string {
  const lines: string[] = [];

  const flagged = c.category === 'spam' || c.category === 'abuse';
  lines.push(flagged ? '⚠️ <b>Комментарий (похоже на спам/оскорбление)</b>' : '💬 <b>Новый комментарий</b>');
  lines.push(`👤 <b>@${escapeHtml(c.username ?? 'unknown')}</b>`);

  const caption = c.mediaCaption ? escapeHtml(truncate(c.mediaCaption, 150)) : '<i>без подписи</i>';
  const link = c.mediaPermalink ? ` — <a href="${escapeHtml(c.mediaPermalink)}">открыть пост</a>` : '';
  lines.push(`📝 ${caption}${link}`);

  if (c.parentText) lines.push(`↪️ В ответ на:\n${quote(c.parentText, 300)}`);
  lines.push(quote(c.text, 1200));

  if (flagged) {
    lines.push('🚫 <b>Рекомендую «Пропустить».</b>');
  }
  if (c.draft) {
    lines.push(`🤖 <b>Черновик:</b>\n${escapeHtml(truncate(c.draft, 1200))}`);
  } else if (c.status === 'pending') {
    lines.push('🤖 <i>Черновика нет — нажми «Перегенерировать» или «Изменить».</i>');
  }
  if (c.draftNote) lines.push(`🗒 <i>${escapeHtml(truncate(c.draftNote, 300))}</i>`);
  if (c.regenHint && c.status === 'pending') {
    lines.push(`✍️ Уточнение: <i>${escapeHtml(truncate(c.regenHint, 300))}</i>`);
  }

  const by = c.handledBy ? ` (${escapeHtml(c.handledBy)})` : '';
  switch (c.status) {
    case 'sent':
      lines.push(`✅ <b>Отправлено${by}:</b>\n${escapeHtml(truncate(c.finalReply ?? '', 1000))}`);
      break;
    case 'skipped':
      lines.push(`⏭ <b>Пропущено${by}</b>`);
      break;
    case 'error':
      lines.push(`❗ <b>Ошибка:</b> <code>${escapeHtml(truncate(c.error ?? 'неизвестная ошибка', 500))}</code>`);
      break;
    case 'pending':
      break;
  }

  return lines.join('\n\n');
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
