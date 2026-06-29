// src/services/telegram.js
const TelegramBot = require("node-telegram-bot-api");
require("dotenv").config();

let bot = null;

function getBot() {
  if (!bot) {
    bot = new TelegramBot(process.env.BOT_TOKEN, { polling: false });
  }
  return bot;
}

/**
 * Уведомление администратору о новом заказе
 */
async function notifyAdminNewOrder(order) {
  if (!process.env.ADMIN_TELEGRAM_ID) return;
  try {
    const items = order.items
      .map((i) => `  • ${i.name} ×${i.qty} — ${formatSum(i.price * i.qty)}`)
      .join("\n");

    const text =
      `🆕 *Новый заказ #${order.id}*\n` +
      `👤 ${order.buyer_name || "—"} · ${order.phone}\n` +
      `📍 ${order.region}: ${order.address}\n` +
      `⏱ ${order.delivery_slot || "—"}\n` +
      `💳 ${payLabel(order.pay_method)}\n\n` +
      `*Состав:*\n${items}\n\n` +
      `💰 Итого: *${formatSum(order.total)}*`;

    await getBot().sendMessage(process.env.ADMIN_TELEGRAM_ID, text, {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [
            { text: "✅ Принять", callback_data: `order_accept_${order.id}` },
            { text: "❌ Отменить", callback_data: `order_cancel_${order.id}` },
          ],
          [{ text: "📋 Все заказы", callback_data: "admin_orders" }],
        ],
      },
    });
  } catch (err) {
    console.error("[TG] Ошибка уведомления об заказе:", err.message);
  }
}

/**
 * Уведомление клиенту о смене статуса заказа
 */
async function notifyCustomerStatus(telegramId, order, newStatus) {
  if (!telegramId) return;
  const STATUS_MESSAGES = {
    packed:    `📦 Заказ #${order.id} собирается — упаковываем рыб в термопакет`,
    courier:   `🏍️ Заказ #${order.id} передан курьеру — скоро выедет`,
    way:       `🚚 Заказ #${order.id} в пути! Курьер едет к вам`,
    delivered: `🎉 Заказ #${order.id} доставлен! Спасибо за покупку в AquaUZ 🐠`,
    cancelled: `❌ Заказ #${order.id} отменён. По вопросам: +998 71 200 01 01`,
  };
  const text = STATUS_MESSAGES[newStatus];
  if (!text) return;
  try {
    await getBot().sendMessage(telegramId, text);
  } catch (err) {
    console.error("[TG] Ошибка уведомления клиенту:", err.message);
  }
}

/**
 * Уведомление курьеру о назначенном заказе
 */
async function notifyCourierAssigned(courierTelegramId, order) {
  if (!courierTelegramId) return;
  try {
    const items = order.items.map((i) => `• ${i.name} ×${i.qty}`).join("\n");
    const text =
      `📦 *Новый заказ для вас #${order.id}*\n\n` +
      `📍 ${order.region}\n${order.address}\n\n` +
      `👤 ${order.buyer_name || "Клиент"} · ${order.phone}\n` +
      `⏱ ${order.delivery_slot || "—"}\n\n` +
      `${items}\n\n💰 ${formatSum(order.total)}`;

    await getBot().sendMessage(courierTelegramId, text, {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [[
          { text: "✅ Принял заказ", callback_data: `courier_accept_${order.id}` },
        ]],
      },
    });
  } catch (err) {
    console.error("[TG] Ошибка уведомления курьеру:", err.message);
  }
}

/**
 * Настроить webhook (вызывается при старте сервера)
 */
async function setupWebhook(webhookUrl) {
  try {
    await getBot().setWebHook(`${webhookUrl}/webhook/telegram`);
    console.log(`[TG] Webhook установлен: ${webhookUrl}/webhook/telegram`);
  } catch (err) {
    console.error("[TG] Ошибка установки webhook:", err.message);
  }
}

/**
 * Обработка входящих webhook-событий от Telegram
 */
async function handleWebhookUpdate(update, db) {
  try {
    // Обработка callback_query (нажатия inline-кнопок)
    if (update.callback_query) {
      const { data, from, id: callbackId } = update.callback_query;
      const b = getBot();
      await b.answerCallbackQuery(callbackId);

      if (data.startsWith("order_accept_")) {
        const orderId = parseInt(data.split("_")[2]);
        await db.query(
          "UPDATE orders SET status='packed', updated_at=NOW() WHERE id=$1",
          [orderId]
        );
        await b.sendMessage(from.id, `✅ Заказ #${orderId} принят и передан на сборку`);
      }

      if (data.startsWith("order_cancel_")) {
        const orderId = parseInt(data.split("_")[2]);
        await db.query(
          "UPDATE orders SET status='cancelled', updated_at=NOW() WHERE id=$1",
          [orderId]
        );
        await b.sendMessage(from.id, `❌ Заказ #${orderId} отменён`);
      }

      if (data === "admin_orders") {
        await b.sendMessage(
          from.id,
          "📋 Для управления заказами используйте Admin-панель в Mini App"
        );
      }

      if (data.startsWith("courier_accept_")) {
        const orderId = parseInt(data.split("_")[2]);
        await db.query(
          "UPDATE orders SET status='way', updated_at=NOW() WHERE id=$1",
          [orderId]
        );
        await b.sendMessage(from.id, `🚚 Статус заказа #${orderId} изменён на «В пути»`);
      }
    }

    // /start команда
    if (update.message?.text === "/start") {
      const { from } = update.message;
      const name = from.first_name || "друг";
      await getBot().sendMessage(
        from.id,
        `🐠 Привет, ${name}!\n\nДобро пожаловать в AquaUZ — магазин аквариумных рыб в Узбекистане.\n\nОткройте магазин прямо в Telegram 👇`,
        {
          reply_markup: {
            inline_keyboard: [[
              { text: "🐠 Открыть магазин", web_app: { url: process.env.FRONTEND_URL } },
            ]],
          },
        }
      );
    }
  } catch (err) {
    console.error("[TG] Ошибка обработки webhook:", err.message);
  }
}

// Утилиты
function formatSum(n) {
  return n?.toLocaleString("ru-RU") + " сум";
}
function payLabel(method) {
  return { cash: "💵 Наличные", click: "🟦 Click", payme: "🟩 Payme" }[method] || method;
}

module.exports = {
  getBot,
  notifyAdminNewOrder,
  notifyCustomerStatus,
  notifyCourierAssigned,
  setupWebhook,
  handleWebhookUpdate,
};
