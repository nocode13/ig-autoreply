import { log } from '../logger.js';

const GRAPH_HOST = 'https://graph.instagram.com';
export const GRAPH_VERSION = 'v25.0';
const BASE_URL = `${GRAPH_HOST}/${GRAPH_VERSION}`;
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_COMMENT_PAGES = 5;

const COMMENT_FIELDS = 'id,text,timestamp,username,from,parent_id';

export class IgApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: number,
    readonly subcode?: number,
    readonly fbtraceId?: string,
  ) {
    super(message);
    this.name = 'IgApiError';
  }

  /** OAuthException 190 — токен недействителен / истёк / отозван */
  get isAuthError(): boolean {
    return this.code === 190;
  }

  override toString(): string {
    const parts = [`Instagram API ${this.status}`];
    if (this.code !== undefined) parts.push(`code ${this.code}${this.subcode ? `/${this.subcode}` : ''}`);
    return `${parts.join(', ')}: ${this.message}`;
  }
}

export interface IgUser {
  id?: string;
  user_id?: string;
  username?: string;
}

export interface IgMedia {
  id: string;
  caption?: string;
  permalink?: string;
  comments_count?: number;
  timestamp?: string;
}

export interface IgComment {
  id: string;
  text?: string;
  timestamp?: string;
  username?: string;
  from?: { id: string; username?: string };
  parent_id?: string;
  replies?: { data: IgComment[] };
}

interface Paged<T> {
  data: T[];
  paging?: { next?: string };
}

export interface RefreshedToken {
  access_token: string;
  token_type: string;
  expires_in: number;
}

type Params = Record<string, string | number | undefined>;

async function parseResponse<T>(res: Response): Promise<T> {
  const body = (await res.json().catch(() => ({}))) as {
    error?: { message?: string; code?: number; error_subcode?: number; fbtrace_id?: string };
  };
  if (!res.ok || body.error) {
    const e = body.error ?? {};
    throw new IgApiError(
      e.message ?? `HTTP ${res.status}`,
      res.status,
      e.code,
      e.error_subcode,
      e.fbtrace_id,
    );
  }
  return body as unknown as T;
}

function buildUrl(base: string, params: Params): string {
  const url = new URL(base);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  return url.toString();
}

/** Обновление long-lived токена (эндпоинт без версии API). */
export async function refreshLongLivedToken(token: string): Promise<RefreshedToken> {
  const url = buildUrl(`${GRAPH_HOST}/refresh_access_token`, {
    grant_type: 'ig_refresh_token',
    access_token: token,
  });
  const res = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  return parseResponse<RefreshedToken>(res);
}

export class InstagramClient {
  constructor(
    private readonly getToken: () => string,
    private readonly onAuthError?: (err: IgApiError) => void,
  ) {}

  private async request<T>(method: 'GET' | 'POST', urlOrPath: string, params: Params = {}): Promise<T> {
    const isAbsolute = urlOrPath.startsWith('https://');
    // paging.next уже содержит access_token и все параметры
    const query: Params = isAbsolute ? {} : { ...params, access_token: this.getToken() };
    const base = isAbsolute ? urlOrPath : `${BASE_URL}${urlOrPath}`;

    let res: Response;
    try {
      if (method === 'GET') {
        res = await fetch(buildUrl(base, query), { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      } else {
        const body = new URLSearchParams();
        for (const [key, value] of Object.entries(query)) {
          if (value !== undefined) body.set(key, String(value));
        }
        res = await fetch(base, {
          method: 'POST',
          body,
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      }
    } catch (err) {
      throw new IgApiError(`сетевая ошибка: ${(err as Error).message}`, 0);
    }

    try {
      return await parseResponse<T>(res);
    } catch (err) {
      if (err instanceof IgApiError && err.isAuthError) this.onAuthError?.(err);
      throw err;
    }
  }

  getMe(): Promise<IgUser> {
    return this.request<IgUser>('GET', '/me', { fields: 'id,user_id,username' });
  }

  async listRecentMedia(limit: number): Promise<IgMedia[]> {
    const res = await this.request<Paged<IgMedia>>('GET', '/me/media', {
      fields: 'id,caption,permalink,comments_count,timestamp',
      limit,
    });
    return res.data;
  }

  getMedia(mediaId: string): Promise<IgMedia> {
    return this.request<IgMedia>('GET', `/${mediaId}`, { fields: 'id,caption,permalink' });
  }

  getComment(commentId: string): Promise<IgComment> {
    return this.request<IgComment>('GET', `/${commentId}`, { fields: COMMENT_FIELDS });
  }

  /** Комментарии к посту вместе с ответами, развёрнутые в плоский список. */
  async listComments(mediaId: string): Promise<IgComment[]> {
    const result: IgComment[] = [];
    let page = await this.request<Paged<IgComment>>('GET', `/${mediaId}/comments`, {
      fields: `${COMMENT_FIELDS},replies{${COMMENT_FIELDS}}`,
      limit: 50,
    });

    for (let i = 0; ; i++) {
      for (const comment of page.data) {
        const { replies, ...top } = comment;
        result.push(top);
        for (const reply of replies?.data ?? []) {
          result.push({ ...reply, parent_id: reply.parent_id ?? comment.id });
        }
      }
      const next = page.paging?.next;
      if (!next) break;
      if (i + 1 >= MAX_COMMENT_PAGES) {
        log.warn(`listComments(${mediaId}): достигнут лимит в ${MAX_COMMENT_PAGES} страниц`);
        break;
      }
      page = await this.request<Paged<IgComment>>('GET', next);
    }
    return result;
  }

  replyToComment(commentId: string, message: string): Promise<{ id: string }> {
    return this.request<{ id: string }>('POST', `/${commentId}/replies`, { message });
  }
}
