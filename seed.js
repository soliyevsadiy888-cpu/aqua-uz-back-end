// scripts/seed.js
// Запуск: node scripts/seed.js
require("dotenv").config();
const bcrypt = require("bcryptjs");
const { query, pool } = require("../src/db");

async function seed() {
  console.log("🌱 AquaUZ — заполнение начальных данных...");

  // ── Тарифы доставки ─────────────────────────────────────────
  const rates = [
    { region: "Ташкент",     price: 25000,  time_label: "2–4 часа",          courier_name: "Азиз Р.",    courier_phone: "+998 90 123 45 67", rating: 4.9, trips: 312 },
    { region: "Самарканд",   price: 80000,  time_label: "1–2 дня",            courier_name: "Бобур Х.",   courier_phone: "+998 91 234 56 78", rating: 4.8, trips: 201 },
    { region: "Бухара",      price: 95000,  time_label: "1–2 дня",            courier_name: "Санжар К.",  courier_phone: "+998 93 345 67 89", rating: 4.7, trips: 178 },
    { region: "Андижан",     price: 85000,  time_label: "1–2 дня",            courier_name: "Фарид М.",   courier_phone: "+998 94 456 78 90", rating: 4.8, trips: 143 },
    { region: "Фергана",     price: 85000,  time_label: "1–2 дня",            courier_name: "Улугбек Н.", courier_phone: "+998 90 567 89 01", rating: 5.0, trips: 89  },
    { region: "Наманган",    price: 85000,  time_label: "1–2 дня",            courier_name: "Жасур А.",   courier_phone: "+998 91 678 90 12", rating: 4.9, trips: 112 },
    { region: "Нукус",       price: 150000, time_label: "2–3 дня",            courier_name: "Рустам О.",  courier_phone: "+998 93 789 01 23", rating: 4.6, trips: 67  },
    { region: "Навои",       price: 100000, time_label: "1–2 дня",            courier_name: "Дилшод Т.",  courier_phone: "+998 94 890 12 34", rating: 4.9, trips: 95  },
    { region: "Джизак",      price: 70000,  time_label: "сегодня–завтра",     courier_name: "Камол Ю.",   courier_phone: "+998 90 901 23 45", rating: 4.8, trips: 134 },
    { region: "Сурхандарья", price: 130000, time_label: "2–3 дня",            courier_name: "Акбар С.",   courier_phone: "+998 91 012 34 56", rating: 4.7, trips: 78  },
    { region: "Сырдарья",    price: 65000,  time_label: "сегодня–завтра",     courier_name: "Нодир Б.",   courier_phone: "+998 93 123 45 67", rating: 4.9, trips: 156 },
    { region: "Кашкадарья",  price: 110000, time_label: "2–3 дня",            courier_name: "Шухрат Р.",  courier_phone: "+998 94 234 56 78", rating: 4.8, trips: 102 },
  ];
  for (const r of rates) {
    await query(`
      INSERT INTO delivery_rates (region, price, time_label, courier_name, courier_phone, rating, trips)
      VALUES ($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT (region) DO UPDATE SET
        price=EXCLUDED.price, time_label=EXCLUDED.time_label,
        courier_name=EXCLUDED.courier_name, courier_phone=EXCLUDED.courier_phone,
        rating=EXCLUDED.rating, trips=EXCLUDED.trips
    `, [r.region, r.price, r.time_label, r.courier_name, r.courier_phone, r.rating, r.trips]);
  }
  console.log("✅ Тарифы доставки загружены");

  // ── Товары ──────────────────────────────────────────────────
  const products = [
    { id: "guppy",       name: "Гуппи «Огненный хвост»",  emoji: "🐠", category: "fish",      price: 25000,  min_price: 15000, stock: 8,  active: true,  orders_count: 47  },
    { id: "neon",        name: "Неон «Голубая искра»",     emoji: "🐟", category: "fish",      price: 8000,   min_price: 5000,  stock: 2,  active: true,  orders_count: 112 },
    { id: "betta",       name: "Петушок «Королевский»",    emoji: "👑", category: "fish",      price: 45000,  min_price: 30000, stock: 5,  active: true,  orders_count: 31  },
    { id: "discus",      name: "Дискус «Королевский»",     emoji: "👑", category: "fish",      price: 180000, min_price: 150000,stock: 1,  active: true,  orders_count: 8   },
    { id: "danio",       name: "Данио «Зебра»",            emoji: "🐟", category: "fish",      price: 7000,   min_price: 4000,  stock: 24, active: true,  orders_count: 64  },
    { id: "angelfish",   name: "Скалярия «Серебряный»",    emoji: "🦈", category: "fish",      price: 55000,  min_price: 40000, stock: 3,  active: true,  orders_count: 22  },
    { id: "ancistrus",   name: "Анциструс «Чистильщик»",   emoji: "🐡", category: "fish",      price: 20000,  min_price: 12000, stock: 6,  active: true,  orders_count: 19  },
    { id: "molly",       name: "Молли «Чёрный бархат»",    emoji: "🐟", category: "fish",      price: 18000,  min_price: 12000, stock: 0,  active: false, orders_count: 27  },
    { id: "goldfish",    name: "Золотая рыбка «Комета»",   emoji: "🐠", category: "fish",      price: 22000,  min_price: 15000, stock: 10, active: true,  orders_count: 41  },
    { id: "clownloach",  name: "Боция «Клоун»",            emoji: "🐡", category: "fish",      price: 38000,  min_price: 28000, stock: 4,  active: true,  orders_count: 14  },
    { id: "parrotcichlid",name:"Цихлида «Попугай»",        emoji: "👑", category: "fish",      price: 65000,  min_price: 50000, stock: 3,  active: true,  orders_count: 17  },
    { id: "filter-ext",  name: "Фильтр «Поток-300 Pro»",   emoji: "⚙️", category: "equipment", price: 220000, min_price: 180000,stock: 4,  active: true,  orders_count: 12  },
    { id: "food-flakes", name: "Корм хлопья «Универсал»",  emoji: "🍽️", category: "food",      price: 18000,  min_price: 12000, stock: 20, active: true,  orders_count: 67  },
    { id: "plant-anub",  name: "Анубиас Нана",              emoji: "🌿", category: "plant",     price: 22000,  min_price: 15000, stock: 7,  active: true,  orders_count: 26  },
  ];
  for (const p of products) {
    await query(`
      INSERT INTO products (id, name, emoji, category, price, min_price, stock, active, orders_count)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      ON CONFLICT (id) DO UPDATE SET
        name=EXCLUDED.name, price=EXCLUDED.price, min_price=EXCLUDED.min_price,
        stock=EXCLUDED.stock, active=EXCLUDED.active
    `, [p.id, p.name, p.emoji, p.category, p.price, p.min_price, p.stock, p.active, p.orders_count]);
  }
  console.log("✅ Товары загружены");

  // ── Промокоды ───────────────────────────────────────────────
  const promos = [
    { code: "AQUA10",   discount: 10, uses: 24, max_uses: 100, active: true,  expires_at: "2025-07-31" },
    { code: "FISH20",   discount: 20, uses: 8,  max_uses: 50,  active: true,  expires_at: "2025-07-15" },
    { code: "NEWFISH",  discount: 15, uses: 41, max_uses: 200, active: true,  expires_at: "2025-12-31" },
    { code: "SUMMER30", discount: 30, uses: 3,  max_uses: 30,  active: false, expires_at: "2025-06-30" },
  ];
  for (const p of promos) {
    await query(`
      INSERT INTO promos (code, discount, uses, max_uses, active, expires_at)
      VALUES ($1,$2,$3,$4,$5,$6)
      ON CONFLICT (code) DO NOTHING
    `, [p.code, p.discount, p.uses, p.max_uses, p.active, p.expires_at]);
  }
  console.log("✅ Промокоды загружены");

  // ── Аккаунты ────────────────────────────────────────────────
  const accounts = [
    // Курьеры
    { id: "c_aziz",    role: "courier", name: "Азиз Р.",    phone: "+998 90 100 11 22", region: "Ташкент",   login: "aziz_courier",   password: "AZ1234", active: true  },
    { id: "c_bobur",   role: "courier", name: "Бобур Х.",   phone: "+998 91 200 22 33", region: "Самарканд", login: "bobur_samark",   password: "BB5678", active: true  },
    { id: "c_farid",   role: "courier", name: "Фарид М.",   phone: "+998 93 300 33 44", region: "Андижан",   login: "farid_andijan",  password: "FR9012", active: true  },
    { id: "c_sanjar",  role: "courier", name: "Санжар К.",  phone: "+998 94 400 44 55", region: "Бухара",    login: "sanjar_buxoro",  password: "SJ3456", active: false },
    { id: "c_jasur",   role: "courier", name: "Жасур Н.",   phone: "+998 90 500 55 66", region: "Наманган",  login: "jasur_namangan", password: "JN7890", active: true  },
    // Продавцы
    { id: "s_ali",     role: "seller",  name: "Али Маркет", phone: "+998 71 100 10 10", region: "Ташкент",   login: "ali_aqua",       password: "AL1122", active: true  },
    { id: "s_mira",    role: "seller",  name: "Мира Fish",  phone: "+998 90 200 20 20", region: "Самарканд", login: "mira_fish",      password: "MF3344", active: true  },
    { id: "s_tech",    role: "seller",  name: "AquaTech",   phone: "+998 93 300 30 30", region: "Ташкент",   login: "aquatech_uz",    password: "AT5566", active: false },
    // Администратор
    { id: "admin_1",   role: "admin",   name: "Администратор", phone: "+998 71 200 01 01", region: "Ташкент", login: "admin",          password: "ADMIN_CHANGE_ME", active: true },
  ];
  for (const a of accounts) {
    const hash = await bcrypt.hash(a.password, 10);
    await query(`
      INSERT INTO accounts (id, role, name, phone, region, login, password_hash, active)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      ON CONFLICT (id) DO NOTHING
    `, [a.id, a.role, a.name, a.phone, a.region, a.login, hash, a.active]);
  }
  console.log("✅ Аккаунты загружены");

  // ── Настройки по умолчанию ──────────────────────────────────
  const defaults = {
    store_open: "true",
    sms_notify: "true",
    ai_doctor: "true",
    courier_signup: "false",
    auto_assign_courier: "true",
    cash_payment: "true",
    click_payment: "true",
    payme_payment: "true",
    guarantee_hours: "48",
    support_phone: "+998 71 200 01 01",
    support_hours: "08:00 – 22:00",
  };
  for (const [key, value] of Object.entries(defaults)) {
    await query(`
      INSERT INTO settings (key, value) VALUES ($1,$2)
      ON CONFLICT (key) DO NOTHING
    `, [key, value]);
  }
  console.log("✅ Настройки загружены");

  console.log("\n🎉 Seed завершён! База данных готова к работе.");
  await pool.end();
}

seed().catch((err) => {
  console.error("❌ Ошибка seed:", err);
  process.exit(1);
});
