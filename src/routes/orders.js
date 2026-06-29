// src/routes/orders.js
const router = require("express").Router();
const { query, transaction } = require("../db");
const { requireAuth, requireAdmin, requireSeller, validateTelegramInit } = require("../middleware/auth");
const { notifyAdminNewOrder, notifyCustomerStatus, notifyCourierAssigned } = require("../services/telegram");

const NEXT_STATUS = {
  accepted: "packed",
  packed:   "courier",
  courier:  "way",
  way:      "delivered",
};

/**
 * POST /api/orders
 * Создать заказ (из Mini App)
 * Body: { phone, region, address, comment, delivery_slot, pay_method,
 *         promo_code, items: [{product_id, name, price, qty}],
 *         buyer_name, telegram_user }
 */
router.post("/", async (req, res) => {
  try {
    const {
      phone, region, address, comment = "", delivery_slot = "",
      pay_method = "cash", promo_code, items = [],
      buyer_name, telegram_user,
    } = req.body;

    if (!phone || !region || !address || items.length === 0) {
      return res.status(400).json({ error: "Заполните все обязательные поля" });
    }

    // Проверяем что магазин открыт
    const { rows: settRows } = await query(
      "SELECT value FROM settings WHERE key='store_open'"
    );
    if (settRows[0]?.value === "false") {
      return res.status(503).json({ error: "Магазин временно закрыт" });
    }

    // Получаем тариф доставки
    const { rows: rateRows } = await query(
      "SELECT price FROM delivery_rates WHERE region = $1", [region]
    );
    const delivery_fee = rateRows[0]?.price ?? 50000;

    // Считаем суммы
    const subtotal = items.reduce((s, i) => s + i.price * i.qty, 0);

    // Проверяем промокод
    let promo_discount = 0;
    let valid_promo = null;
    if (promo_code) {
      const { rows: promoRows } = await query(
        `SELECT * FROM promos WHERE code=$1 AND active=TRUE
         AND (expires_at IS NULL OR expires_at >= CURRENT_DATE)
         AND (max_uses IS NULL OR uses < max_uses)`,
        [promo_code.toUpperCase()]
      );
      if (promoRows[0]) {
        valid_promo = promoRows[0];
        promo_discount = Math.round(subtotal * promoRows[0].discount / 100);
      }
    }

    const total = subtotal - promo_discount + delivery_fee;

    const result = await transaction(async ({ query: q }) => {
      // Сохраняем/обновляем покупателя
      let customer_id = null;
      if (telegram_user?.id) {
        await q(`
          INSERT INTO customers (telegram_id, first_name, last_name, username, phone, region)
          VALUES ($1,$2,$3,$4,$5,$6)
          ON CONFLICT (telegram_id) DO UPDATE SET
            first_name=EXCLUDED.first_name, username=EXCLUDED.username,
            phone=EXCLUDED.phone, region=EXCLUDED.region, updated_at=NOW()
        `, [
          telegram_user.id,
          telegram_user.first_name,
          telegram_user.last_name,
          telegram_user.username,
          phone,
          region,
        ]);
        customer_id = telegram_user.id;
      }

      // Создаём заказ
      const { rows: [order] } = await q(`
        INSERT INTO orders
          (customer_id, buyer_name, phone, region, address, comment,
           delivery_slot, pay_method, promo_code, promo_discount,
           subtotal, delivery_fee, total, status)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'accepted')
        RETURNING *
      `, [
        customer_id, buyer_name || null, phone, region, address, comment,
        delivery_slot, pay_method,
        valid_promo ? valid_promo.code : null,
        promo_discount, subtotal, delivery_fee, total,
      ]);

      // Позиции заказа
      for (const item of items) {
        await q(`
          INSERT INTO order_items (order_id, product_id, name, price, qty)
          VALUES ($1,$2,$3,$4,$5)
        `, [order.id, item.product_id || null, item.name, item.price, item.qty]);

        // Уменьшаем склад
        if (item.product_id) {
          await q(`
            UPDATE products
            SET stock = GREATEST(0, stock - $1),
                orders_count = orders_count + $1,
                updated_at = NOW()
            WHERE id = $2
          `, [item.qty, item.product_id]);
        }
      }

      // Инкрементируем использование промокода
      if (valid_promo) {
        await q("UPDATE promos SET uses = uses + 1 WHERE code = $1", [valid_promo.code]);
      }

      return order;
    });

    // Нотификации (асинхронно, не блокируем ответ)
    const fullOrder = { ...result, items };
    notifyAdminNewOrder(fullOrder).catch(() => {});

    res.status(201).json({ ok: true, order_id: result.id, total });
  } catch (err) {
    console.error("[orders/create]", err);
    res.status(500).json({ error: "Ошибка при создании заказа" });
  }
});

/**
 * GET /api/orders
 * Список заказов (для admin/seller)
 * Query: ?status=&region=&limit=50&offset=0
 */
router.get("/", requireAuth, requireSeller, async (req, res) => {
  try {
    const { status, region, limit = 50, offset = 0 } = req.query;
    const params = [];
    const conditions = [];

    if (status && status !== "all") {
      params.push(status);
      conditions.push(`o.status = $${params.length}`);
    }
    // Продавец видит только свой регион
    if (req.user.role === "seller") {
      params.push(req.user.region);
      conditions.push(`o.region = $${params.length}`);
    } else if (region && region !== "all") {
      params.push(region);
      conditions.push(`o.region = $${params.length}`);
    }

    const where = conditions.length ? "WHERE " + conditions.join(" AND ") : "";
    params.push(parseInt(limit), parseInt(offset));

    const { rows } = await query(`
      SELECT o.*,
        json_agg(json_build_object(
          'id', oi.id, 'product_id', oi.product_id,
          'name', oi.name, 'price', oi.price, 'qty', oi.qty
        ) ORDER BY oi.id) AS items
      FROM orders o
      LEFT JOIN order_items oi ON oi.order_id = o.id
      ${where}
      GROUP BY o.id
      ORDER BY o.created_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}
    `, params);

    // Счётчик без limit/offset
    const countParams = params.slice(0, -2);
    const { rows: cnt } = await query(
      `SELECT COUNT(*) FROM orders o ${where}`, countParams
    );

    res.json({ orders: rows, total: parseInt(cnt[0].count) });
  } catch (err) {
    console.error("[orders/list]", err);
    res.status(500).json({ error: "Ошибка сервера" });
  }
});

/**
 * GET /api/orders/my
 * Заказы текущего покупателя (из Mini App по telegram_id)
 * Header: x-telegram-id: <id>
 */
router.get("/my", async (req, res) => {
  try {
    const telegramId = req.headers["x-telegram-id"];
    if (!telegramId) return res.status(400).json({ error: "Нет telegram_id" });

    const { rows } = await query(`
      SELECT o.*,
        json_agg(json_build_object(
          'name', oi.name, 'price', oi.price, 'qty', oi.qty
        ) ORDER BY oi.id) AS items
      FROM orders o
      LEFT JOIN order_items oi ON oi.order_id = o.id
      WHERE o.customer_id = $1
      GROUP BY o.id
      ORDER BY o.created_at DESC
      LIMIT 20
    `, [telegramId]);

    res.json({ orders: rows });
  } catch (err) {
    console.error("[orders/my]", err);
    res.status(500).json({ error: "Ошибка сервера" });
  }
});

/**
 * GET /api/orders/:id
 * Один заказ
 */
router.get("/:id", requireAuth, async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT o.*,
        json_agg(json_build_object(
          'id', oi.id, 'product_id', oi.product_id,
          'name', oi.name, 'price', oi.price, 'qty', oi.qty
        ) ORDER BY oi.id) AS items
      FROM orders o
      LEFT JOIN order_items oi ON oi.order_id = o.id
      WHERE o.id = $1
      GROUP BY o.id
    `, [req.params.id]);

    if (!rows[0]) return res.status(404).json({ error: "Заказ не найден" });

    // Курьер видит только свои заказы
    if (req.user.role === "courier" && rows[0].courier_id !== req.user.id) {
      return res.status(403).json({ error: "Нет доступа к этому заказу" });
    }

    res.json({ order: rows[0] });
  } catch (err) {
    console.error("[orders/get]", err);
    res.status(500).json({ error: "Ошибка сервера" });
  }
});

/**
 * PATCH /api/orders/:id/status
 * Сменить статус заказа
 * Body: { status } или { action: 'next' | 'cancel' }
 */
router.patch("/:id/status", requireAuth, async (req, res) => {
  try {
    const orderId = parseInt(req.params.id);
    let { status, action, note } = req.body;

    // Получаем текущий заказ
    const { rows } = await query("SELECT * FROM orders WHERE id=$1", [orderId]);
    if (!rows[0]) return res.status(404).json({ error: "Заказ не найден" });
    const order = rows[0];

    // Курьер может только двигать вперёд свои заказы
    if (req.user.role === "courier") {
      if (order.courier_id !== req.user.id) {
        return res.status(403).json({ error: "Это не ваш заказ" });
      }
      if (action !== "next") {
        return res.status(403).json({ error: "Курьер может только двигать статус вперёд" });
      }
    }

    // Определяем новый статус
    if (action === "next") {
      status = NEXT_STATUS[order.status];
      if (!status) {
        return res.status(400).json({ error: "Заказ уже в финальном статусе" });
      }
    } else if (action === "cancel") {
      status = "cancelled";
    }

    const validStatuses = ["accepted","packed","courier","way","delivered","cancelled"];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: "Недопустимый статус" });
    }

    const updateFields = ["status=$1", "updated_at=NOW()"];
    const params = [status];

    if (note !== undefined) {
      params.push(note);
      updateFields.push(`note=$${params.length}`);
    }

    params.push(orderId);
    const { rows: updated } = await query(`
      UPDATE orders SET ${updateFields.join(",")} WHERE id=$${params.length}
      RETURNING *
    `, params);

    // Уведомляем клиента
    if (order.customer_id) {
      notifyCustomerStatus(order.customer_id, updated[0], status).catch(() => {});
    }

    res.json({ ok: true, order: updated[0] });
  } catch (err) {
    console.error("[orders/status]", err);
    res.status(500).json({ error: "Ошибка сервера" });
  }
});

/**
 * PATCH /api/orders/:id/courier
 * Назначить курьера
 * Body: { courier_id }
 */
router.patch("/:id/courier", requireAuth, requireSeller, async (req, res) => {
  try {
    const { courier_id } = req.body;
    const orderId = parseInt(req.params.id);

    const { rows } = await query(`
      UPDATE orders SET courier_id=$1, updated_at=NOW() WHERE id=$2 RETURNING *
    `, [courier_id, orderId]);

    if (!rows[0]) return res.status(404).json({ error: "Заказ не найден" });

    // Уведомляем курьера если он есть
    if (courier_id) {
      const { rows: accRows } = await query(
        "SELECT telegram_id FROM accounts WHERE id=$1", [courier_id]
      );
      if (accRows[0]?.telegram_id) {
        const { rows: itemRows } = await query(
          "SELECT * FROM order_items WHERE order_id=$1", [orderId]
        );
        notifyCourierAssigned(accRows[0].telegram_id, { ...rows[0], items: itemRows }).catch(() => {});
      }
    }

    res.json({ ok: true, order: rows[0] });
  } catch (err) {
    console.error("[orders/courier]", err);
    res.status(500).json({ error: "Ошибка сервера" });
  }
});

/**
 * PATCH /api/orders/:id/note
 * Добавить заметку к заказу
 */
router.patch("/:id/note", requireAuth, requireSeller, async (req, res) => {
  try {
    const { note } = req.body;
    const { rows } = await query(
      "UPDATE orders SET note=$1, updated_at=NOW() WHERE id=$2 RETURNING id,note",
      [note, req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: "Заказ не найден" });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "Ошибка сервера" });
  }
});

/**
 * GET /api/orders/stats/dashboard
 * Сводная статистика для дашборда
 */
router.get("/stats/dashboard", requireAuth, requireSeller, async (req, res) => {
  try {
    const { rows: statusStats } = await query(`
      SELECT status, COUNT(*) as count
      FROM orders GROUP BY status
    `);

    const { rows: todayStats } = await query(`
      SELECT
        COUNT(*) FILTER (WHERE status != 'cancelled') as orders_today,
        COALESCE(SUM(total) FILTER (WHERE status != 'cancelled'), 0) as revenue_today
      FROM orders
      WHERE created_at >= CURRENT_DATE
    `);

    const { rows: weekStats } = await query(`
      SELECT DATE(created_at) as date,
        COUNT(*) FILTER (WHERE status != 'cancelled') as orders,
        COALESCE(SUM(total) FILTER (WHERE status != 'cancelled'), 0) as revenue
      FROM orders
      WHERE created_at >= CURRENT_DATE - INTERVAL '7 days'
      GROUP BY DATE(created_at)
      ORDER BY date DESC
    `);

    const { rows: topProducts } = await query(`
      SELECT p.id, p.name, p.emoji, p.orders_count, p.price
      FROM products p
      ORDER BY p.orders_count DESC
      LIMIT 5
    `);

    res.json({
      status_stats: statusStats,
      today: todayStats[0],
      week: weekStats,
      top_products: topProducts,
    });
  } catch (err) {
    console.error("[orders/stats]", err);
    res.status(500).json({ error: "Ошибка сервера" });
  }
});

module.exports = router;
