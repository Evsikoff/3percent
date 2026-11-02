# gmail-3percent-worker

Сервис на Node.js, который заменяет два n8n-воркфлоу: `Agent_Gmail_3percent_v1` и `Agent_Gmail_3percent_v1 auxiliary`.
Он читает котировки из Gmail, поднимает все суммы на 3% с помощью Gemini и пишет результат комментарием к предложению в Bitrix24.
Промпт перенесён из n8n без изменений, текст совпадает до символа.

## Как работает

**Каждую минуту (замена Gmail Trigger).** Берёт входящие письма, у которых ещё нет ни одного из четырёх ярлыков.
Каждое такое письмо: HTML → Markdown → Gemini (`GEMINI_MODEL`) → дальше по результату:

| Результат | Ярлык | Запись в `missed_messages` |
|---|---|---|
| Комментарий добавлен в Bitrix | `LABEL_OK` | — |
| В письме нет цены или номера расчёта | `LABEL_NO_QUOTE` | — |
| Bitrix вернул ошибку | `LABEL_BITRIX_ERROR` | `no bitrix` |
| Gemini не ответил или ответил некорректно | `LABEL_AI_ERROR` | `no gemini` |

**Раз в 10 минут (замена вспомогательного воркфлоу).** Берёт строки `missed_messages` с `reprocessing=false` и обрабатывает письмо заново: сначала `GEMINI_RETRY_MODEL`, при ошибке — OpenAI.
- Если ИИ снова не ответил, строка остаётся в очереди.
- В остальных случаях ставится итоговый ярлык, ярлыки ошибок снимаются, строка помечается `reprocessing=true`.

## Отличия от n8n-версии

- **Письма за время простоя догоняются сами.** Новым считается любое письмо без наших ярлыков. При старте воркер смотрит последние 24 часа или письма с даты `PROCESS_AFTER`.
- По умолчанию обрабатываются только входящие (`-in:sent -in:draft -in:chats`, настраивается через `GMAIL_QUERY`): в отправленных письмах уже наши цены.
- Письма без HTML-части (только текст) тоже обрабатываются. Кодировки GB2312, KOI8-R и другие декодируются правильно.
- Запросы к Gmail, Gemini, OpenAI и Supabase повторяются при ошибках 429/5xx и сбоях сети. Bitrix не повторяется, чтобы не задвоить комментарий.
- После успешной повторной обработки ярлык ошибки снимается. В n8n у письма оставался «ошибка Bitrix» рядом с «готово».
- Удалённое письмо в очереди больше не останавливает её обработку.
- Ключи хранятся в переменных окружения. Ключ Gemini передаётся в заголовке, а не в URL.
- При старте проверяется доступ ко всему, включая Bitrix. Если что-то обязательное недоступно, воркер не трогает почту и завершается с понятной ошибкой.

## Подготовка (один раз)

### 1. Доступ к Gmail

1. В [Google Cloud Console](https://console.cloud.google.com/) откройте проект (можно тот, что был для n8n) и включите **Gmail API**.
2. **OAuth consent screen**:
   - для Google Workspace выберите тип **Internal**;
   - для обычного gmail.com выберите **External** и нажмите **Publish app** (статус *In production*).

   ⚠️ В статусе *Testing* refresh-токен живёт 7 дней, после этого воркер перестанет видеть почту.
3. **Credentials → Create credentials → OAuth client ID → Desktop app**. Скопируйте Client ID и Client secret в `.env`.
4. Получите refresh-токен:

   ```bash
   npm ci
   ```

   ```bash
   npm run token
   ```

   Откройте ссылку и войдите **тем ящиком, который должен читать воркер**. Для приложения External без верификации Google покажет «Приложение не проверено»: нажмите «Дополнительно → Перейти». Строку `GMAIL_REFRESH_TOKEN=...` из терминала перенесите в `.env`.

### 2. Supabase

Нужны URL проекта и ключ `service_role`: Project Settings → API.
Если старый проект потерян, создайте новый и выполните [supabase.sql](supabase.sql) в SQL Editor.
Проект на бесплатном тарифе засыпает без активности: проверьте, что он не на паузе.

### 3. Bitrix24

Нужен URL входящего вебхука без имени метода, например `https://b24-xxxxxx.bitrix24.ru/rest/886/<token>`. Вебхуку нужны права **CRM**.
Лучше выпустить новый: старый токен открытым текстом лежит в экспорте n8n.

### 4. Ключи ИИ

- `GEMINI_API_KEY`: выпустите новый, старый тоже лежит в JSON n8n.
- `OPENAI_API_KEY`: необязателен. Без него повторная обработка идёт только через Gemini.

## Проверка на своём компьютере

```bash
cp .env.example .env
```

Заполните `.env`, затем:

```bash
npm run local:check
```

Каждая строка должна заканчиваться на `OK`.

Чтобы посмотреть, что воркер сделает с реальными письмами, но ничего не записать, добавьте в `.env` строки `DRY_RUN=true` и `STARTUP_LOOKBACK_HOURS=2` и выполните:

```bash
npm run local:once
```

В логе появятся тексты комментариев, которые ушли бы в Bitrix. Ярлыки, Bitrix и Supabase при этом не трогаются, а Gemini вызывается по-настоящему.
Ограничение `STARTUP_LOOKBACK_HOURS` нужно, чтобы не прогонять через ИИ все письма за сутки. После проверки уберите `DRY_RUN` из `.env`.

Тесты на фейковых сервисах:

```bash
npm test
```

## Деплой на Northflank

1. Залейте папку в приватный репозиторий GitHub или GitLab. Файл `.env` в `.gitignore`, он в репозиторий не попадёт.
2. Northflank → проект в регионе **Europe** (ближе к Bitrix) → **Create new → Service → Combined service**. Выберите репозиторий и ветку, Build type: **Dockerfile**.
3. **Networking**: удалите порт, входящий трафик воркеру не нужен.
4. **Resources**: минимальный план с ≥ 512 MB RAM, **instances = 1**. Два экземпляра одновременно могут задвоить комментарии.
5. **Environment → Runtime variables**: все переменные из `.env.example`. Секреты удобно держать в Secret group.
   Для первого запуска добавьте `PROCESS_AFTER=<дата падения VM>`. Её видно по последнему письму с одним из четырёх ярлыков.
6. Запустите деплой и откройте **Logs**. Ожидаемый результат: строки `check ...: OK`, затем `started, looking at mail after ...`.
7. Когда догон закончится (в логе `fresh pass: N processed`, дальше тишина), удалите `PROCESS_AFTER`. Иначе после каждого перезапуска воркер будет заново просматривать всю почту с этой даты: это безопасно, но лишняя работа.

### Если `check Bitrix webhook: FAILED` с таймаутом или сбросом соединения

Скорее всего, портал не принимает соединения из-за рубежа. Нужен ретранслятор в РФ, работающий только по HTTPS (токен идёт в URL). Например, небольшой VPS с nginx:

```nginx
location /rest/ { proxy_pass https://b24-xxxxxx.bitrix24.ru; proxy_set_header Host b24-xxxxxx.bitrix24.ru; proxy_ssl_server_name on; }
```

Затем укажите `BITRIX_WEBHOOK_URL=https://relay.example.ru/rest/886/<token>`.

## Перед включением

- **Старый n8n не должен ожить с активными воркфлоу.** Иначе оба обработают одни и те же письма, и в Bitrix появятся дубли. Если VM поднимут, сначала выключите там оба воркфлоу.
- **При передеплое** Northflank несколько секунд держит старый и новый контейнер одновременно. Если письмо придёт ровно в этот момент, комментарий может задвоиться. Если это критично, перед деплоем ставьте instances = 0, после — снова 1.

## Переменные окружения

| Переменная | Обязательна | По умолчанию | Назначение |
|---|---|---|---|
| `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REFRESH_TOKEN` | да | | Доступ к ящику |
| `GMAIL_QUERY` | | `-in:sent -in:draft -in:chats` | Какие письма считаются входящими |
| `LABEL_OK`, `LABEL_NO_QUOTE`, `LABEL_BITRIX_ERROR`, `LABEL_AI_ERROR` | | ID из n8n | Ярлыки результата |
| `GEMINI_API_KEY` | да | | |
| `GEMINI_BASE_URL` | | `https://generativelanguage.googleapis.com` | Прокси на Cloudflare вне РФ не нужен |
| `GEMINI_MODEL` | | `gemini-3.5-flash` | Первая попытка |
| `GEMINI_RETRY_MODEL` | | `gemini-3.1-pro-preview` | Повторная обработка |
| `OPENAI_API_KEY` | | | Запасная модель при повторе |
| `OPENAI_BASE_URL`, `OPENAI_MODEL` | | `https://api.openai.com/v1`, `gpt-5.2` | |
| `BITRIX_WEBHOOK_URL` | да | | URL вебхука без имени метода |
| `BITRIX_AUTHOR_ID` | | `66` | Автор комментария |
| `BITRIX_ENTITY_TYPE` | | `quote` | |
| `SUPABASE_URL`, `SUPABASE_KEY` | да | | Ключ `service_role` |
| `SUPABASE_TABLE` | | `missed_messages` | |
| `POLL_INTERVAL_SEC` | | `60` | Как часто проверять почту |
| `RETRY_INTERVAL_MIN` | | `10` | Как часто разбирать очередь |
| `PROCESS_AFTER` | | | Дата, с которой догонять письма при старте |
| `STARTUP_LOOKBACK_HOURS` | | `24` | Окно при старте, если `PROCESS_AFTER` не задан |
| `DRY_RUN` | | | `true`: только чтение, один проход |

## Устройство

| Файл | Что делает |
|---|---|
| `src/main.js` | Цикл: проверки при старте, новая почта, очередь, корректная остановка по SIGTERM |
| `src/pipeline.js` | Логика обоих бывших воркфлоу |
| `src/prompt.js` | Промпт из n8n |
| `src/ai.js` | Gemini и OpenAI, разбор и починка JSON (перенесено из Code-ноды) |
| `src/gmail.js`, `src/email.js` | Gmail API, разбор MIME, HTML → Markdown |
| `src/bitrix.js`, `src/supabase.js` | Внешние сервисы |
| `src/checks.js` | Проверки при старте |
| `scripts/get-refresh-token.js` | Получение refresh-токена Gmail |
