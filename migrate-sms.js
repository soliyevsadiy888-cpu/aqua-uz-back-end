// scripts/migrate-sms.js
// Добавляет таблицу sms_codes к существующей БД.
// Запуск: node scripts/migrate-sms.js
//
// Можно безопасно запускать повторно (используется CREATE TABLE IF NOT EXISTS).

require("dotenv").config();
const { query, pool } = require("../src/db");

async function migrateSms() {
  console.log("🐠 AquaUZ — миграция SMS-кодов...");

  // ── Таблица OTP-кодов ────────────────────────────────────────
  await query(`
    CREATE TABLE IF NOT EXISTS sms_codes (
      id          SERIAL PRIMARY KEY,
      phone       TEXT NOT NULL,          -- нормализованный: 998XXXXXXXXX
      code        TEXT NOT NULL,          -- 6-значный цифровой код
      purpose     TEXT NOT NULL           -- 'verify' | 'forgot_password'
                  CHECK (purpose IN ('verify', 'forgot_password')),
      attempts    INTEGER DEFAULT 0,      -- количество неверных попыток
      verified    BOOLEAN DEFAULT FALSE,  -- использован ли
      verified_at TIMESTAMPTZ,            -- когда был использован
      expires_at  TIMESTAMPTZ NOT NULL,   -- время истечения
      created_at  TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // ── Индексы для быстрого поиска ──────────────────────────────
  await query(`
    CREATE INDEX IF NOT EXISTS idx_sms_codes_phone_purpose
    ON sms_codes (phone, purpose)
  `);
  await query(`
    CREATE INDEX IF NOT EXISTS idx_sms_codes_expires
    ON sms_codes (expires_at)
  `);

  // ── Столбец phone у accounts (в текущей схеме уже есть, но проверим) ──
  await query(`
    ALTER TABLE accounts
    ADD COLUMN IF NOT EXISTS phone TEXT
  `);

  console.log("✅ Миграция SMS завершена!");
  await pool.end();
}

migrateSms().catch((err) => {
  console.error("❌ Ошибка:", err);
  process.exit(1);
});
