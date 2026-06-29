// src/routes/catalog.js
const router = require("express").Router();
const { query } = require("../db");
const { requireAuth, requireAdmin, requireSeller } = require("../middleware/auth");

/* ──────────────────────────────────────────────────────────────
   ТОВАРЫ
────────────────────────────────────────────────────────────── */

/**
 * GET /api/catalog/products
 * Публичный список товаров (только активные для клиентов)
 * Query: ?category=fish&active=true
 */
router.get("/products", async (req, res) => {
  try {
    const { category, active } = req.query;
    const params = [];
    const conditions = [];

    // Публичный запрос — только активные
    const showAll = req.headers.authorization ? true : false;
    if (!showAll) {
      conditions.push("active = TRUE AND stock > 0");
    } else if (active === "false") {
      conditions.push("active = FALSE");
    } else if (active === "true") {
      conditions.push("active = TRUE");
    }

    if (category && category !== "all") {
      params.push(category);
      conditions.push(`category = $${params.length}`);
    }

    const where = conditions.length ? "WHERE " + conditions.join(" AND ") : "";

    const { rows } = await query(
      `SELECT * FROM products ${where} ORDER BY orders_count DESC, name ASC`,
      params
    );
    res.json({ products: rows });
  } catch (err) {
    console.error("[catalog/products]", err);
    res.status(500).json({ error: "Ошибка сервера" });
  }
});

/**
 * GET /api/catalog/products/:id
 */
router.get("/products/:id", async (req, res) => {
  try {
    const { rows } = await query("SELECT * FROM products WHERE id=$1", [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: "Товар не найден" });
    res.json({ product: rows[0] });
  } catch (err) {
    res.status(500).json({ error: "Ошибка сервера" });
  }
});

/**
 * POST /api/catalog/products
 * Создать товар (admin/seller)
 */
router.post("/products", requireAuth, requireSeller, async (req, res) => {
  try {
    const { id, name, emoji, category, price, min_price = 0, stock = 0, description = "" } = req.body;
    if (!id || !name || !category || !price) {
      return res.status(400).json({ error: "Заполните обязательные поля: id, name, category, price" });
    }
    const { rows } = await query(`
      INSERT INTO products (id, name, emoji, category, price, min_price, stock, description)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *
    `, [id, name, emoji, category, price, min_price, stock, description]);
    res.status(201).json({ product: rows[0] });
  } catch (err) {
    if (err.code === "23505") return res.status(409).json({ error: "Товар с таким ID уже существует" });
    console.error("[catalog/create]", err);
    res.status(500).json({ error: "Ошибка сервера" });
  }
});

/**
 * PATCH /api/catalog/products/:id
 * Обновить товар (admin/seller)
 * Body: любые поля из products
 */
router.patch("/products/:id", requireAuth, requireSeller, async (req, res) => {
  try {
    const allowed = ["name","emoji","category","price","min_price","stock","active","description"];
    const updates = [];
    const params = [];

    for (const [key, val] of Object.entries(req.body)) {
      if (allowed.includes(key)) {
        params.push(val);
        updates.push(`${key}=$${params.length}`);
      }
    }
    if (!updates.length) return res.status(400).json({ error: "Нет данных для обновления" });

    params.push(req.params.id);
    updates.push("updated_at=NOW()");

    const { rows } = await query(
      `UPDATE products SET ${updates.join(",")} WHERE id=$${params.length} RETURNING *`,
      params
    );
    if (!rows[0]) return res.status(404).json({ error: "Товар не найден" });
    res.json({ product: rows[0] });
  } catch (err) {
    console.error("[catalog/update]", err);
    res.status(500).json({ error: "Ошибка сервера" });
  }
});

/**
 * DELETE /api/catalog/products/:id
 * Удалить товар (только admin)
 */
router.delete("/products/:id", requireAuth, requireAdmin, async (req, res) => {
  try {
    const { rows } = await query(
      "DELETE FROM products WHERE id=$1 RETURNING id, name", [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: "Товар не найден" });
    res.json({ ok: true, deleted: rows[0] });
  } catch (err) {
    res.status(500).json({ error: "Ошибка сервера" });
  }
});

/* ──────────────────────────────────────────────────────────────
   ПРОМОКОДЫ
────────────────────────────────────────────────────────────── */

/**
 * POST /api/catalog/promos/check
 * Проверить промокод (из Mini App)
 * Body: { code, subtotal }
 */
router.post("/promos/check", async (req, res) => {
  try {
    const { code, subtotal = 0 } = req.body;
    if (!code) return res.status(400).json({ error: "Введите промокод" });

    const { rows } = await query(`
      SELECT * FROM promos
      WHERE code = $1
        AND active = TRUE
        AND (expires_at IS NULL OR expires_at >= CURRENT_DATE)
        AND (max_uses IS NULL OR uses < max_uses)
    `, [code.toUpperCase().trim()]);

    if (!rows[0]) {
      return res.status(404).json({ error: "Промокод не найден, истёк или исчерпан" });
    }

    const promo = rows[0];
    const discount = Math.round(subtotal * promo.discount / 100);
    res.json({ ok: true, discount_percent: promo.discount, discount_sum: discount });
  } catch (err) {
    res.status(500).json({ error: "Ошибка сервера" });
  }
});

/**
 * GET /api/catalog/promos
 * Список промокодов (admin)
 */
router.get("/promos", requireAuth, requireAdmin, async (req, res) => {
  try {
    const { rows } = await query("SELECT * FROM promos ORDER BY created_at DESC");
    res.json({ promos: rows });
  } catch (err) {
    res.status(500).json({ error: "Ошибка сервера" });
  }
});

/**
 * POST /api/catalog/promos
 * Создать промокод (admin)
 */
router.post("/promos", requireAuth, requireAdmin, async (req, res) => {
  try {
    const { code, discount, max_uses = 100, expires_at } = req.body;
    if (!code || !discount) return res.status(400).json({ error: "Укажите code и discount" });

    const { rows } = await query(`
      INSERT INTO promos (code, discount, max_uses, expires_at)
      VALUES ($1,$2,$3,$4) RETURNING *
    `, [code.toUpperCase().trim(), discount, max_uses, expires_at || null]);
    res.status(201).json({ promo: rows[0] });
  } catch (err) {
    if (err.code === "23505") return res.status(409).json({ error: "Такой промокод уже существует" });
    res.status(500).json({ error: "Ошибка сервера" });
  }
});

/**
 * PATCH /api/catalog/promos/:code
 * Включить/выключить или обновить промокод
 */
router.patch("/promos/:code", requireAuth, requireAdmin, async (req, res) => {
  try {
    const allowed = ["active", "discount", "max_uses", "expires_at"];
    const updates = [];
    const params = [];
    for (const [key, val] of Object.entries(req.body)) {
      if (allowed.includes(key)) {
        params.push(val);
        updates.push(`${key}=$${params.length}`);
      }
    }
    if (!updates.length) return res.status(400).json({ error: "Нет данных" });
    params.push(req.params.code.toUpperCase());
    const { rows } = await query(
      `UPDATE promos SET ${updates.join(",")} WHERE code=$${params.length} RETURNING *`,
      params
    );
    if (!rows[0]) return res.status(404).json({ error: "Промокод не найден" });
    res.json({ promo: rows[0] });
  } catch (err) {
    res.status(500).json({ error: "Ошибка сервера" });
  }
});

/**
 * DELETE /api/catalog/promos/:code
 */
router.delete("/promos/:code", requireAuth, requireAdmin, async (req, res) => {
  try {
    const { rows } = await query(
      "DELETE FROM promos WHERE code=$1 RETURNING code", [req.params.code.toUpperCase()]
    );
    if (!rows[0]) return res.status(404).json({ error: "Промокод не найден" });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "Ошибка сервера" });
  }
});

/* ──────────────────────────────────────────────────────────────
   ДОСТАВКА
────────────────────────────────────────────────────────────── */

/**
 * GET /api/catalog/delivery
 * Тарифы доставки (публичные)
 */
router.get("/delivery", async (req, res) => {
  try {
    const { rows } = await query("SELECT * FROM delivery_rates ORDER BY region");
    res.json({ rates: rows });
  } catch (err) {
    res.status(500).json({ error: "Ошибка сервера" });
  }
});

/**
 * PATCH /api/catalog/delivery/:region
 * Обновить тариф доставки (admin)
 */
router.patch("/delivery/:region", requireAuth, requireAdmin, async (req, res) => {
  try {
    const { price, time_label, courier_name, courier_phone, rating } = req.body;
    const updates = [];
    const params = [];
    if (price !== undefined) { params.push(price); updates.push(`price=$${params.length}`); }
    if (time_label)  { params.push(time_label);  updates.push(`time_label=$${params.length}`); }
    if (courier_name){ params.push(courier_name); updates.push(`courier_name=$${params.length}`); }
    if (courier_phone){ params.push(courier_phone);updates.push(`courier_phone=$${params.length}`); }
    if (rating !== undefined){ params.push(rating);updates.push(`rating=$${params.length}`); }

    if (!updates.length) return res.status(400).json({ error: "Нет данных" });
    params.push(req.params.region);

    const { rows } = await query(
      `UPDATE delivery_rates SET ${updates.join(",")} WHERE region=$${params.length} RETURNING *`,
      params
    );
    if (!rows[0]) return res.status(404).json({ error: "Регион не найден" });
    res.json({ rate: rows[0] });
  } catch (err) {
    res.status(500).json({ error: "Ошибка сервера" });
  }
});

module.exports = router;
