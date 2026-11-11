// Database helpers (Cloudflare D1) and bot settings.

export const DEFAULTS = {
  welcome_message: "Welcome! Please choose a service from the menu below.",
  no_services_message: "No services are available yet. Please check back soon.",
  unlock_button_text: "🔓 Unlock It",
  processing_message: "⏳ Your request has been received and is being processed.\nTap the button below to unlock the result.",
  monthly_price: "9900", // in paise (₹99)
  lifetime_price: "299900", // in paise (₹2,999)
  monthly_days: "30",
  upi_id: "",
  upi_name: "",
  upi_instructions: "Pay the exact amount using the QR code or the UPI ID, then tap “Payment Done”.",
  crypto_instructions: "",
  preset_enabled: "1",
  preset_max_ticks: "20",
};

export async function getSettings(env) {
  const { results } = await env.DB.prepare("SELECT setting_key, setting_value FROM bot_settings").all();
  const out = { ...DEFAULTS };
  for (const r of results || []) out[r.setting_key] = r.setting_value;
  return out;
}

export async function setSetting(env, key, value) {
  await env.DB.prepare(
    "INSERT INTO bot_settings (setting_key, setting_value) VALUES (?, ?) " +
      "ON CONFLICT(setting_key) DO UPDATE SET setting_value = excluded.setting_value"
  ).bind(key, String(value)).run();
}

export function formatMoney(minor) {
  const n = Number(minor) / 100;
  return "₹" + n.toLocaleString("en-IN", { minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: 2 });
}

export function getPlans(settings) {
  return {
    monthly: { key: "monthly", name: "Monthly", amount: parseInt(settings.monthly_price, 10), days: parseInt(settings.monthly_days, 10) || 30 },
    lifetime: { key: "lifetime", name: "Lifetime", amount: parseInt(settings.lifetime_price, 10), days: null },
  };
}

// ---- admins ---------------------------------------------------------------
export async function isAdmin(env, userId) {
  const id = String(userId);
  const row = await env.DB.prepare("SELECT is_active FROM admins WHERE telegram_user_id = ?").bind(id).first();
  if (row && row.is_active === 1) return true;
  // The owner (set in OWNER_ID) is always an admin and is created automatically.
  if (env.OWNER_ID && String(env.OWNER_ID).trim() === id) {
    await env.DB.prepare(
      "INSERT INTO admins (telegram_user_id, is_active) VALUES (?, 1) " +
        "ON CONFLICT(telegram_user_id) DO UPDATE SET is_active = 1"
    ).bind(id).run();
    return true;
  }
  return false;
}

export async function getActiveAdmins(env) {
  const { results } = await env.DB.prepare("SELECT telegram_user_id FROM admins WHERE is_active = 1").all();
  const ids = new Set((results || []).map((r) => r.telegram_user_id));
  if (env.OWNER_ID) ids.add(String(env.OWNER_ID).trim());
  return [...ids];
}

// ---- users ----------------------------------------------------------------
export async function upsertUser(env, from, chatId) {
  await env.DB.prepare(
    "INSERT INTO users (telegram_user_id, chat_id, username, first_name) VALUES (?, ?, ?, ?) " +
      "ON CONFLICT(telegram_user_id) DO UPDATE SET chat_id = excluded.chat_id, username = excluded.username, " +
      "first_name = excluded.first_name, is_blocked = 0, last_seen = CURRENT_TIMESTAMP"
  ).bind(String(from.id), String(chatId), from.username ?? null, from.first_name ?? null).run();
}

export async function getUser(env, userId) {
  return env.DB.prepare("SELECT * FROM users WHERE telegram_user_id = ?").bind(String(userId)).first();
}

// ---- sessions -------------------------------------------------------------
export async function getSession(env, userId) {
  return env.DB.prepare("SELECT * FROM user_sessions WHERE telegram_user_id = ?").bind(String(userId)).first();
}

export async function saveSession(env, userId, state, patch = {}) {
  const cur = (await getSession(env, userId)) || {};
  const pick = (k) => (k in patch ? patch[k] : cur[k] ?? null);
  await env.DB.prepare(
    "INSERT INTO user_sessions (telegram_user_id, state, selected_button_id, payment_plan, payment_method, updated_at) " +
      "VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP) ON CONFLICT(telegram_user_id) DO UPDATE SET " +
      "state = excluded.state, selected_button_id = excluded.selected_button_id, " +
      "payment_plan = excluded.payment_plan, payment_method = excluded.payment_method, updated_at = CURRENT_TIMESTAMP"
  ).bind(String(userId), state, pick("selected_button_id"), pick("payment_plan"), pick("payment_method")).run();
}

// ---- services (keyboard buttons) -----------------------------------------
export async function getButtons(env, includeInactive = false) {
  const sql = "SELECT * FROM keyboard_buttons " + (includeInactive ? "" : "WHERE is_active = 1 ") + "ORDER BY sort_order, id";
  const { results } = await env.DB.prepare(sql).all();
  return results || [];
}

export async function getButton(env, id) {
  return env.DB.prepare("SELECT * FROM keyboard_buttons WHERE id = ?").bind(id).first();
}

// ---- subscriptions --------------------------------------------------------
export async function getSubscription(env, userId) {
  return env.DB.prepare(
    "SELECT * FROM subscriptions WHERE telegram_user_id = ? AND status = 'active' " +
      "AND (plan = 'lifetime' OR expires_at > ?) " +
      "ORDER BY CASE plan WHEN 'lifetime' THEN 0 ELSE 1 END, expires_at DESC LIMIT 1"
  ).bind(String(userId), new Date().toISOString()).first();
}

// ---- admin "what am I typing" state --------------------------------------
export async function getAdminState(env, adminId) {
  const row = await env.DB.prepare("SELECT * FROM admin_state WHERE telegram_user_id = ?").bind(String(adminId)).first();
  if (!row) return null;
  let data = {};
  try { data = row.data ? JSON.parse(row.data) : {}; } catch { /* ignore */ }
  return { state: row.state, data };
}

export async function setAdminState(env, adminId, state, data = {}) {
  await env.DB.prepare(
    "INSERT INTO admin_state (telegram_user_id, state, data, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP) " +
      "ON CONFLICT(telegram_user_id) DO UPDATE SET state = excluded.state, data = excluded.data, updated_at = CURRENT_TIMESTAMP"
  ).bind(String(adminId), state, JSON.stringify(data)).run();
}

export async function clearAdminState(env, adminId) {
  await env.DB.prepare("DELETE FROM admin_state WHERE telegram_user_id = ?").bind(String(adminId)).run();
}
