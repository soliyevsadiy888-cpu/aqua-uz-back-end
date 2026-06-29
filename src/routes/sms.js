// src/routes/sms.js
// Маршруты SMS-верификации:
//   POST   /api/sms/send            — отправить код на номер
//   POST   /api/sms/verify          — проверить код
//   POST   /api/sms/delete-code     — явно удалить код (клиент отменил ввод)
//   POST   /api/sms/forgot-password — запросить код для сброса пароля
//   POST   /api/sms/reset-password  — сбросить пароль по коду из SMS
//   DELETE /api/sms/phone           — удалить/отвязать номер телефона покупателя

const router = require("express").Router();
const bcrypt = require("bcryptjs");
const { query } = require("../db");
const {
  sendOtp,
  verifyOtp,
  deleteOtpByPhone,
  normalizePhone,
} = require("../services/sms");

// ── Вспомогательная валидация номера ────────────────────────────
function isValidUzPhone(phone) {
  const digits = String(phone || "").replace(/\D/g, "");
  // Узбекские номера: 998XXXXXXXXX (12 цифр) или 9 цифр без кода, или 0XXXXXXXXX (10 цифр)
  return (
    (digits.startsWith("998") && digits.length === 12) ||
    (digits.startsWith("0") && digits.length === 10) ||
    digits.length === 9
  );
}

/* ─────────────────────────────────────────────────────────────────
   1. POST /api/sms/send
   Отправить OTP-код на номер телефона.
   Используется при оформлении заказа для верификации контакта.
   Body: { phone: string, purpose?: "verify" | "forgot_password" }
   Returns: { ok: true } | { ok: false, retryAfterSec: number }
───────────────────────────────────────────────────────────────── */
router.post("/send", async (req, res) => {
  try {
    const { phone, purpose = "verify" } = req.body;

    if (!phone || !isValidUzPhone(phone)) {
      return res.status(400).json({ error: "Введите корректный номер телефона (+998XXXXXXXXX)" });
    }
    if (!["verify", "forgot_password"].includes(purpose)) {
      return res.status(400).json({ error: "Недопустимый тип кода" });
    }

    const result = await sendOtp(phone, purpose);

    if (!result.ok) {
      return res.status(429).json({
        error: `Подождите ${result.retryAfterSec} сек. перед повторной отправкой`,
        retryAfterSec: result.retryAfterSec,
      });
    }

    const response = { ok: true, message: "Код отправлен на ваш номер" };
    // В dev-режиме (или если Eskiz не настроен) возвращаем код для удобства тестирования
    if (result._dev_code) response._dev_code = result._dev_code;

    return res.json(response);
  } catch (err) {
    console.error("[sms/send]", err);
    res.status(502).json({ error: "Не удалось отправить SMS. Попробуйте позже." });
  }
});

/* ─────────────────────────────────────────────────────────────────
   2. POST /api/sms/verify
   Проверить введённый пользователем код.
   Body: { phone: string, code: string, purpose?: "verify" }
   Returns: { valid: true, phone: string } | { valid: false, error: string }
───────────────────────────────────────────────────────────────── */
router.post("/verify", async (req, res) => {
  try {
    const { phone, code, purpose = "verify" } = req.body;

    if (!phone || !code) {
      return res.status(400).json({ error: "Укажите телефон и код" });
    }

    const result = await verifyOtp(phone, code, purpose);

    if (!result.valid) {
      return res.status(400).json({ valid: false, error: result.reason });
    }

    return res.json({ valid: true, phone: result.phone });
  } catch (err) {
    console.error("[sms/verify]", err);
    res.status(500).json({ error: "Ошибка проверки кода" });
  }
});

/* ─────────────────────────────────────────────────────────────────
   3. POST /api/sms/delete-code
   Явно удалить OTP-код (пользователь закрыл форму / передумал).
   Body: { phone: string, purpose?: string }
   Returns: { ok: true }
───────────────────────────────────────────────────────────────── */
router.post("/delete-code", async (req, res) => {
  try {
    const { phone, purpose } = req.body;
    if (!phone) return res.status(400).json({ error: "Укажите телефон" });

    const normalized = normalizePhone(phone);

    if (purpose) {
      await query(
        "DELETE FROM sms_codes WHERE phone = $1 AND purpose = $2",
        [normalized, purpose]
      );
    } else {
      await query("DELETE FROM sms_codes WHERE phone = $1", [normalized]);
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error("[sms/delete-code]", err);
    res.status(500).json({ error: "Ошибка сервера" });
  }
});

/* ─────────────────────────────────────────────────────────────────
   4. POST /api/sms/forgot-password
   Запросить SMS-код для сброса пароля (для курьеров/продавцов).
   У пользователя должен быть привязан телефон в аккаунте.
   Body: { login: string }
   Returns: { ok: true, phone: "998***XX" }  — маскируем номер
───────────────────────────────────────────────────────────────── */
router.post("/forgot-password", async (req, res) => {
  try {
    const { login } = req.body;
    if (!login) return res.status(400).json({ error: "Укажите логин" });

    // Ищем аккаунт по логину
    const { rows } = await query(
      "SELECT id, phone, name, active FROM accounts WHERE login = $1",
      [login.trim().toLowerCase()]
    );

    const acc = rows[0];
    // Отвечаем одинаково вне зависимости от того, найден ли аккаунт (защита от перебора)
    if (!acc || !acc.active || !acc.phone) {
      return res.json({
        ok: true,
        message: "Если аккаунт с таким логином существует и к нему привязан телефон, вы получите SMS",
      });
    }

    let result;
    try {
      result = await sendOtp(acc.phone, "forgot_password");
    } catch {
      // Не раскрываем наличие аккаунта при сбое отправки — отвечаем тем же нейтральным сообщением
      return res.json({
        ok: true,
        message: "Если аккаунт с таким логином существует и к нему привязан телефон, вы получите SMS",
      });
    }

    if (!result.ok) {
      return res.status(429).json({
        error: `Подождите ${result.retryAfterSec} сек. перед повторной отправкой`,
        retryAfterSec: result.retryAfterSec,
      });
    }

    // Маскируем номер: 998901234567 → 998*****4567
    const normalized = normalizePhone(acc.phone);
    const masked = normalized.replace(/^(\d{3})\d{5}(\d{4})$/, "$1*****$2");

    const response = { ok: true, phone: masked || normalized, message: "Код отправлен" };
    if (result._dev_code) response._dev_code = result._dev_code;

    return res.json(response);
  } catch (err) {
    console.error("[sms/forgot-password]", err);
    res.status(500).json({ error: "Ошибка сервера" });
  }
});

/* ─────────────────────────────────────────────────────────────────
   5. POST /api/sms/reset-password
   Сбросить пароль, подтвердив SMS-код.
   Body: { login: string, code: string, newPassword: string }
   Returns: { ok: true }
───────────────────────────────────────────────────────────────── */
router.post("/reset-password", async (req, res) => {
  try {
    const { login, code, newPassword } = req.body;

    if (!login || !code || !newPassword) {
      return res.status(400).json({ error: "Укажите логин, код и новый пароль" });
    }
    if (newPassword.length < 4) {
      return res.status(400).json({ error: "Пароль должен быть не менее 4 символов" });
    }

    // Находим аккаунт и его телефон
    const { rows } = await query(
      "SELECT id, phone, active FROM accounts WHERE login = $1",
      [login.trim().toLowerCase()]
    );
    const acc = rows[0];
    if (!acc || !acc.active || !acc.phone) {
      return res.status(400).json({ error: "Аккаунт не найден или телефон не привязан" });
    }

    // Проверяем OTP
    const result = await verifyOtp(acc.phone, code, "forgot_password");
    if (!result.valid) {
      return res.status(400).json({ error: result.reason });
    }

    // Устанавливаем новый пароль, сбрасываем временный
    const hash = await bcrypt.hash(newPassword, 10);
    await query(
      "UPDATE accounts SET password_hash = $1, temp_pass = NULL WHERE id = $2",
      [hash, acc.id]
    );

    // Удаляем использованный код
    await deleteOtpByPhone(acc.phone);

    return res.json({ ok: true, message: "Пароль успешно изменён" });
  } catch (err) {
    console.error("[sms/reset-password]", err);
    res.status(500).json({ error: "Ошибка сервера" });
  }
});

/* ─────────────────────────────────────────────────────────────────
   6. DELETE /api/sms/phone
   Удалить/отвязать номер телефона покупателя (Telegram-пользователя).
   Требует подтверждения кодом перед удалением.
   Используется из профиля покупателя в Mini App.

   Шаг 1 — запрос кода: POST /api/sms/send { phone, purpose: "verify" }
   Шаг 2 — удаление:    DELETE /api/sms/phone { telegram_id, phone, code }
───────────────────────────────────────────────────────────────── */
router.delete("/phone", async (req, res) => {
  try {
    const { telegram_id, phone, code } = req.body;

    if (!telegram_id || !phone || !code) {
      return res.status(400).json({ error: "Укажите telegram_id, телефон и код подтверждения" });
    }

    // Проверяем что покупатель существует и номер совпадает
    const { rows } = await query(
      "SELECT telegram_id, phone FROM customers WHERE telegram_id = $1",
      [String(telegram_id)]
    );
    const customer = rows[0];
    if (!customer) {
      return res.status(404).json({ error: "Покупатель не найден" });
    }

    const normalizedStored = normalizePhone(customer.phone || "");
    const normalizedInput  = normalizePhone(phone);
    if (!normalizedStored || normalizedStored !== normalizedInput) {
      return res.status(400).json({ error: "Указанный номер не совпадает с привязанным" });
    }

    // Проверяем код
    const result = await verifyOtp(phone, code, "verify");
    if (!result.valid) {
      return res.status(400).json({ error: result.reason });
    }

    // Удаляем номер
    await query(
      "UPDATE customers SET phone = NULL, updated_at = NOW() WHERE telegram_id = $1",
      [String(telegram_id)]
    );

    // Удаляем все коды для этого номера
    await deleteOtpByPhone(phone);

    return res.json({ ok: true, message: "Номер телефона удалён" });
  } catch (err) {
    console.error("[sms/delete-phone]", err);
    res.status(500).json({ error: "Ошибка сервера" });
  }
});

module.exports = router;
