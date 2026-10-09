import Anthropic from '@anthropic-ai/sdk';
import { GrammyError, HttpError } from 'grammy';
import { IgApiError } from './instagram/client.js';

/** Человекочитаемое описание ошибки для уведомлений в Telegram. */
export function describeError(err: unknown): string {
  if (err instanceof IgApiError) return err.toString();

  // Порядок важен: APIConnectionError и остальные — подклассы APIError
  if (err instanceof Anthropic.APIConnectionError) return `Claude API: нет соединения (${err.message})`;
  if (err instanceof Anthropic.AuthenticationError) return 'Claude API 401: неверный ANTHROPIC_API_KEY';
  if (err instanceof Anthropic.RateLimitError) return 'Claude API 429: превышен лимит запросов';
  if (err instanceof Anthropic.APIError) return `Claude API ${err.status ?? ''}: ${err.message}`.trim();

  if (err instanceof GrammyError) return `Telegram API ${err.error_code}: ${err.description}`;
  if (err instanceof HttpError) return `Telegram: сетевая ошибка (${err.message})`;

  if (err instanceof Error) return err.message;
  return String(err);
}
