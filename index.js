const { Telegraf } = require("telegraf");
const { Pool } = require("pg");

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) { console.error("TELEGRAM_BOT_TOKEN not set"); process.exit(1); }

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes("render.com") ? { rejectUnauthorized: false } : false,
});

const ADMIN_USERNAME = process.env.ADMIN_USERNAME || "Mojeao";

// ─── DB ───────────────────────────────────────────────────────────────────────
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bot_users (
      id SERIAL PRIMARY KEY,
      telegram_id BIGINT UNIQUE NOT NULL,
      first_name TEXT NOT NULL,
      username TEXT,
      last_name TEXT,
      coins INTEGER DEFAULT 0,
      is_banned BOOLEAN DEFAULT FALSE,
      referrer_telegram_id BIGINT,
      joined_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS config_pool (
      id SERIAL PRIMARY KEY,
      config_link TEXT NOT NULL,
      package_size_mb INTEGER NOT NULL,
      cost_coins INTEGER NOT NULL,
      is_used BOOLEAN DEFAULT FALSE,
      added_by TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS user_configs (
      id SERIAL PRIMARY KEY,
      telegram_id BIGINT NOT NULL,
      config_link TEXT NOT NULL,
      package_size_mb INTEGER NOT NULL,
      coins_spent INTEGER NOT NULL,
      received_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS bot_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
}

async function getUser(tid) {
  const r = await pool.query("SELECT * FROM bot_users WHERE telegram_id=$1 LIMIT 1", [tid]);
  return r.rows[0] || null;
}
async function getOrCreateUser(tid, firstName, username, lastName, referrerId) {
  const ex = await getUser(tid);
  if (ex) return ex;
  const coinPerRef = parseInt((await getSetting("coin_per_referral")) || "1", 10);
  const r = await pool.query(
    "INSERT INTO bot_users(telegram_id,first_name,username,last_name,coins,is_banned,referrer_telegram_id) VALUES($1,$2,$3,$4,0,false,$5) RETURNING *",
    [tid, firstName, username || null, lastName || null, referrerId || null]
  );
  if (referrerId && referrerId !== tid) {
    await pool.query("UPDATE bot_users SET coins=coins+$1 WHERE telegram_id=$2", [coinPerRef, referrerId]);
  }
  return r.rows[0];
}
async function getReferralCount(tid) {
  const r = await pool.query("SELECT COUNT(*) FROM bot_users WHERE referrer_telegram_id=$1", [tid]);
  return parseInt(r.rows[0].count, 10);
}
async function getUserConfigs(tid) {
  const r = await pool.query("SELECT * FROM user_configs WHERE telegram_id=$1 ORDER BY received_at ASC", [tid]);
  return r.rows;
}
async function getUserConfigCount(tid) {
  const r = await pool.query("SELECT COUNT(*) FROM user_configs WHERE telegram_id=$1", [tid]);
  return parseInt(r.rows[0].count, 10);
}
async function getAvailableConfig(sizeMb, cost) {
  const r = await pool.query("SELECT * FROM config_pool WHERE is_used=false AND package_size_mb=$1 AND cost_coins=$2 LIMIT 1", [sizeMb, cost]);
  return r.rows[0] || null;
}
async function giveConfig(tid, configId, configLink, sizeMb, cost) {
  await pool.query("UPDATE config_pool SET is_used=true WHERE id=$1", [configId]);
  await pool.query("UPDATE bot_users SET coins=coins-$1 WHERE telegram_id=$2", [cost, tid]);
  await pool.query("INSERT INTO user_configs(telegram_id,config_link,package_size_mb,coins_spent) VALUES($1,$2,$3,$4)", [tid, configLink, sizeMb, cost]);
}
async function countAvailableConfigs(sizeMb) {
  const r = await pool.query("SELECT COUNT(*) FROM config_pool WHERE is_used=false AND package_size_mb=$1", [sizeMb]);
  return parseInt(r.rows[0].count, 10);
}
async function addConfigToPool(configLink, sizeMb, costCoins, addedBy) {
  const r = await pool.query("INSERT INTO config_pool(config_link,package_size_mb,cost_coins,is_used,added_by) VALUES($1,$2,$3,false,$4) RETURNING *", [configLink, sizeMb, costCoins, addedBy]);
  return r.rows[0];
}
async function getSetting(key) {
  const r = await pool.query("SELECT value FROM bot_settings WHERE key=$1 LIMIT 1", [key]);
  return r.rows[0]?.value || null;
}
async function setSetting(key, value) {
  await pool.query("INSERT INTO bot_settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=$2", [key, value]);
}
async function getTotalStats() {
  const [u, c, p] = await Promise.all([
    pool.query("SELECT COUNT(*) FROM bot_users"),
    pool.query("SELECT COUNT(*) FROM user_configs"),
    pool.query("SELECT COUNT(*) FROM config_pool WHERE is_used=false"),
  ]);
  return { users: parseInt(u.rows[0].count,10), configs: parseInt(c.rows[0].count,10), pool: parseInt(p.rows[0].count,10) };
}

// ─── Settings ────────────────────────────────────────────────────────────────
const DEFAULTS = {
  welcomeText: "⭐ سلام {name} عزیز!\n\nبه پلتفرم اینترنت بدون محدودیت خوش آمدی.\n\nبا دعوت دوستانت 🎁 کانفیگ رایگان دریافت کن!\n\nاز منوی زیر شروع کن:\n👇",
  welcomeTextRef: "🎉 سلام {name} عزیز!\n\nاز لینک دعوت وارد شدی.\n🪙 یک سکه به حساب دوستت اضافه شد!\n\nاز منوی زیر اقدام کن:\n👇",
  coinPerReferral: 1,
  maintenanceMode: false,
  mandatoryChannels: [{ id: "@lnterFreedom", link: "https://t.me/lnterFreedom", name: "lnterFreedom" }],
  buttons: { getConfig: "📦 دریافت کانفیگ", myConfigs: "📋 کانفیگ‌های من", account: "👤 حساب کاربری من", referrals: "👥 زیرمجموعه‌ها" },
  pkg1000Label: "بسته ۱۰۰۰ مگابایت — ۵ سکه", pkg1000Cost: 5,
  pkg2000Label: "بسته ۲۰۰۰ مگابایت — ۱۰ سکه", pkg2000Cost: 10,
  pkg5000Label: "بسته ۵۰۰۰ مگابایت — ۲۰ سکه", pkg5000Cost: 20,
};

async function getSettings() {
  const r = await pool.query("SELECT key, value FROM bot_settings");
  const raw = Object.fromEntries(r.rows.map(row => [row.key, row.value]));
  return {
    welcomeText: raw["welcome_text"] || DEFAULTS.welcomeText,
    welcomeTextRef: raw["welcome_text_ref"] || DEFAULTS.welcomeTextRef,
    coinPerReferral: parseInt(raw["coin_per_referral"] || "1", 10),
    maintenanceMode: raw["maintenance_mode"] === "true",
    mandatoryChannels: raw["mandatory_channels"] ? JSON.parse(raw["mandatory_channels"]) : DEFAULTS.mandatoryChannels,
    buttons: {
      getConfig: raw["btn_getconfig"] || DEFAULTS.buttons.getConfig,
      myConfigs: raw["btn_myconfigs"] || DEFAULTS.buttons.myConfigs,
      account: raw["btn_account"] || DEFAULTS.buttons.account,
      referrals: raw["btn_referrals"] || DEFAULTS.buttons.referrals,
    },
    pkg1000Label: raw["pkg1000_label"] || DEFAULTS.pkg1000Label, pkg1000Cost: parseInt(raw["pkg1000_cost"] || "5", 10),
    pkg2000Label: raw["pkg2000_label"] || DEFAULTS.pkg2000Label, pkg2000Cost: parseInt(raw["pkg2000_cost"] || "10", 10),
    pkg5000Label: raw["pkg5000_label"] || DEFAULTS.pkg5000Label, pkg5000Cost: parseInt(raw["pkg5000_cost"] || "20", 10),
  };
}

function h(s) { return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }

function mainMenu(s) {
  return { keyboard: [[{ text: s.buttons.getConfig }],[{ text: s.buttons.myConfigs }, { text: s.buttons.account }],[{ text: s.buttons.referrals }]], resize_keyboard: true, persistent: true };
}

const pendingReferrals = new Map();
const adminStates = new Map();

// ─── BOT ─────────────────────────────────────────────────────────────────────
const bot = new Telegraf(token);

function isAdmin(ctx) { return ctx.from?.username === ADMIN_USERNAME; }

async function checkMembership(bot, userId, channels) {
  for (const ch of channels) {
    try {
      const m = await bot.telegram.getChatMember(ch.id, userId);
      if (!["member","administrator","creator"].includes(m.status)) return false;
    } catch { return false; }
  }
  return true;
}

async function sendJoinMsg(ctx, channels) {
  await ctx.replyWithHTML(
    `⭐ <b>برای استفاده از ربات باید در کانال‌های زیر عضو باشید:</b>\n\n${channels.map(c=>`📣 <b><a href="${c.link}">@${c.name}</a></b>`).join("\n")}\n\nپس از عضویت، دکمه ✅ <b>تایید عضویت</b> را بزنید.`,
    { reply_markup: { inline_keyboard: [...channels.map(c=>[{ text: `عضویت در ${c.name}`, url: c.link }]), [{ text: "✅ تایید عضویت", callback_data: "verify_join" }]] } }
  );
}

async function completeWelcome(ctx, isNew) {
  const s = await getSettings();
  let referrerId;
  if (isNew) {
    const p = pendingReferrals.get(ctx.from.id);
    if (p && p.expiry > Date.now()) { referrerId = p.referrerId; pendingReferrals.delete(ctx.from.id); }
  }
  await getOrCreateUser(ctx.from.id, ctx.from.first_name, ctx.from.username, ctx.from.last_name, isNew ? referrerId : undefined);
  if (isNew && referrerId) {
    try { await ctx.telegram.sendMessage(referrerId, `🎉 <b>مژده!</b>\nکاربر <b>${h(ctx.from.first_name)}</b> از لینک دعوت شما وارد شد.\n🪙 <b>${s.coinPerReferral} سکه</b> به حسابتان اضافه شد!`, { parse_mode: "HTML" }); } catch {}
  }
  const name = h(ctx.from.first_name);
  const txt = (isNew && referrerId ? s.welcomeTextRef : s.welcomeText).replace("{name}", name);
  await ctx.replyWithHTML(txt, { reply_markup: mainMenu(s) });
}

bot.start(async (ctx) => {
  try {
    if (ctx.chat?.type !== "private") {
      const me = await ctx.telegram.getMe();
      await ctx.reply("لطفاً در پیام خصوصی با ربات صحبت کنید.", { reply_markup: { inline_keyboard: [[{ text: "شروع در پیوی 💬", url: `https://t.me/${me.username}` }]] } });
      return;
    }
    const s = await getSettings();
    if (s.maintenanceMode && !isAdmin(ctx)) { await ctx.reply("🔧 ربات در حال تعمیر است. لطفاً کمی بعد تلاش کنید."); return; }
    const param = ctx.startPayload;
    if (param?.startsWith("ref_")) {
      const id = parseInt(param.replace("ref_",""),10);
      if (!isNaN(id) && id !== ctx.from.id) {
        const ex = await getUser(ctx.from.id);
        if (!ex) pendingReferrals.set(ctx.from.id, { referrerId: id, expiry: Date.now()+3600000 });
      }
    }
    const isMember = await checkMembership(bot, ctx.from.id, s.mandatoryChannels);
    if (!isMember) { await sendJoinMsg(ctx, s.mandatoryChannels); return; }
    const ex = await getUser(ctx.from.id);
    await completeWelcome(ctx, ex === null);
  } catch(err) { console.error("Error in /start", err); }
});

bot.action("verify_join", async (ctx) => {
  try {
    const s = await getSettings();
    const isMember = await checkMembership(bot, ctx.from.id, s.mandatoryChannels);
    if (!isMember) { await ctx.answerCbQuery("هنوز عضو کانال نشدی! اول عضو شو.", { show_alert: true }); return; }
    await ctx.answerCbQuery("عضویت تأیید شد!");
    await ctx.deleteMessage().catch(()=>{});
    const ex = await getUser(ctx.from.id);
    await completeWelcome(ctx, ex === null);
  } catch(err) { console.error("Error in verify_join", err); }
});

bot.command("admin", async (ctx) => {
  if (!isAdmin(ctx)) { await ctx.reply("دسترسی غیرمجاز"); return; }
  await sendAdminPanel(ctx);
});

async function sendAdminPanel(ctx) {
  const stats = await getTotalStats();
  await ctx.replyWithHTML(
    `🔧 <b>پنل ادمین</b>\n\n👥 کاربران: <b>${stats.users}</b>\n📦 کانفیگ توزیع‌شده: <b>${stats.configs}</b>\n🗃 موجود در پول: <b>${stats.pool}</b>`,
    { reply_markup: { keyboard: [["➕ افزودن کانفیگ","📊 آمار"],["🔧 تعمیر ON/OFF","🔙 بازگشت به منوی اصلی"]], resize_keyboard: true } }
  );
  adminStates.set(ctx.from.id, "admin_menu");
}

bot.on("text", async (ctx) => {
  try {
    if (ctx.chat?.type !== "private") return;
    const text = ctx.message.text;
    const userId = ctx.from.id;
    const s = await getSettings();

    // Admin flow
    if (isAdmin(ctx)) {
      const state = adminStates.get(userId);
      if (text === "🔙 بازگشت به منوی اصلی") { adminStates.delete(userId); await ctx.replyWithHTML("منوی اصلی", { reply_markup: mainMenu(s) }); return; }
      if (text === "📊 آمار") { await sendAdminPanel(ctx); return; }
      if (text === "🔧 تعمیر ON/OFF") {
        const cur = s.maintenanceMode;
        await setSetting("maintenance_mode", cur ? "false" : "true");
        await ctx.reply(cur ? "✅ حالت تعمیر غیرفعال شد." : "🔧 حالت تعمیر فعال شد.");
        return;
      }
      if (text === "➕ افزودن کانفیگ") { adminStates.set(userId, "adding_config"); await ctx.reply("لینک کانفیگ را ارسال کنید:\nفرمت: link|size_mb|cost_coins\nمثال: vless://xxx|1000|5"); return; }
      if (state === "adding_config") {
        const parts = text.split("|");
        if (parts.length !== 3) { await ctx.reply("فرمت اشتباه! مثال: vless://xxx|1000|5"); return; }
        const [link, sizeMb, costCoins] = parts;
        await addConfigToPool(link.trim(), parseInt(sizeMb.trim(),10), parseInt(costCoins.trim(),10), ctx.from.username || "admin");
        adminStates.delete(userId);
        await ctx.reply("✅ کانفیگ اضافه شد.");
        return;
      }
    }

    if (s.maintenanceMode && !isAdmin(ctx)) { await ctx.reply("🔧 ربات در حال تعمیر است. لطفاً کمی بعد تلاش کنید."); return; }
    const isMember = await checkMembership(bot, userId, s.mandatoryChannels);
    if (!isMember) { await sendJoinMsg(ctx, s.mandatoryChannels); return; }
    const user = await getUser(userId);
    if (!user) { await ctx.reply("برای شروع /start را بزنید."); return; }
    if (user.is_banned) { await ctx.reply("حساب شما مسدود شده است."); return; }

    if (text === s.buttons.getConfig) {
      const [p1, p2, p5] = await Promise.all([countAvailableConfigs(1000), countAvailableConfigs(2000), countAvailableConfigs(5000)]);
      await ctx.replyWithHTML(
        `📦 <b>دریافت کانفیگ</b>\n\n🪙 سکه فعلی شما: <b>${user.coins} سکه</b>\n\n✅ سبز = موجود  ❌ قرمز = ناموجود\n\nپکیج مورد نظر را انتخاب کنید:`,
        { reply_markup: { inline_keyboard: [
          [{ text: s.pkg1000Label + (p1>0?" ✅":" ❌"), callback_data:"pkg_1000" }],
          [{ text: s.pkg2000Label + (p2>0?" ✅":" ❌"), callback_data:"pkg_2000" }],
          [{ text: s.pkg5000Label + (p5>0?" ✅":" ❌"), callback_data:"pkg_5000" }],
        ]}}
      );
      return;
    }

    if (text === s.buttons.myConfigs) {
      const configs = await getUserConfigs(userId);
      if (configs.length === 0) { await ctx.replyWithHTML(`📋 هنوز هیچ کانفیگی دریافت نکرده‌اید.\n\nاز «${s.buttons.getConfig}» اقدام کنید.`, { reply_markup: mainMenu(s) }); return; }
      const latest = configs[configs.length-1];
      const d = new Date(latest.received_at);
      const dd = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
      const tt = `${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}`;
      await ctx.replyWithHTML(`📋 <b>آخرین کانفیگ شما</b>\n\n📦 حجم: <b>${latest.package_size_mb} مگابایت</b>\n🗓 تاریخ: <b>${dd} — ${tt}</b>\n\n🌐 لینک اتصال:\n<code>${h(latest.config_link)}</code>\n\n━━━━━━━━━━━━━━━━━\n👇 مجموع دریافتی: <b>${configs.length} عدد</b>`, { reply_markup: { inline_keyboard: [[{ text:"بازگشت به منو", callback_data:"back_menu" }]] } });
      return;
    }

    if (text === s.buttons.account) {
      const [refCount, cfgCount] = await Promise.all([getReferralCount(userId), getUserConfigCount(userId)]);
      await ctx.replyWithHTML(`👤 <b>حساب کاربری شما</b>\n\n━━━━━━━━━━━━━━━━━\n🪪 نام: <b>${h(user.first_name)}</b>\n🆔 آیدی: <b>${user.telegram_id}</b>\n━━━━━━━━━━━━━━━━━\n🪙 موجودی: <b>${user.coins} سکه</b>\n👥 دعوت‌شدگان: <b>${refCount} نفر</b>\n📦 کانفیگ دریافتی: <b>${cfgCount} عدد</b>\n━━━━━━━━━━━━━━━━━`, { reply_markup: mainMenu(s) });
      return;
    }

    if (text === s.buttons.referrals) {
      const [me, refCount] = await Promise.all([ctx.telegram.getMe(), getReferralCount(userId)]);
      const refLink = `https://t.me/${me.username}?start=ref_${userId}`;
      await ctx.replyWithHTML(`👥 <b>سیستم دعوت و کسب سکه</b>\n\n🎁 به ازای هر دوست، <b>${s.coinPerReferral} سکه</b> دریافت می‌کنید.\n\n🪙 دعوت‌های شما: <b>${refCount} نفر</b>\n\n━━━━━━━━━━━━━━━━━\n👇 لینک اختصاصی:\n<code>${h(refLink)}</code>\n━━━━━━━━━━━━━━━━━`, { reply_markup: mainMenu(s) });
      return;
    }

    await ctx.replyWithHTML("از منوی زیر انتخاب کنید:", { reply_markup: mainMenu(s) });
  } catch(err) { console.error("Error in text", err); }
});

for (const pkg of [{cb:"pkg_1000",size:1000,key:"pkg1000Cost"},{cb:"pkg_2000",size:2000,key:"pkg2000Cost"},{cb:"pkg_5000",size:5000,key:"pkg5000Cost"}]) {
  bot.action(pkg.cb, async (ctx) => {
    try {
      const s = await getSettings();
      const cost = s[pkg.key];
      const user = await getUser(ctx.from.id);
      if (!user) { await ctx.answerCbQuery("لطفاً ابتدا /start را بزنید.", { show_alert:true }); return; }
      if (user.is_banned) { await ctx.answerCbQuery("حساب شما مسدود شده است.", { show_alert:true }); return; }
      if (user.coins < cost) { await ctx.answerCbQuery(`موجودی ناکافی! ${user.coins} سکه دارید ولی ${cost} سکه نیاز است.`, { show_alert:true }); return; }
      const avail = await getAvailableConfig(pkg.size, cost);
      if (!avail) { await ctx.answerCbQuery(`موجودی پکیج ${pkg.size} مگابایتی تمام شده.`, { show_alert:true }); return; }
      await giveConfig(ctx.from.id, avail.id, avail.config_link, pkg.size, cost);
      await ctx.answerCbQuery("کانفیگ با موفقیت دریافت شد!");
      const updated = await getUser(ctx.from.id);
      await ctx.replyWithHTML(`✅ <b>دریافت موفق!</b>\n\n📦 حجم: <b>${pkg.size} مگابایت</b>\n🪙 سکه کسر شده: <b>${cost} سکه</b>\n🪙 موجودی باقی‌مانده: <b>${updated?.coins ?? 0} سکه</b>\n\n🌐 کانفیگ اختصاصی:\n<code>${h(avail.config_link)}</code>`);
    } catch(err) { console.error("Error giving config", err); }
  });
}

bot.action("back_menu", async (ctx) => {
  try { const s = await getSettings(); await ctx.answerCbQuery(); await ctx.replyWithHTML("منوی اصلی", { reply_markup: mainMenu(s) }); } catch {}
});

initDB().then(async () => {
  const port = process.env.PORT || 3000;
  const serviceUrl = process.env.RENDER_EXTERNAL_URL;

  if (serviceUrl) {
    // Webhook mode on Render
    const webhookPath = "/webhook/" + token.replace(":", "_");
    await bot.telegram.setWebhook(serviceUrl + webhookPath);
    const express = require("express");
    const app = express();
    app.use(express.json());
    app.use(bot.webhookCallback(webhookPath));
    app.get("/", (req, res) => res.send("Bot is running ✅"));
    app.listen(port, () => {
      console.log("Webhook server running on port " + port);
      console.log("Webhook URL: " + serviceUrl + webhookPath);
    });
  } else {
    // Polling mode (local dev)
    bot.launch();
    console.log("Bot started in polling mode");
  }
}).catch(err => { console.error("Failed to start:", err); process.exit(1); });

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
