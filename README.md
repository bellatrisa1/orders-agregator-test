# orders-aggregator

Сервис забирает заказы интернет-магазина из внешней системы (API поддерживает другая команда),
принимает их обновления через вебхуки и считает статистику по клиентам.

## Стек

Node 20+, TypeScript, Fastify, PostgreSQL (`pg`), Zod, Vitest.

## Запуск на новом окружении

Нужны Node.js 20.11+ (проверено на 22.22.2), npm, запущенный Docker с Compose.
Это HTTP API: отдельного веб-интерфейса нет, браузер показывает JSON.
Команды выполняются из корня проекта в bash/zsh.

Проверьте Docker и архитектуру:

```bash
docker version
docker compose version
uname -m
```

Образ внешнего API предоставлен вместе с заданием, в архив решения он не включён.
Положите подходящий архив рядом с папкой проекта и выполните **одну** команду:

```bash
docker load -i ../orders-mock-arm64.tar.gz   # arm64 / aarch64, Mac Apple Silicon
# либо для x86_64:
# docker load -i ../orders-mock-amd64.tar.gz
```

В стандартной конфигурации нужны свободные порты 5432 (БД), 4000 (внешний API),
3000 (сервис). Если порт занят, не останавливайте чужой проект: согласуйте
другой порт публикации в Compose и соответствующий URL в .env.
Изменение одного DATABASE_URL само по себе не меняет порт Docker.

```bash
# Не перезаписываем существующие локальные настройки.
if [ ! -e .env ]; then cp .env.example .env; fi
npm ci

# .env автоматически не загружается npm-скриптами:
set -a
source .env
set +a

docker compose -p orders-aggregator-3205 up -d
docker compose -p orders-aggregator-3205 ps
docker compose -p orders-aggregator-3205 exec -T postgres pg_isready -U postgres -d orders
```

Дождитесь `accepting connections`; при необходимости повторите последнюю команду.
На первом запуске PostgreSQL создаёт orders и orders_test через init-скрипт.
Для воспроизведения результата нужна новая пустая orders. Проверка до миграций:

```bash
docker compose -p orders-aggregator-3205 exec -T postgres psql -U postgres -d orders -c '\dt'
```

Если таблицы уже есть, это не чистый запуск: сначала выясните происхождение данных.
Команды очистки в эту инструкцию не включены.

```bash
npm run migrate
npm run dev
```

Оставьте терминал открытым. После сообщения `Server listening` в другом терминале:

```bash
curl --fail-with-body http://localhost:3000/health
curl --fail-with-body --silent --show-error -X POST http://localhost:3000/sync
```

Health возвращает `{"status":"ok"}`. Sync отвечает после завершения обхода страниц;
проверьте счётчики applied/invalid и отсутствие HTTP-ошибки.
Затем отправьте вебхуки и дождитесь завершения команды:

```bash
docker compose -p orders-aggregator-3205 run --rm orders-api webhooks --target http://host.docker.internal:3000/webhooks/order
```

Запрос статистики после вебхуков:

```bash
curl --fail-with-body --silent --show-error \
  'http://localhost:3000/customers/c_7/daily-totals?from=2026-03-27&to=2026-03-31'
```

Параметры from/to включают обе границы. Для сохранения повторного результата
можно добавить `-o result.local.json`; готовый `result.json` уже входит в решение.
Источник данных и результаты выполненного прогона описаны в SOLUTION.md.

## Уже подготовленное локальное окружение автора

На текущем Mac стандартные порты 5432 и 3000 заняты другими проектами.
Поэтому здесь создана отдельная БД orders_final на 127.0.0.1:55432,
API задания работает на 4000, сервис — на 3001. Локальная .env содержит эти настройки
и не включается в архив. Для повторного запуска **существующего** окружения:

```bash
docker start orders-aggregator-3205-final-postgres-1 orders-aggregator-3205-final-orders-api-1
set -a
source .env
set +a
npm run dev
```

Проверка: http://localhost:3001/health.
Статистика: http://localhost:3001/customers/c_7/daily-totals?from=2026-03-27&to=2026-03-31.
Если сервис уже работает, второй экземпляр на том же порту запускать не нужно.
При отправке вебхуков target здесь должен использовать порт 3001.
Эти контейнеры и настройки не требуются получателю архива: для него инструкция выше.

## Проверки

В новом терминале снова загрузите .env через `set -a; source .env; set +a`.
Проверьте, что TEST_DATABASE_URL указывает на отдельную проектную orders_test:
тесты очищают её таблицы, а внешний API подменяют FakeApi.

```bash
npm run typecheck
npm test
```

Только тесты без БД:

```bash
npm exec -- vitest run test/money.test.ts test/time.test.ts test/orders-normalize.test.ts test/totals-unit.test.ts
```

Остановка сервиса — Ctrl+C. Контейнеры стандартного окружения можно остановить
без удаления данных: `docker compose -p orders-aggregator-3205 stop`.

## Структура

```
src/
  app.ts              Fastify-приложение, обработка ошибок
  container.ts        сборка зависимостей
  db.ts               пул соединений, миграции
  clients/            клиент внешнего API (лимиты, ретраи)
  repositories/       доступ к данным
  services/           бизнес-логика
  routes/             HTTP-слой
  utils/              деньги, время
migrations/           SQL-миграции, применяются по порядку
test/                 интеграционные тесты на реальной БД (внешний API — фейк)
```

## Соглашения

- Деньги внутри сервиса — в копейках (integer). Рубли — только на входе из внешнего API и в ответах.
- Время храним в UTC (`TIMESTAMPTZ`).
- Ошибки бизнес-логики — наследники `AppError`, в ответе `{ error: <код>, message }`.

## API сервиса

| Метод | Путь                                                        | Описание                                                                                                |
| ----- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| POST  | `/sync`                                                     | Забрать все заказы из внешнего API. Отвечает статистикой, когда всё забрано                             |
| POST  | `/webhooks/order`                                           | Обновление заказа (тело — `Order` внешнего API). Повтор/устаревшая версия → `200 { result: "stale" }`   |
| GET   | `/customers/:id/daily-totals?from=YYYY-MM-DD&to=YYYY-MM-DD` | Сумма оплаченных (`paid`) заказов по дням в таймзоне клиента: `[{ date, total, gross, discount, net }]` |
| GET   | `/health`                                                   | Проверка живости                                                                                        |

## Внешний API (`ORDERS_API_URL`)

- `GET /orders?cursor=<string>&limit=<1..100>` → `{ items: Order[], nextCursor: string | null }`. Лимит 5 rps.
- `GET /customers/:id` → `{ id, timezone }` (IANA, например `Europe/Berlin`).
- Вебхуки: `POST` на наш `/webhooks/order`, тело — `Order`. Повторная доставка возможна.

```ts
type Order = {
  id: string;
  customerId: string;
  amount: number; // сумма заказа в рублях, до скидки
  discountPercent: number; // скидка, % (0 — без скидки)
  amountPaid: number; // оплачено, в рублях: amount со скидкой
  status: "pending" | "paid" | "refunded";
  createdAt: string; // ISO 8601, UTC
  updatedAt: string; // ISO 8601, UTC
};
```

`discountPercent` и `amountPaid` поддерживаются сервисом. В реальных ответах образа
`orders-mock:3` `discountPercent` встречается также числовой строкой.

## Денежные суммы и календарные дни

`daily-totals` группирует текущие оплаченные (`paid`) заказы по `createdAt`
в IANA-таймзоне клиента с учётом смещения на момент каждого заказа.
`updatedAt` определяет версию заказа и не считается временем оплаты.
Дни диапазона включены с обеих сторон; дни без заказов возвращают нули.

- `total = gross`: сумма заказов до скидки, прежняя семантика `total` сохраняется.
- `net`: фактически оплаченная сумма; корректный `amountPaid`, включая `0`, имеет приоритет над процентом.
- `discount = gross - net`, вычисляется в копейках перед преобразованием в рубли.
- Если оба новых поля отсутствуют, `net = gross`.
- Если есть только `discountPercent`, процент применяется к целым копейкам `amount`.
  Полученный `net` округляется до ближайшей копейки, половина вверх.
  Это правило совместимости сервиса: README внешнего API не задаёт округление.
- `discountPercent` — конечное число от 0 до 100 или десятичная числовая строка
  (строки подтверждены реальными ответами API); суммы — конечные неотрицательные числа
  или десятичные числовые строки. Невалидное присутствующее поле не игнорируется.
  В рамках модели скидки `amountPaid > amount` отклоняется; совпадение суммы с процентом не требуется.
- При переводе входных рублей доли копейки отбрасываются, как и раньше,
  но десятичные значения `0.29` и `1.15` больше не теряют копейку.
  Суммы и дневные итоги ограничены безопасными целыми копейками JavaScript.

Миграция `002_amount_paid.sql` добавляет фактически оплаченную сумму.
У старых записей она первоначально равна сумме до скидки: восстановить неизвестную скидку
из БД нельзя. Повторная синхронизация с тем же `updatedAt` считается устаревшей
и такие данные не обогащает. Для сдаваемого результата требуется чистая БД по `TASK.md`.

## Форматирование

```bash
npm run format        # форматировать файлы проекта
npm run format:check  # проверить форматирование без изменений
```

Настройки Prettier находятся в `.prettierrc.json`, исключения — в `.prettierignore`.
