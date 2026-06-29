// src/routes/admin.js
const router = require("express").Router();
const bcrypt = require("bcryptjs");
const { query } = require("../db");
const { requireAuth, requireAdmin } = require("../middleware/auth");
const { sendSmsEskiz, ESKIZ_CONFIGURED, normalizePhone } = require("../services/sms");
const { getBot } = require("../services/telegram");

// Все маршруты требуют авторизацию + роль admin
router.use(requireAuth, requireAdmin);

/* ──────────────────────────────────────────────────────────────
   АККАУНТЫ (курьеры, продавцы)
────────────────────────────────────────────────────────────── */

/**
 * GET /api/admin/accounts
 * Query: ?role=courier|seller|all
 */
router.get("/accounts", async (req, res) => {
  try {
    const { role } = req.query;
    const params = [];
    let where = "";
    if (role && role !== "all") {
      params.push(role);
      where = "WHERE role=$1";
    }
    // Никогда не отдаём хэш пароля
    const { rows } = await query(
      `SELECT id, role, name, phone, region, login, active,
              telegram_id, last_login, created_at,
              CASE WHEN temp_pass IS NOT NULL THEN TRUE ELSE FALSE END AS has_temp_pass
       FROM accounts ${where}
       ORDER BY role, name`,
      params
    );
    res.json({ accounts: rows });
  } catch (err) {
    res.status(500).json({ error: "Ошибка сервера" });
  }
});

/**
 * POST /api/admin/accounts
 * Создать новый аккаунт
 */
router.post("/accounts", async (req, res) => {
  try {
    const { role, name, phone, region, login, password } = req.body;
    if (!role || !name || !login || !password) {
      return res.status(400).json({ error: "Заполните: role, name, login, password" });
    }
    if (!["courier","seller","admin"].includes(role)) {
      return res.status(400).json({ error: "Недопустимая роль" });
    }
    const id = `${role[0]}_${Date.now()}`;
    const hash = await bcrypt.hash(password, 10);

    const { rows } = await query(`
      INSERT INTO accounts (id, role, name, phone, region, login, password_hash, active)
      VALUES ($1,$2,$3,$4,$5,$6,$7,TRUE) RETURNING id,role,name,phone,region,login,active,created_at
    `, [id, role, name, phone, region, login.toLowerCase().trim(), hash]);

    res.status(201).json({ account: rows[0] });
  } catch (err) {
    if (err.code === "23505") return res.status(409).json({ error: "Логин уже занят" });
    console.error("[admin/accounts/create]", err);
    res.status(500).json({ error: "Ошибка сервера" });
  }
});

/**
 * PATCH /api/admin/accounts/:id
 * Обновить данные аккаунта
 */
router.patch("/accounts/:id", async (req, res) => {
  try {
    const allowed = ["name","phone","region","active","telegram_id"];
    const updates = [];
    const params = [];
    for (const [key, val] of Object.entries(req.body)) {
      if (allowed.includes(key)) {
        params.push(val);
        updates.push(`${key}=$${params.length}`);
      }
    }
    if (!updates.length) return res.status(400).json({ error: "Нет данных" });
    params.push(req.params.id);

    const { rows } = await query(
      `UPDATE accounts SET ${updates.join(",")} WHERE id=$${params.length}
       RETURNING id,role,name,phone,region,login,active,telegram_id`,
      params
    );
    if (!rows[0]) return res.status(404).json({ error: "Аккаунт не найден" });
    res.json({ account: rows[0] });
  } catch (err) {
    res.status(500).json({ error: "Ошибка сервера" });
  }
});

/**
 * POST /api/admin/accounts/:id/reset-password
 * Сбросить пароль — генерирует временный пароль
 */
router.post("/accounts/:id/reset-password", async (req, res) => {
  try {
    // Генерируем 6-символьный временный пароль
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    const tempPass = Array.from({ length: 6 }, () =>
      chars[Math.floor(Math.random() * chars.length)]
    ).join("");

    const hash = await bcrypt.hash(tempPass, 10);
    const { rows } = await query(
      "UPDATE accounts SET temp_pass=$1 WHERE id=$2 RETURNING id, name, login",
      [hash, req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: "Аккаунт не найден" });

    // Возвращаем временный пароль в открытом виде (только один раз!)
    res.json({ ok: true, temp_pass: tempPass, account: rows[0] });
  } catch (err) {
    res.status(500).json({ error: "Ошибка сервера" });
  }
});

/**
 * POST /api/admin/accounts/:id/reset-password-sms
 * Сбросить пароль и ОТПРАВИТЬ временный пароль по SMS (и/или Telegram),
 * вместо того чтобы показывать его только в ответе API.
 * Требует чтобы у аккаунта был привязан номер телефона или telegram_id.
 */
router.post("/accounts/:id/reset-password-sms", async (req, res) => {
  try {
    const { rows: accRows } = await query(
      "SELECT id, name, login, phone, telegram_id FROM accounts WHERE id = $1",
      [req.params.id]
    );
    const acc = accRows[0];
    if (!acc) return res.status(404).json({ error: "Аккаунт не найден" });
    if (!acc.phone && !acc.telegram_id) {
      return res.status(400).json({
        error: "У аккаунта нет телефона и Telegram — невозможно доставить пароль",
      });
    }

    // Генерируем временный пароль
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    const tempPass = Array.from({ length: 6 }, () =>
      chars[Math.floor(Math.random() * chars.length)]
    ).join("");

    const hash = await bcrypt.hash(tempPass, 10);
    await query(
      "UPDATE accounts SET temp_pass = $1 WHERE id = $2",
      [hash, acc.id]
    );

    let smsOk = false;
    let smsDevCode = null;

    // Отправляем по SMS если есть телефон
    if (acc.phone) {
      try {
        const normalized = normalizePhone(acc.phone);
        const text = `AquaUZ: vremenny parol dlya ${acc.login}: ${tempPass}. Smenite parol posle vhoda.`;

        if (!ESKIZ_CONFIGURED) {
          console.log(`[SMS DEV] ${normalized} → ${text}`);
          smsDevCode = tempPass;
        } else {
          await sendSmsEskiz(normalized, text);
        }
        smsOk = true;
      } catch (err) {
        console.error("[admin/reset-password-sms] Ошибка отправки SMS:", err.message);
      }
    }

    // Дублируем в Telegram если есть telegram_id
    let tgOk = false;
    if (acc.telegram_id) {
      try {
        await getBot().sendMessage(
          acc.telegram_id,
          `🔑 Ваш временный пароль AquaUZ: *${tempPass}*\n\nВойдите и смените пароль в настройках.`,
          { parse_mode: "Markdown" }
        );
        tgOk = true;
      } catch (err) {
        console.error("[admin/reset-password-sms] Ошибка отправки в Telegram:", err.message);
      }
    }

    if (!smsOk && !tgOk) {
      return res.status(502).json({
        error: "Не удалось доставить временный пароль ни по SMS, ни в Telegram",
      });
    }

    const response = {
      ok: true,
      delivered_via: [smsOk && "sms", tgOk && "telegram"].filter(Boolean),
    };
    // В dev-режиме (Eskiz не настроен) отдаём пароль и в ответе, для удобства тестирования
    if (smsDevCode) response._dev_temp_pass = smsDevCode;

    res.json(response);
  } catch (err) {
    console.error("[admin/reset-password-sms]", err);
    res.status(500).json({ error: "Ошибка сервера" });
  }
});


/**
 * DELETE /api/admin/accounts/:id
 * Удалить аккаунт
 */
router.delete("/accounts/:id", async (req, res) => {
  try {
    if (req.params.id === req.user.id) {
      return res.status(400).json({ error: "Нельзя удалить свой аккаунт" });
    }
    const { rows } = await query(
      "DELETE FROM accounts WHERE id=$1 AND role != 'admin' RETURNING id, name",
      [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: "Аккаунт не найден" });
    res.json({ ok: true, deleted: rows[0] });
  } catch (err) {
    res.status(500).json({ error: "Ошибка сервера" });
  }
});

/* ──────────────────────────────────────────────────────────────
   КУРЬЕРЫ — статусы онлайн
────────────────────────────────────────────────────────────── */

/**
 * GET /api/admin/couriers
 * Список курьеров с тарифами доставки
 */
router.get("/couriers", async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT a.id, a.name, a.phone, a.region, a.active,
             a.last_login, a.telegram_id,
             dr.price as rate, dr.rating, dr.trips, dr.time_label
      FROM accounts a
      LEFT JOIN delivery_rates dr ON dr.region = a.region
      WHERE a.role = 'courier'
      ORDER BY a.name
    `);
    res.json({ couriers: rows });
  } catch (err) {
    res.status(500).json({ error: "Ошибка сервера" });
  }
});

/* ──────────────────────────────────────────────────────────────
   НАСТРОЙКИ
────────────────────────────────────────────────────────────── */

/**
 * GET /api/admin/settings
 * Все настройки
 */
router.get("/settings", async (req, res) => {
  try {
    const { rows } = await query("SELECT key, value FROM settings");
    const settings = Object.fromEntries(rows.map((r) => [r.key, parseValue(r.value)]));
    res.json({ settings });
  } catch (err) {
    res.status(500).json({ error: "Ошибка сервера" });
  }
});

/**
 * PATCH /api/admin/settings
 * Обновить настройки
 * Body: { store_open: true, sms_notify: false, ... }
 */
router.patch("/settings", async (req, res) => {
  try {
    for (const [key, val] of Object.entries(req.body)) {
      await query(`
        INSERT INTO settings (key, value) VALUES ($1,$2)
        ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value
      `, [key, String(val)]);
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "Ошибка сервера" });
  }
});

// Конвертируем строки "true"/"false"/"123" в нативные типы
function parseValue(v) {
  if (v === "true") return true;
  if (v === "false") return false;
  if (!isNaN(v) && v !== "") return Number(v);
  return v;
}

module.exports = router;
