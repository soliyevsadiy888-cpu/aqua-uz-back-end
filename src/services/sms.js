// src/services/sms.js
// SMS-верификация через Eskiz.uz (самый популярный SMS-шлюз в Узбекистане)
// Документация: https://documenter.getpostman.com/view/663428/RzfmES4z
require("dotenv").config();
const { query } = require("../db");

// ── Eskiz.uz API ────────────────────────────────────────────────
const ESKIZ_BASE = "https://notify.eskiz.uz/api";

let eskizToken = null;
let eskizTokenExpiry = 0;

// Считаем, что Eskiz реально настроен, только если заданы оба параметра
const ESKIZ_CONFIGURED = !!(process.env.ESKIZ_EMAIL && process.env.ESKIZ_PASSWORD);

/**
 * Получить/обновить Bearer-токен Eskiz
 */
async function getEskizToken() {
  if (eskizToken && Date.now() < eskizTokenExpiry) return eskizToken;

  const resp = await fetch(`${ESKIZ_BASE}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: process.env.ESKIZ_EMAIL,
      password: process.env.ESKIZ_PASSWORD,
    }),
  });
  const data = await resp.json();
  if (!resp.ok || !data.data?.token) {
    throw new Error(`Eskiz auth error: ${JSON.stringify(data)}`);
  }
  eskizToken = data.data.token;
  // Токен живёт 29 дней; обновляем за 1 час до истечения
  eskizTokenExpiry = Date.now() + 29 * 24 * 60 * 60 * 1000 - 60 * 60 * 1000;
  return eskizToken;
}

/**
 * Отправить SMS через Eskiz.uz
 * @param {string} phone  — номер в формате 998XXXXXXXXX (без +)
 * @param {string} text   — текст сообщения (макс. 160 символов)
 */
async function sendSmsEskiz(phone, text) {
  const token = await getEskizToken();
  const resp = await fetch(`${ESKIZ_BASE}/message/sms/send`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      mobile_phone: phone.replace(/\D/g, ""), // только цифры
      message: text,
      from: process.env.ESKIZ_SENDER_NAME || "4546", // 4546 — тестовый sender id Eskiz, доступен без модерации
    }),
  });
  const data = await resp.json();
  if (!resp.ok) {
    // Если токен протух раньше срока (Eskiz иногда сбрасывает токены) — пробуем один раз заново
    if (resp.status === 401) {
      eskizToken = null;
      const token2 = await getEskizToken();
      const resp2 = await fetch(`${ESKIZ_BASE}/message/sms/send`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token2}`,
        },
        body: JSON.stringify({
          mobile_phone: phone.replace(/\D/g, ""),
          message: text,
          from: process.env.ESKIZ_SENDER_NAME || "4546",
        }),
      });
      const data2 = await resp2.json();
      if (!resp2.ok) throw new Error(`Eskiz send error: ${JSON.stringify(data2)}`);
      return data2;
    }
    throw new Error(`Eskiz send error: ${JSON.stringify(data)}`);
  }
  return data;
}

// ── Хранилище кодов в PostgreSQL ───────────────────────────────
// Таблица sms_codes создаётся в scripts/migrate-sms.js

const CODE_TTL_MIN = 5;  // код живёт 5 минут
const MAX_ATTEMPTS = 5;  // максимум попыток ввода
const RESEND_COOLDOWN_SEC = 60; // повторная отправка не ранее чем через 60 сек

/**
 * Нормализовать номер телефона → "998XXXXXXXXX"
 */
function normalizePhone(raw) {
  const digits = String(raw || "").replace(/\D/g, "");
  // Принимаем форматы: +998XXXXXXXXX, 998XXXXXXXXX, 0XXXXXXXXX, XXXXXXXXX (9 цифр)
  if (digits.startsWith("998") && digits.length === 12) return digits;
  if (digits.startsWith("0") && digits.length === 10) return "998" + digits.slice(1);
  if (digits.length === 9) return "998" + digits;
  return digits; // вернём как есть, валидация на уровне route
}

/**
 * Генерировать 6-значный цифровой код
 */
function generateCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

/**
 * Отправить OTP-код на номер телефона
 * @param {string} phone — любой формат
 * @param {string} purpose — 'verify' | 'forgot_password'
 * @returns {{ ok: boolean, retryAfterSec?: number, _dev_code?: string }}
 */
async function sendOtp(phone, purpose = "verify") {
  const normalized = normalizePhone(phone);

  // Проверяем cooldown — не спамим
  const { rows: existing } = await query(
    `SELECT created_at FROM sms_codes
     WHERE phone = $1 AND purpose = $2
     ORDER BY created_at DESC LIMIT 1`,
    [normalized, purpose]
  );
  if (existing[0]) {
    const diffSec = (Date.now() - new Date(existing[0].created_at).getTime()) / 1000;
    if (diffSec < RESEND_COOLDOWN_SEC) {
      return { ok: false, retryAfterSec: Math.ceil(RESEND_COOLDOWN_SEC - diffSec) };
    }
  }

  // Удаляем старые коды для этого номера+цели
  await query(
    "DELETE FROM sms_codes WHERE phone = $1 AND purpose = $2",
    [normalized, purpose]
  );

  const code = generateCode();
  const expiresAt = new Date(Date.now() + CODE_TTL_MIN * 60 * 1000);

  // Сохраняем в БД
  await query(
    `INSERT INTO sms_codes (phone, code, purpose, expires_at, attempts)
     VALUES ($1, $2, $3, $4, 0)`,
    [normalized, code, purpose, expiresAt]
  );

  // Формируем текст SMS
  const texts = {
    verify: `AquaUZ: vash kod podtverzhdeniya ${code}. Deystvitelen ${CODE_TTL_MIN} minut.`,
    forgot_password: `AquaUZ: kod dlya sbrosa parolya ${code}. Deystvitelen ${CODE_TTL_MIN} minut.`,
  };
  const smsText = texts[purpose] || `AquaUZ: vash kod ${code}`;

  // Если Eskiz не настроен (нет логина/пароля) — работаем в dev-режиме:
  // код не отправляется по SMS, а возвращается в ответе API для тестирования.
  if (!ESKIZ_CONFIGURED) {
    console.log(`[SMS DEV] ${normalized} → ${smsText}`);
    if (process.env.NODE_ENV === "production") {
      console.warn(
        "[SMS] ВНИМАНИЕ: ESKIZ_EMAIL/ESKIZ_PASSWORD не заданы в production! " +
        "Реальные SMS НЕ отправляются, коды видны только в логах/ответе API."
      );
    }
    return { ok: true, _dev_code: code };
  }

  try {
    await sendSmsEskiz(normalized, smsText);
    return { ok: true };
  } catch (err) {
    console.error("[SMS] Ошибка отправки через Eskiz:", err.message);
    // Не удаляем уже сохранённый код — пусть пользователь может попробовать через cooldown,
    // но сообщаем об ошибке вызывающей стороне, чтобы не показывать "успех" при реальном сбое.
    throw err;
  }
}

/**
 * Проверить OTP-код
 * @param {string} phone
 * @param {string} code  — введённый пользователем код
 * @param {string} purpose
 * @returns {{ valid: boolean, reason?: string, phone?: string }}
 */
async function verifyOtp(phone, code, purpose = "verify") {
  const normalized = normalizePhone(phone);

  const { rows } = await query(
    `SELECT id, code, expires_at, attempts, verified
     FROM sms_codes
     WHERE phone = $1 AND purpose = $2
     ORDER BY created_at DESC LIMIT 1`,
    [normalized, purpose]
  );

  const record = rows[0];
  if (!record) return { valid: false, reason: "Код не найден. Запросите новый." };
  if (record.verified) return { valid: false, reason: "Код уже использован." };
  if (new Date() > new Date(record.expires_at)) {
    await query("DELETE FROM sms_codes WHERE id = $1", [record.id]);
    return { valid: false, reason: "Код истёк. Запросите новый." };
  }
  if (record.attempts >= MAX_ATTEMPTS) {
    await query("DELETE FROM sms_codes WHERE id = $1", [record.id]);
    return { valid: false, reason: "Превышено количество попыток. Запросите новый код." };
  }

  if (record.code !== String(code).trim()) {
    await query("UPDATE sms_codes SET attempts = attempts + 1 WHERE id = $1", [record.id]);
    const left = MAX_ATTEMPTS - record.attempts - 1;
    return { valid: false, reason: `Неверный код. Осталось попыток: ${left}.` };
  }

  // Код верный — помечаем как использованный (не удаляем сразу, нужен для forgot_password flow)
  await query(
    "UPDATE sms_codes SET verified = TRUE, verified_at = NOW() WHERE id = $1",
    [record.id]
  );
  return { valid: true, phone: normalized };
}

/**
 * Удалить все коды для номера (при смене/удалении номера)
 */
async function deleteOtpByPhone(phone) {
  const normalized = normalizePhone(phone);
  await query("DELETE FROM sms_codes WHERE phone = $1", [normalized]);
}

/**
 * Очистка просроченных кодов (запускать по cron / setInterval)
 */
async function cleanExpiredCodes() {
  const { rowCount } = await query(
    "DELETE FROM sms_codes WHERE expires_at < NOW() OR (verified = TRUE AND verified_at < NOW() - INTERVAL '1 hour')"
  );
  if (rowCount > 0) {
    console.log(`[SMS] Очищено просроченных кодов: ${rowCount}`);
  }
}

module.exports = {
  normalizePhone,
  sendOtp,
  verifyOtp,
  deleteOtpByPhone,
  cleanExpiredCodes,
  sendSmsEskiz,
  ESKIZ_CONFIGURED,
};
