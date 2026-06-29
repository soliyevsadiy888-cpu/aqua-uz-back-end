// src/routes/auth.js
const router = require("express").Router();
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { query } = require("../db");
const { requireAuth } = require("../middleware/auth");

/**
 * POST /api/auth/login
 * Body: { login, password, role }
 * Returns: { token, user }
 */
router.post("/login", async (req, res) => {
  try {
    const { login, password, role } = req.body;
    if (!login || !password) {
      return res.status(400).json({ error: "Введите логин и пароль" });
    }

    const { rows } = await query(
      `SELECT id, role, name, phone, region, login, password_hash, temp_pass, active
       FROM accounts WHERE login = $1`,
      [login.trim().toLowerCase()]
    );

    const acc = rows[0];
    if (!acc) {
      return res.status(401).json({ error: "Неверный логин или пароль" });
    }
    if (role && acc.role !== role && acc.role !== "admin") {
      return res.status(401).json({ error: "Неверный логин или пароль" });
    }
    if (!acc.active) {
      return res.status(403).json({ error: "Аккаунт заблокирован. Обратитесь к администратору." });
    }

    // Проверяем основной пароль или временный
    const mainOk = await bcrypt.compare(password, acc.password_hash);
    const tempOk = acc.temp_pass && await bcrypt.compare(password, acc.temp_pass);

    if (!mainOk && !tempOk) {
      return res.status(401).json({ error: "Неверный логин или пароль" });
    }

    // Обновляем last_login
    await query("UPDATE accounts SET last_login = NOW() WHERE id = $1", [acc.id]);

    const token = jwt.sign(
      { id: acc.id, role: acc.role, name: acc.name },
      process.env.JWT_SECRET,
      { expiresIn: "7d" }
    );

    return res.json({
      token,
      needPasswordChange: !!tempOk,
      user: {
        id: acc.id,
        role: acc.role,
        name: acc.name,
        phone: acc.phone,
        region: acc.region,
      },
    });
  } catch (err) {
    console.error("[auth/login]", err);
    res.status(500).json({ error: "Ошибка сервера" });
  }
});

/**
 * POST /api/auth/change-password
 * Меняет пароль (в т.ч. после сброса)
 * Body: { newPassword }
 */
router.post("/change-password", requireAuth, async (req, res) => {
  try {
    const { newPassword } = req.body;
    if (!newPassword || newPassword.length < 4) {
      return res.status(400).json({ error: "Пароль должен быть не менее 4 символов" });
    }
    const hash = await bcrypt.hash(newPassword, 10);
    await query(
      "UPDATE accounts SET password_hash=$1, temp_pass=NULL WHERE id=$2",
      [hash, req.user.id]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error("[auth/change-password]", err);
    res.status(500).json({ error: "Ошибка сервера" });
  }
});

/**
 * GET /api/auth/me
 * Возвращает текущего пользователя
 */
router.get("/me", requireAuth, async (req, res) => {
  res.json({ user: req.user });
});

module.exports = router;
