// src/middleware/auth.js
const jwt = require("jsonwebtoken");
const { query } = require("../db");

/**
 * Проверяет JWT токен из заголовка Authorization: Bearer <token>
 * Добавляет req.user = { id, role, name, region }
 */
async function requireAuth(req, res, next) {
  try {
    const header = req.headers.authorization;
    if (!header || !header.startsWith("Bearer ")) {
      return res.status(401).json({ error: "Токен не передан" });
    }
    const token = header.slice(7);
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    // Проверяем что аккаунт ещё активен
    const { rows } = await query(
      "SELECT id, role, name, region, active FROM accounts WHERE id = $1",
      [payload.id]
    );
    if (!rows[0] || !rows[0].active) {
      return res.status(401).json({ error: "Аккаунт не найден или заблокирован" });
    }
    req.user = rows[0];
    next();
  } catch (err) {
    return res.status(401).json({ error: "Неверный или просроченный токен" });
  }
}

/**
 * Только для роли admin
 */
function requireAdmin(req, res, next) {
  if (req.user?.role !== "admin") {
    return res.status(403).json({ error: "Доступ только для администратора" });
  }
  next();
}

/**
 * Для admin или seller
 */
function requireSeller(req, res, next) {
  if (!["admin", "seller"].includes(req.user?.role)) {
    return res.status(403).json({ error: "Нет доступа" });
  }
  next();
}

/**
 * Для admin или courier
 */
function requireCourier(req, res, next) {
  if (!["admin", "courier"].includes(req.user?.role)) {
    return res.status(403).json({ error: "Нет доступа" });
  }
  next();
}

/**
 * Валидация Telegram initData (для запросов из Mini App)
 * https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 */
const crypto = require("crypto");

function validateTelegramInit(req, res, next) {
  try {
    const initData = req.headers["x-telegram-init-data"];
    if (!initData) {
      return res.status(401).json({ error: "Telegram initData не передан" });
    }
    const params = new URLSearchParams(initData);
    const hash = params.get("hash");
    params.delete("hash");

    // Сортируем параметры и строим data-check-string
    const checkString = [...params.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join("\n");

    const secretKey = crypto
      .createHmac("sha256", "WebAppData")
      .update(process.env.BOT_TOKEN)
      .digest();

    const expectedHash = crypto
      .createHmac("sha256", secretKey)
      .update(checkString)
      .digest("hex");

    if (expectedHash !== hash) {
      return res.status(401).json({ error: "Неверная подпись Telegram" });
    }

    // Парсим user из initData
    const userStr = params.get("user");
    if (userStr) {
      req.telegramUser = JSON.parse(userStr);
    }
    next();
  } catch (err) {
    return res.status(401).json({ error: "Ошибка валидации Telegram initData" });
  }
}

module.exports = { requireAuth, requireAdmin, requireSeller, requireCourier, validateTelegramInit };
