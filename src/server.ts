import type Database from 'better-sqlite3';
import Fastify, { type FastifyInstance } from 'fastify';
import { webhookRoutes, type WebhookOptions } from './instagram/webhook.js';

interface ServerDeps {
  mode: string;
  sqlite: Database.Database;
  webhook?: WebhookOptions;
}

export function createServer({ mode, sqlite, webhook }: ServerDeps): FastifyInstance {
  const app = Fastify({ logger: false, trustProxy: true });

  app.get('/health', async (_req, reply) => {
    try {
      sqlite.prepare('SELECT 1').get();
      return { ok: true, mode, uptimeSec: Math.round(process.uptime()) };
    } catch (err) {
      return reply.code(503).send({ ok: false, error: (err as Error).message });
    }
  });

  if (webhook) app.register(webhookRoutes, webhook);

  return app;
}
