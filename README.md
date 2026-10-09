# ig-autoreply

Автоответчик на комментарии в Instagram с апрувом через Telegram.

1. Сервис получает новые комментарии под постами вашего Instagram Business/Creator аккаунта (polling или webhook).
2. Claude (`claude-haiku-4-5`) пишет черновик ответа по правилам из [prompts/reply.md](prompts/reply.md).
3. Всем вошедшим в бота приходит карточка: автор, комментарий, подпись поста со ссылкой, черновик и кнопки
   **✅ Отправить · ✏️ Изменить · 🔄 Перегенерировать · ❌ Пропустить**.
4. После «Отправить» ответ публикуется в Instagram. Карточка у всех получает статус «Отправлено (@кто)»,
   а остальным приходит уведомление, кто и что ответил.

Стек: Node.js 22, TypeScript, Fastify, grammY, @anthropic-ai/sdk, SQLite (better-sqlite3) + Drizzle ORM, pnpm.

---

## Как пользоваться ботом

### Вход

Бот пускает только по логину и паролю из `AUTH_USERNAME` / `AUTH_PASSWORD`:

```
/login admin мой-пароль
```

Сообщение с паролем бот сразу удаляет. После входа чат запоминается (по chat id), и туда начинают
приходить карточки. Войти можно с нескольких аккаунтов, а также из группы — тогда карточки придут всем её участникам.
В группе бот сможет удалить сообщение с паролем, только если он администратор, поэтому надёжнее войти в личке.

- Кто-то нажал «Отправить» или «Пропустить» — карточка обновляется у всех, остальным приходит уведомление
  вида «✅ @ivan отправил ответ на комментарий @user …».
- Новый вход тоже виден остальным: «👤 В бота вошёл @ivan».
- После 5 неверных паролей подряд чат блокируется на 15 минут.
- `/logout` — перестать получать карточки.
- Смена `AUTH_USERNAME` или `AUTH_PASSWORD` разлогинивает всех при следующем старте.
- Если бота заблокировали или удалили из группы, чат автоматически удаляется из подписчиков.

### Карточки

| Действие | Что происходит |
|---|---|
| ✅ Отправить | Черновик уходит ответом на комментарий в Instagram |
| ✏️ Изменить | Бот просит прислать свой текст (ответом на его сообщение) — ваш текст уходит в Instagram |
| Ответить текстом **на карточку** | Текст сохраняется как уточнение («короче», «предложи скидку 10%»…) |
| 🔄 Перегенерировать | Новый черновик с учётом уточнения, если оно есть |
| ❌ Пропустить | Комментарий помечается как пропущенный |
| 🔁 Повторить | Появляется при ошибке Instagram/Claude API: повторяет генерацию или отправку |

Комментарии, которые Claude считает спамом или оскорблением, помечаются ⚠️ — их рекомендуется пропускать.
Ответы в ветке публикуются в ту же ветку с упоминанием `@автора`.

Команды:

- `/start` — проверка, что бот жив;
- `/login <логин> <пароль>` / `/logout` — вход и выход;
- `/stats` — сколько комментариев в статусах pending / sent / skipped / error;
- `/pending` — заново прислать в этот чат карточки всех pending;
- `/backup` — прислать бэкап базы в этот чат (автоматически — раз в сутки всем);
- `/settoken <токен>` — заменить Instagram-токен (если он всё-таки истёк).

Без входа бот отвечает только на `/start` и `/login`. Служебные уведомления (ошибки опроса, обновление
токена, бэкап) получают все вошедшие чаты.

---

## 1. Meta-приложение (Instagram API with Instagram Login)

Нужен **профессиональный** аккаунт Instagram (Business или Creator). Facebook-страница не нужна.

1. Откройте [developers.facebook.com/apps](https://developers.facebook.com/apps) → **Create app**.
2. Use case: **Manage messaging & content on Instagram** (это и есть Instagram API with Instagram Login).
   Тип приложения — **Business**. Завершите создание.
3. В приложении: **Use cases → Instagram API → Customize → API setup with Instagram login**.
4. Добавьте свой аккаунт тестером: **App roles → Roles → Add People → Instagram Tester**, введите ник.
5. Примите приглашение в Instagram: **Настройки → Приложения и сайты → Приглашения тестировщика** → Принять
   (или в браузере: `instagram.com/accounts/manage_access/` → вкладка «Приглашения тестировщика»).

В режиме разработки (Development) приложение может читать комментарии и отвечать на них только для
аккаунтов, у которых есть роль в приложении. Для MODE=polling этого достаточно.

## 2. Токен и IG_USER_ID

1. На странице **API setup with Instagram login**, раздел **Generate access tokens** → **Add account**.
   Войдите в свой Instagram и разрешите доступ (`instagram_business_basic`, `instagram_business_manage_comments`).
2. Нажмите **Generate token** напротив аккаунта и скопируйте токен. Это long-lived токен (60 дней) → `IG_ACCESS_TOKEN`.
3. Узнайте ID аккаунта:

   ```bash
   curl "https://graph.instagram.com/v25.0/me?fields=user_id,username&access_token=ВАШ_ТОКЕН"
   # {"user_id":"17841400000000000","username":"myshop","id":"..."}
   ```

   Значение `user_id` → `IG_USER_ID`.

Токен из env используется только при первом запуске. Затем он хранится в таблице `settings`,
и сервис сам обновляет его раз в ~50 дней (`GET /refresh_access_token`). Если обновить токен не получилось,
придёт сообщение в Telegram. Новый токен можно прислать командой `/settoken <токен>`.

## 3. Telegram-бот

1. Напишите [@BotFather](https://t.me/BotFather) → `/newbot` → получите токен → `TELEGRAM_BOT_TOKEN`.
2. Придумайте логин и пароль (пароль от 8 символов) → `AUTH_USERNAME`, `AUTH_PASSWORD`.
3. После деплоя напишите боту `/login <логин> <пароль>`.

Комментарии, пришедшие до первого входа, не теряются: первый вошедший получит их карточки.

## 4. Деплой на Railway

1. Один раз установите зависимости локально, чтобы появился `pnpm-lock.yaml` (Dockerfile ставит пакеты по lock-файлу):

   ```bash
   pnpm install
   ```

   Закоммитьте `pnpm-lock.yaml` и запушьте репозиторий на GitHub.
2. [railway.com](https://railway.com) → **New Project → Deploy from GitHub repo** → выберите репозиторий.
   Railway соберёт образ по `Dockerfile` (это настроено в `railway.json`).
3. Сервис → **Settings → Volumes → Add Volume**, mount path: `/data`.
4. Сервис → **Variables** — заполните переменные (см. [.env.example](.env.example)):

   | Переменная | Значение |
   |---|---|
   | `ANTHROPIC_API_KEY` | ключ из [console.anthropic.com](https://console.anthropic.com) |
   | `TELEGRAM_BOT_TOKEN` | из шага 3 |
   | `AUTH_USERNAME` | из шага 3 |
   | `AUTH_PASSWORD` | из шага 3 |
   | `IG_ACCESS_TOKEN` | из шага 2 |
   | `IG_USER_ID` | из шага 2 |
   | `DB_PATH` | `/data/app.db` |
   | `MODE` | `polling` |
   | `POLL_INTERVAL_SEC` | `120` |

   `PORT` Railway задаёт сам.
5. Задеплойте. Health check — `GET /health`. Миграции БД применяются автоматически при старте.

Напишите боту `/login <логин> <пароль>`. Старые комментарии при первом запуске помечаются как просмотренные
и не присылаются — дальше будут приходить только новые.

> На Railway сервис с Volume перезапускается с коротким простоем: старый инстанс останавливается до старта нового.
> Поэтому два бота одновременно не опрашивают Telegram. Держите 1 реплику.

## 5. Переход на MODE=webhook

Webhook доставляет комментарии мгновенно, без опроса API. Требования Meta:

1. **Advanced Access** для `instagram_business_basic` и `instagram_business_manage_comments` через **App Review**.
   Понадобятся: верификация бизнеса, Privacy Policy URL, скринкаст использования и описание сценария.
2. Приложение в режиме **Live**: переключатель **App Mode** вверху App Dashboard.
3. Аккаунт Instagram должен быть **публичным**.

Настройка:

1. Railway → сервис → **Settings → Networking → Generate Domain**.
2. В переменные добавьте:
   - `MODE=webhook`;
   - `META_VERIFY_TOKEN` — любая случайная строка (например, `openssl rand -hex 16`);
   - `META_APP_SECRET` — **Instagram app secret** со страницы **API setup with Instagram login**
     (это не секрет из App settings → Basic). Им подписываются вебхуки Instagram Login.

   Задеплойте.
3. **API setup with Instagram login → Configure webhooks**:
   - Callback URL: `https://<ваш-домен>/webhook`;
   - Verify token: значение `META_VERIFY_TOKEN`;
   - **Verify and save**, затем подпишитесь на поле **comments**.
4. Включите подписку для аккаунта: переключатель webhook subscription напротив аккаунта в разделе
   **Generate access tokens**, или запросом:

   ```bash
   curl -X POST "https://graph.instagram.com/v25.0/me/subscribed_apps?subscribed_fields=comments&access_token=ВАШ_ТОКЕН"
   # {"success":true}
   ```

Сервис проверяет подпись `X-Hub-Signature-256`, сразу отвечает Meta `200` и обрабатывает событие асинхронно.
Дедупликация по ID комментария та же, что и в polling.

---

## Локальный запуск

```bash
pnpm install
cp .env.example .env   # заполните
pnpm dev               # tsx watch, БД в ./data/app.db
```

### Проверка генерации без Instagram и Telegram

```bash
pnpm test:draft
pnpm test:draft "Narxi qancha?" --caption "Yangi kolleksiya" --username ali
pnpm test:draft "Согласен" --parent "@myshop (это ваш аккаунт): Доставка бесплатная" --hint "предложи промокод"
```

Нужен только `ANTHROPIC_API_KEY`. Скрипт печатает сообщение, отправленное в Claude, и JSON с результатом
(`category`, `language`, `reply`, `note`).

### Проверка webhook локально

```bash
# верификация
curl "http://localhost:3000/webhook?hub.mode=subscribe&hub.verify_token=$META_VERIFY_TOKEN&hub.challenge=42"   # → 42

# событие с подписью
BODY='{"object":"instagram","entry":[{"id":"1","time":0,"changes":[{"field":"comments","value":{"id":"900001","text":"Сколько стоит?","from":{"id":"555","username":"tester"},"media":{"id":"777","media_product_type":"FEED"}}}]}]}'
SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$META_APP_SECRET" | sed 's/^.* //')
curl -X POST localhost:3000/webhook -H 'Content-Type: application/json' -H "X-Hub-Signature-256: sha256=$SIG" -d "$BODY"
```

## Промпт

[prompts/reply.md](prompts/reply.md) — тон, правила, информация о бизнесе, FAQ и примеры. Заполните разделы
с `<!-- комментариями -->`: чем подробнее FAQ, тем меньше Claude отвечает «напишите в директ».
Формат ответа (JSON) задаётся в коде, его в файле описывать не нужно.

## Хранилище

SQLite в `DB_PATH` (WAL-режим). Таблицы:

- `comments` — комментарии, черновики, статусы (`pending` / `sent` / `skipped` / `error`), кто обработал (`handled_by`);
- `subscribers` — вошедшие Telegram-чаты (chat id, user id, имя, хэш логина/пароля на момент входа);
- `card_messages` — ID сообщения карточки в каждом чате (чтобы обновлять карточку у всех);
- `settings` — актуальный IG-токен и даты обновления, флаг первичной инициализации, время последнего бэкапа.

Бэкап делается через SQLite Online Backup API (консистентная копия работающей базы) и раз в сутки
приходит документом в Telegram. Восстановление: остановите сервис, положите файл как `/data/app.db`
(удалите `app.db-wal` и `app.db-shm`, если они есть), запустите сервис.

Изменения схемы: правите `src/db/schema.ts` → `pnpm db:generate` → коммитите новую миграцию из `drizzle/`.

## Структура

```
src/
├─ index.ts               запуск, планировщик, graceful shutdown
├─ config/env.ts          валидация env (zod)
├─ db/                    схема Drizzle, подключение + миграции, репозиторий
├─ instagram/client.ts    Graph API (graph.instagram.com/v25.0)
├─ instagram/token.ts     хранение и автообновление токена
├─ instagram/poller.ts    MODE=polling
├─ instagram/webhook.ts   MODE=webhook
├─ ai/drafter.ts          генерация черновика через Claude
├─ pipeline/processor.ts  обработка комментариев и действий из Telegram
├─ telegram/              бот (grammY), вход, рассылка, рендер карточек
├─ backup/backup.ts       ежедневный бэкап
└─ scripts/test-draft.ts  pnpm test:draft
```
