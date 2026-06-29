// scripts/migrate.js
// Запуск: node scripts/migrate.js
require("dotenv").config();
const { query, pool } = require("../src/db");

async function migrate() {
  console.log("🐠 AquaUZ — запуск миграции БД...");

  // ── Расширения ──────────────────────────────────────────────
  await query(`CREATE EXTENSION IF NOT EXISTS "pgcrypto"`);

  // ── Аккаунты (курьеры, продавцы, админ) ────────────────────
  await query(`
    CREATE TABLE IF NOT EXISTS accounts (
      id          TEXT PRIMARY KEY,
      role        TEXT NOT NULL CHECK (role IN ('admin','courier','seller')),
      name        TEXT NOT NULL,
      phone       TEXT,
      region      TEXT,
      login       TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      temp_pass   TEXT,
      active      BOOLEAN DEFAULT TRUE,
      telegram_id BIGINT,
      last_login  TIMESTAMPTZ,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // ── Товары ──────────────────────────────────────────────────
  await query(`
    CREATE TABLE IF NOT EXISTS products (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      emoji       TEXT,
      category    TEXT NOT NULL,   -- fish | equipment | food | plant
      price       INTEGER NOT NULL,
      min_price   INTEGER DEFAULT 0,
      stock       INTEGER DEFAULT 0,
      active      BOOLEAN DEFAULT TRUE,
      views       INTEGER DEFAULT 0,
      orders_count INTEGER DEFAULT 0,
      description TEXT,
      created_at  TIMESTAMPTZ DEFAULT NOW(),
      updated_at  TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // ── Промокоды ───────────────────────────────────────────────
  await query(`
    CREATE TABLE IF NOT EXISTS promos (
      code        TEXT PRIMARY KEY,
      discount    INTEGER NOT NULL,
      uses        INTEGER DEFAULT 0,
      max_uses    INTEGER DEFAULT 100,
      active      BOOLEAN DEFAULT TRUE,
      expires_at  DATE,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // ── Покупатели (Telegram-пользователи) ──────────────────────
  await query(`
    CREATE TABLE IF NOT EXISTS customers (
      telegram_id BIGINT PRIMARY KEY,
      first_name  TEXT,
      last_name   TEXT,
      username    TEXT,
      phone       TEXT,
      region      TEXT DEFAULT 'Ташкент',
      created_at  TIMESTAMPTZ DEFAULT NOW(),
      updated_at  TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // ── Заказы ──────────────────────────────────────────────────
  await query(`
    CREATE TABLE IF NOT EXISTS orders (
      id            SERIAL PRIMARY KEY,
      customer_id   BIGINT REFERENCES customers(telegram_id),
      buyer_name    TEXT,
      phone         TEXT NOT NULL,
      region        TEXT NOT NULL,
      address       TEXT NOT NULL,
      comment       TEXT,
      delivery_slot TEXT,
      pay_method    TEXT NOT NULL DEFAULT 'cash',
      promo_code    TEXT REFERENCES promos(code),
      promo_discount INTEGER DEFAULT 0,
      subtotal      INTEGER NOT NULL,
      delivery_fee  INTEGER NOT NULL,
      total         INTEGER NOT NULL,
      status        TEXT NOT NULL DEFAULT 'accepted'
                    CHECK (status IN ('accepted','packed','courier','way','delivered','cancelled')),
      courier_id    TEXT REFERENCES accounts(id),
      note          TEXT,
      created_at    TIMESTAMPTZ DEFAULT NOW(),
      updated_at    TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // ── Позиции заказа ──────────────────────────────────────────
  await query(`
    CREATE TABLE IF NOT EXISTS order_items (
      id          SERIAL PRIMARY KEY,
      order_id    INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      product_id  TEXT,
      name        TEXT NOT NULL,
      price       INTEGER NOT NULL,
      qty         INTEGER NOT NULL DEFAULT 1
    )
  `);

  // ── Настройки магазина ──────────────────────────────────────
  await query(`
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);

  // ── Тарифы доставки по регионам ─────────────────────────────
  await query(`
    CREATE TABLE IF NOT EXISTS delivery_rates (
      region      TEXT PRIMARY KEY,
      price       INTEGER NOT NULL,
      time_label  TEXT NOT NULL,
      courier_name TEXT,
      courier_phone TEXT,
      rating      NUMERIC(3,1) DEFAULT 5.0,
      trips       INTEGER DEFAULT 0
    )
  `);

  // ── Индексы ─────────────────────────────────────────────────
  await query(`CREATE INDEX IF NOT EXISTS idx_orders_status   ON orders(status)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_orders_customer ON orders(customer_id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_orders_created  ON orders(created_at DESC)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id)`);

  console.log("✅ Миграция завершена успешно!");
  await pool.end();
}

migrate().catch((err) => {
  console.error("❌ Ошибка миграции:", err);
  process.exit(1);
});
