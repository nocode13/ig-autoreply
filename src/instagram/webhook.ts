import crypto from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import { log } from '../logger.js';
import type { IncomingComment } from '../pipeline/processor.js';

export interface WebhookOptions {
  verifyToken: string;
  appSecret: string;
  onComment: (comment: IncomingComment) => void;
}

interface CommentChangeValue {
  id?: string;
  text?: string;
  from?: { id?: string; username?: string };
  media?: { id?: string; media_product_type?: string };
  parent_id?: string;
}

interface WebhookPayload {
  object?: string;
  entry?: Array<{
    id?: string;
    time?: number;
    changes?: Array<{ field?: string; value?: CommentChangeValue }>;
  }>;
}

export function verifySignature(raw: Buffer, header: string | undefined, secret: string): boolean {
  if (!header?.startsWith('sha256=')) return false;
  const expected = crypto.createHmac('sha256', secret).update(raw).digest();
  const received = Buffer.from(header.slice('sha256='.length), 'hex');
  return received.length === expected.length && crypto.timingSafeEqual(received, expected);
}

function handlePayload(raw: Buffer, onComment: (c: IncomingComment) => void): void {
  let payload: WebhookPayload;
  try {
    payload = JSON.parse(raw.toString('utf8')) as WebhookPayload;
  } catch {
    log.warn('Webhook: тело не является JSON');
    return;
  }
  if (payload.object !== 'instagram') {
    log.warn(`Webhook: неожиданный object=${payload.object}`);
    return;
  }

  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      if (change.field !== 'comments') continue;
      const v = change.value;
      if (!v?.id || !v.media?.id) continue;
      onComment({
        id: v.id,
        mediaId: v.media.id,
        parentId: v.parent_id ?? null,
        username: v.from?.username ?? null,
        fromId: v.from?.id ?? null,
        text: v.text ?? '',
      });
    }
  }
}

/**
 * Регистрируется без fastify-plugin, т.е. инкапсулированно: парсер сырого тела
 * действует только на маршруты этого плагина.
 */
export const webhookRoutes: FastifyPluginAsync<WebhookOptions> = async (app, opts) => {
  // Для проверки подписи нужно тело байт-в-байт, поэтому JSON не парсим автоматически
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer', bodyLimit: 1024 * 1024 },
    (_req, body, done) => done(null, body),
  );

  app.get('/webhook', async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    if (q['hub.mode'] === 'subscribe' && q['hub.verify_token'] === opts.verifyToken) {
      log.info('Webhook: верификация пройдена');
      return reply.type('text/plain').send(q['hub.challenge'] ?? '');
    }
    log.warn('Webhook: неверный verify_token');
    return reply.code(403).send('Forbidden');
  });

  app.post('/webhook', async (req, reply) => {
    const raw = req.body;
    const signature = req.headers['x-hub-signature-256'];
    if (
      !Buffer.isBuffer(raw) ||
      !verifySignature(raw, typeof signature === 'string' ? signature : undefined, opts.appSecret)
    ) {
      log.warn('Webhook: неверная подпись X-Hub-Signature-256');
      return reply.code(401).send('Invalid signature');
    }

    // Meta ждёт 200 быстро; обработка — асинхронно, после ответа
    setImmediate(() => {
      try {
        handlePayload(raw, opts.onComment);
      } catch (err) {
        log.error('Webhook: ошибка обработки', err);
      }
    });
    return reply.code(200).send('EVENT_RECEIVED');
  });
};
