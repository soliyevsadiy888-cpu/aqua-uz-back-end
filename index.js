// src/db/index.js
const { Pool } = require("pg");
require("dotenv").config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production"
    ? { rejectUnauthorized: false }
    : false,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

pool.on("error", (err) => {
  console.error("PostgreSQL pool error:", err);
});

/**
 * Выполнить SQL-запрос
 * @param {string} text  — SQL
 * @param {Array}  params — параметры ($1, $2, …)
 */
async function query(text, params) {
  const start = Date.now();
  try {
    const res = await pool.query(text, params);
    const duration = Date.now() - start;
    if (process.env.NODE_ENV !== "production") {
      console.log(`[DB] ${duration}ms | ${text.slice(0, 80)}`);
    }
    return res;
  } catch (err) {
    console.error("[DB] Query error:", { text, params, err: err.message });
    throw err;
  }
}

/**
 * Транзакция: fn получает объект { query } привязанный к клиенту
 */
async function transaction(fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn({
      query: (text, params) => client.query(text, params),
    });
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { query, transaction, pool };
