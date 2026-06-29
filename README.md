# 🐠 AquaUZ — Backend

Node.js + Express + PostgreSQL бекенд для Telegram Mini App магазина аквариумных рыб.

---

## Структура проекта

```
aqua-uz-backend/
├── src/
│   ├── index.js              # Точка входа — Express сервер
│   ├── db/
│   │   └── index.js          # Подключение к PostgreSQL
│   ├── middleware/
│   │   └── auth.js           # JWT + Telegram initData
│   ├── routes/
│   │   ├── auth.js           # Вход / смена пароля
│   │   ├── orders.js         # Заказы
│   │   ├── catalog.js        # Товары, промокоды, доставка
│   │   └── admin.js          # Аккаунты, настройки
│   └── services/
│       └── telegram.js       # Bot API, уведомления, webhook
├── scripts/
│   ├── migrate.js            # Создание таблиц
│   └── seed.js               # Начальные данные
├── .env.example
└── package.json
```

---

## 🚀 Деплой за 15 минут (Railway — бесплатно)

### Шаг 1 — PostgreSQL база данных

1. Зайдите на **https://railway.app** → Login with GitHub
2. New Project → **Provision PostgreSQL**
3. Нажмите на созданную базу → вкладка **Connect**
4. Скопируйте строку **DATABASE_URL** (вид: `postgresql://...`)

### Шаг 2 — Деплой бекенда

1. В том же проекте Railway → **+ New Service → GitHub Repo**
2. Выберите репозиторий с этим кодом
3. Railway автоматически запустит `npm start`

**Переменные окружения** (Variables → Add Variable):
```
DATABASE_URL       = (скопировали выше)
BOT_TOKEN          = токен вашего бота от @BotFather
ADMIN_TELEGRAM_ID  = ваш Telegram ID (узнайте у @userinfobot)
JWT_SECRET         = любая длинная случайная строка (мин. 32 символа)
FRONTEND_URL       = https://aqua-uz-xxxxxxx.vercel.app
WEBHOOK_URL        = https://aqua-uz-backend.up.railway.app
NODE_ENV           = production
```

4. После деплоя откройте **Shell** в Railway и выполните:
```bash
node scripts/migrate.js   # Создаёт таблицы
node scripts/seed.js      # Заполняет начальные данные
```

### Шаг 3 — Проверить что работает

Откройте в браузере:
```
https://aqua-uz-backend.up.railway.app/health
```
Должно вернуть: `{"ok":true,"service":"AquaUZ Backend",...}`

---

## 🔌 Подключение фронтенда к бекенду

В `App.tsx` добавьте константу в самом начале файла:

```typescript
const API = "https://aqua-uz-backend.up.railway.app/api";
const tg = window.Telegram?.WebApp;
const tgInitData = tg?.initData || "";
const tgUser = tg?.initDataUnsafe?.user;
```

### Создание заказа

Замените функцию `handleDone()` в компоненте `Checkout`:

```typescript
async function handleDone() {
  try {
    const items = groupedCart.map(([item, qty]) => ({
      product_id: item.id,
      name: item.name,
      price: item.price,
      qty,
    }));

    const res = await fetch(`${API}/orders`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        phone,
        region,
        address,
        comment,
        delivery_slot: TIME_SLOTS.find(s => s.id === slot)?.label || slot,
        pay_method: pay,
        promo_code: promo || undefined,
        items,
        buyer_name: tgUser?.first_name,
        telegram_user: tgUser,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);

    onDone({ id: data.order_id, .../* остальные поля */ });
  } catch (err) {
    alert("Ошибка: " + err.message);
  }
}
```

### Проверка промокода

```typescript
async function applyPromo(code: string) {
  const res = await fetch(`${API}/catalog/promos/check`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, subtotal }),
  });
  const data = await res.json();
  if (!res.ok) { showToast(data.error, "bad"); return; }
  setPromoDiscount(data.discount_percent);
  showToast(`Промокод −${data.discount_percent}%`, "ok");
}
```

### История заказов клиента

```typescript
async function loadMyOrders() {
  if (!tgUser?.id) return;
  const res = await fetch(`${API}/orders/my`, {
    headers: { "x-telegram-id": String(tgUser.id) },
  });
  const data = await res.json();
  return data.orders;
}
```

### Вход в Admin/Seller/Courier панель

```typescript
async function login(loginStr: string, password: string, role: string) {
  const res = await fetch(`${API}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ login: loginStr, password, role }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error);
  localStorage.setItem("aqua_token", data.token);
  return data; // { token, user, needPasswordChange }
}
```

### Admin API (нужен токен)

```typescript
const headers = {
  "Content-Type": "application/json",
  "Authorization": `Bearer ${localStorage.getItem("aqua_token")}`,
};

// Получить заказы
const orders = await fetch(`${API}/orders?status=accepted`, { headers }).then(r => r.json());

// Сменить статус заказа
await fetch(`${API}/orders/4821/status`, {
  method: "PATCH", headers,
  body: JSON.stringify({ action: "next" }),  // или { status: "cancelled" }
});

// Получить товары (все, включая скрытые)
const products = await fetch(`${API}/catalog/products`, { headers }).then(r => r.json());

// Обновить склад товара
await fetch(`${API}/catalog/products/guppy`, {
  method: "PATCH", headers,
  body: JSON.stringify({ stock: 15, price: 27000 }),
});

// Переключить магазин открыт/закрыт
await fetch(`${API}/admin/settings`, {
  method: "PATCH", headers,
  body: JSON.stringify({ store_open: false }),
});

// Сбросить пароль курьера
const { temp_pass } = await fetch(`${API}/admin/accounts/c_aziz/reset-password`, {
  method: "POST", headers,
}).then(r => r.json());
// temp_pass — показать администратору, курьер вводит его при входе
```

---

## 📡 API Reference

### Auth
| Метод | URL | Описание |
|-------|-----|----------|
| POST | `/api/auth/login` | Вход (courier/seller/admin) |
| POST | `/api/auth/change-password` | Смена пароля 🔒 |
| GET  | `/api/auth/me` | Текущий пользователь 🔒 |

### Заказы
| Метод | URL | Доступ |
|-------|-----|--------|
| POST | `/api/orders` | Публично (из Mini App) |
| GET  | `/api/orders` | seller/admin |
| GET  | `/api/orders/my` | По telegram-id |
| GET  | `/api/orders/stats/dashboard` | seller/admin |
| GET  | `/api/orders/:id` | seller/admin/courier |
| PATCH | `/api/orders/:id/status` | seller/admin/courier |
| PATCH | `/api/orders/:id/courier` | seller/admin |
| PATCH | `/api/orders/:id/note` | seller/admin |

### Каталог
| Метод | URL | Доступ |
|-------|-----|--------|
| GET  | `/api/catalog/products` | Публично |
| GET  | `/api/catalog/products/:id` | Публично |
| POST | `/api/catalog/products` | seller/admin |
| PATCH | `/api/catalog/products/:id` | seller/admin |
| DELETE | `/api/catalog/products/:id` | admin |
| POST | `/api/catalog/promos/check` | Публично |
| GET  | `/api/catalog/promos` | admin |
| POST | `/api/catalog/promos` | admin |
| PATCH | `/api/catalog/promos/:code` | admin |
| DELETE | `/api/catalog/promos/:code` | admin |
| GET  | `/api/catalog/delivery` | Публично |
| PATCH | `/api/catalog/delivery/:region` | admin |

### Admin
| Метод | URL | Описание |
|-------|-----|----------|
| GET  | `/api/admin/accounts` | Все аккаунты |
| POST | `/api/admin/accounts` | Создать аккаунт |
| PATCH | `/api/admin/accounts/:id` | Обновить аккаунт |
| POST | `/api/admin/accounts/:id/reset-password` | Сбросить пароль |
| DELETE | `/api/admin/accounts/:id` | Удалить аккаунт |
| GET  | `/api/admin/couriers` | Курьеры + тарифы |
| GET  | `/api/admin/settings` | Все настройки |
| PATCH | `/api/admin/settings` | Обновить настройки |

---

## 🤖 Telegram Bot уведомления

После создания заказа вы (ADMIN_TELEGRAM_ID) получите сообщение:
```
🆕 Новый заказ #4822
👤 Анвар · +998 90 111 22 33
📍 Ташкент: ул. Амира Темура, 15
⏱ Сегодня 14:00–18:00
💳 💵 Наличные

Состав:
  • Гуппи ×3 — 75 000 сум
  • Корм «Универсал» — 18 000 сум

💰 Итого: 118 000 сум
[✅ Принять] [❌ Отменить]
```

Клиент получает уведомления при каждой смене статуса.

---

## 🔐 Аккаунты по умолчанию

| Логин | Пароль | Роль |
|-------|--------|------|
| `admin` | `ADMIN_CHANGE_ME` | Администратор |
| `aziz_courier` | `AZ1234` | Курьер (Ташкент) |
| `ali_aqua` | `AL1122` | Продавец (Ташкент) |

**⚠️ Обязательно смените пароль admin после первого входа!**

---

## Локальная разработка

```bash
# 1. Установить зависимости
npm install

# 2. Скопировать и заполнить .env
cp .env.example .env
# Отредактируйте .env — минимум DATABASE_URL и JWT_SECRET

# 3. Поднять PostgreSQL локально (если нет)
docker run -d -p 5432:5432 -e POSTGRES_PASSWORD=pass -e POSTGRES_DB=aquauz postgres:15

# DATABASE_URL=postgresql://postgres:pass@localhost:5432/aquauz

# 4. Миграция и seed
node scripts/migrate.js
node scripts/seed.js

# 4.1. Миграция таблицы SMS-кодов (один раз)
node scripts/migrate-sms.js

# 5. Запустить сервер
npm run dev
# → http://localhost:3000/health
```

---

## 📱 SMS-верификация (Eskiz.uz)

Бекенд поддерживает подтверждение номера телефона и сброс пароля по SMS.

### Как это работает

- **Без `ESKIZ_EMAIL`/`ESKIZ_PASSWORD` в `.env`** — режим разработки: код не отправляется
  реальной SMS, а возвращается прямо в ответе API как `_dev_code` (или `_dev_temp_pass`
  для сброса пароля админом). Удобно для тестирования без затрат на SMS.
- **С заполненными `ESKIZ_EMAIL`/`ESKIZ_PASSWORD`** — коды реально отправляются через
  [Eskiz.uz](https://eskiz.uz).

### Подключение Eskiz.uz

1. Зарегистрируйтесь на [eskiz.uz](https://eskiz.uz) и получите email/пароль для API.
2. Пока имя отправителя не подтверждено модерацией — используйте тестовый sender id `4546`
   (значение по умолчанию для `ESKIZ_SENDER_NAME`).
3. После модерации своего имени (например `AquaUZ`) — укажите его в `ESKIZ_SENDER_NAME`.
4. Заполните в `.env`:
   ```
   ESKIZ_EMAIL=your@email.com
   ESKIZ_PASSWORD=your_eskiz_password
   ESKIZ_SENDER_NAME=4546
   ```
5. Перезапустите сервер — в логах при старте будет видно:
   `[SMS] Eskiz.uz настроен — реальные SMS будут отправляться`.

### Эндпоинты

| Метод | Путь | Назначение |
|---|---|---|
| POST | `/api/sms/send` | Отправить код подтверждения на номер |
| POST | `/api/sms/verify` | Проверить введённый код |
| POST | `/api/sms/delete-code` | Удалить код (пользователь отменил ввод) |
| POST | `/api/sms/forgot-password` | Запросить код для сброса пароля (курьер/продавец) |
| POST | `/api/sms/reset-password` | Сбросить пароль по коду из SMS |
| DELETE | `/api/sms/phone` | Отвязать номер покупателя (с подтверждением кодом) |
| POST | `/api/admin/accounts/:id/reset-password-sms` | Admin: сбросить пароль курьеру/продавцу и отправить его по SMS и/или Telegram |

### Защита от спама

- Cooldown 60 сек на повторную отправку кода на **тот же номер**.
- Rate-limit 20 запросов / 15 минут с одного **IP** на все `/api/sms/*` маршруты
  (защита от перебора разных номеров).
- Максимум 5 попыток ввода кода, после чего код нужно запрашивать заново.
- Коды живут 5 минут, автоочистка просроченных — каждые 30 минут.

