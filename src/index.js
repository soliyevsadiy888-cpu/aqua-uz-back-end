// src/index.js
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");

const { query } = require("./db");
const { setupWebhook, handleWebhookUpdate } = require("./services/telegram");

// Маршруты
const authRouter    = require("./routes/auth");
const ordersRouter  = require("./routes/orders");
const catalogRouter = require("./routes/catalog");
const adminRouter   = require("./routes/admin");
const smsRouter     = require("./routes/sms");
const { cleanExpiredCodes } = require("./services/sms");

const app = express();
const PORT = process.env.PORT || 3000;

// ── Безопасность ────────────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));

app.use(cors({
  origin: [
    process.env.FRONTEND_URL,
    // Локальная разработка
    "http://localhost:5173",
    "http://localhost:3000",
    // Telegram WebApp открывается внутри Telegram — не шлёт Origin
  ].filter(Boolean),
  credentials: true,
}));

// Rate limit — общий
app.use(rateLimit({
  windowMs: 15 * 60 * 1000, // 15 минут
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Слишком много запросов. Попробуйте позже." },
}));

// Rate limit — для создания заказов (защита от спама)
const orderLimit = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 час
  max: 10,
  message: { error: "Слишком много заказов. Попробуйте через час." },
});

// Rate limit — для входа (защита от брутфорса)
const loginLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: "Слишком много попыток входа. Подождите 15 минут." },
});

// Rate limit — для SMS (защита от спама и слива денег на SMS-шлюзе)
// Отдельно от cooldown'а на конкретный номер (он живёт в services/sms.js):
// этот лимит защищает от перебора РАЗНЫХ номеров с одного IP.
const smsLimit = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 минут
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Слишком много запросов SMS. Попробуйте позже." },
});

// ── Парсинг тела запроса ────────────────────────────────────────
// Webhook от Telegram должен идти до express.json() с raw body
app.post("/webhook/telegram", express.raw({ type: "application/json" }), async (req, res) => {
  try {
    const update = JSON.parse(req.body.toString());
    await handleWebhookUpdate(update, { query });
    res.sendStatus(200);
  } catch (err) {
    console.error("[webhook/telegram]", err);
    res.sendStatus(200); // Всегда 200 чтобы Telegram не повторял
  }
});

app.use(express.json({ limit: "1mb" }));

// ── Health check ────────────────────────────────────────────────
app.get("/health", async (req, res) => {
  try {
    await query("SELECT 1");
    res.json({ ok: true, service: "AquaUZ Backend", timestamp: new Date().toISOString() });
  } catch {
    res.status(503).json({ ok: false, error: "DB unavailable" });
  }
});

// ── API маршруты ────────────────────────────────────────────────
app.use("/api/auth",    loginLimit, authRouter);
app.use("/api/orders",  orderLimit, ordersRouter);
app.use("/api/catalog", catalogRouter);
app.use("/api/admin",   adminRouter);
app.use("/api/sms",     smsLimit, smsRouter);

// ── 404 ─────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: `Маршрут ${req.method} ${req.path} не найден` });
});

// ── Обработка ошибок ────────────────────────────────────────────
app.use((err, req, res, _next) => {
  console.error("[ERROR]", err);
  res.status(500).json({ error: "Внутренняя ошибка сервера" });
});

// ── Запуск ──────────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`
  ╔══════════════════════════════════════════╗
  ║  🐠  AquaUZ Backend                     ║
  ║  Порт: ${PORT}                              ║
  ║  NODE_ENV: ${process.env.NODE_ENV || "development"}               ║
  ╚══════════════════════════════════════════╝
  `);

  // Устанавливаем webhook если есть WEBHOOK_URL и BOT_TOKEN
  if (process.env.WEBHOOK_URL && process.env.BOT_TOKEN) {
    await setupWebhook(process.env.WEBHOOK_URL);
  } else {
    console.warn("[TG] WEBHOOK_URL или BOT_TOKEN не задан — уведомления отключены");
  }

  // Проверяем настройки SMS-шлюза
  if (process.env.ESKIZ_EMAIL && process.env.ESKIZ_PASSWORD) {
    console.log("[SMS] Eskiz.uz настроен — реальные SMS будут отправляться");
  } else {
    console.warn(
      "[SMS] ESKIZ_EMAIL/ESKIZ_PASSWORD не заданы — SMS работают в DEV-режиме " +
      "(код возвращается в ответе API как _dev_code, реальные SMS не отправляются)"
    );
  }

  // Очищаем просроченные SMS-коды сразу при старте, затем каждые 30 минут
  try {
    await cleanExpiredCodes();
  } catch (err) {
    console.error("[SMS] Ошибка первичной очистки кодов:", err.message);
  }
  setInterval(async () => {
    try {
      await cleanExpiredCodes();
    } catch (err) {
      console.error("[SMS] Ошибка очистки кодов:", err.message);
    }
  }, 30 * 60 * 1000);
});

module.exports = app;
