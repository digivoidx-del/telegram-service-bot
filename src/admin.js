// The admin panel — everything is done from inside Telegram.

import {
  isAdmin, getSettings, setSetting, formatMoney, DEFAULTS, getButtons, getButton,
  getAdminState, setAdminState, clearAdminState, getActiveAdmins,
} from "./database.js";
import {
  sendMessage, sendLong, editMessageText, clearButtons, inline, btn,
} from "./telegram.js";
import { approvePayment, rejectPayment } from "./subscriptions.js";
import { notifyPaymentAdmins } from "./payments.js";
import { countAudience, createBroadcast, runBroadcastBatch } from "./broadcast.js";
import { menuMarkup } from "./user.js";

const BACK = btn("⬅️ Back", "a:menu");
const short = (s, n = 28) => { s = String(s ?? ""); return s.length > n ? s.slice(0, n - 1) + "…" : s; };
const yes = (v) => (v ? "yes" : "no");

// Show a panel: edit the message the admin tapped, or send a new one.
async function show(env, c, text, rows) {
  const extra = inline(rows);
  if (c.messageId) {
    const r = await editMessageText(env, c.chatId, c.messageId, text, extra);
    if (r.ok || /not modified/i.test(r.description || "")) return;
  }
  await sendMessage(env, c.chatId, text, extra);
}

const count = async (env, sql, ...args) => (await env.DB.prepare(sql).bind(...args).first())?.n ?? 0;

// ---------------------------------------------------------------------------
// Settings definitions (what the Settings screen can edit)
// ---------------------------------------------------------------------------
const SETTINGS = [
  { key: "welcome_message", label: "Welcome message", type: "text" },
  { key: "unlock_button_text", label: "Unlock button text", type: "text", max: 40 },
  { key: "processing_message", label: "Processing message", type: "text" },
  { key: "monthly_price", label: "Monthly price (₹)", type: "money" },
  { key: "lifetime_price", label: "Lifetime price (₹)", type: "money" },
  { key: "monthly_days", label: "Monthly plan length (days)", type: "int", min: 1, max: 3650 },
  { key: "upi_id", label: "UPI ID", type: "text", max: 100 },
  { key: "upi_name", label: "UPI payee name", type: "text", max: 100 },
  { key: "upi_instructions", label: "UPI instructions", type: "text" },
  { key: "crypto_instructions", label: "Crypto instructions", type: "text" },
  { key: "preset_enabled", label: "Preset rotation", type: "bool" },
  { key: "preset_max_ticks", label: "Max preset swaps per request", type: "int", min: 1, max: 200 },
];
const settingDef = (key) => SETTINGS.find((s) => s.key === key);
function showValue(def, v) {
  if (def.type === "bool") return v === "1" ? "ON" : "OFF";
  if (def.type === "money") return formatMoney(v);
  return v ? short(v.replace(/\n/g, " "), 22) : "(not set)";
}

// ---------------------------------------------------------------------------
// Screens
// ---------------------------------------------------------------------------
async function mainMenu(env, c) {
  const now = new Date().toISOString();
  const req = await count(env, "SELECT COUNT(*) AS n FROM requests WHERE status = 'pending_admin'");
  const pay = await count(env, "SELECT COUNT(*) AS n FROM payment_reviews WHERE status = 'pending'");
  const svc = await count(env, "SELECT COUNT(*) AS n FROM keyboard_buttons WHERE is_active = 1");
  const subs = await count(
    env,
    "SELECT COUNT(DISTINCT telegram_user_id) AS n FROM subscriptions WHERE status = 'active' AND (plan = 'lifetime' OR expires_at > ?)",
    now
  );
  await show(env, c,
    `🛠 Admin panel\n\nActive services: ${svc}\nPending requests: ${req}\nPending payments: ${pay}\nActive subscribers: ${subs}`,
    [
      [btn("🧩 Services", "a:svc"), btn(`💳 Payments (${pay})`, "a:pay")],
      [btn(`📩 Requests (${req})`, "a:req"), btn("⏱ Preset messages", "a:pre")],
      [btn("📢 Broadcast", "a:bc"), btn("⚙️ Settings", "a:set")],
      [btn("👥 Admins", "a:adm"), btn("✖ Close", "a:close")],
    ]);
}

async function servicesList(env, c) {
  const list = await getButtons(env, true);
  const rows = list.map((b) => [btn(`${b.is_active ? "✅" : "🚫"} ${short(b.label, 40)}`, `a:svc:v:${b.id}`)]);
  rows.push([btn("➕ Add service", "a:svc:new")], [BACK]);
  await show(env, c,
    list.length ? "🧩 Services (tap one to edit):" : "🧩 No services yet.\nTap “Add service” to create your first one.", rows);
}

async function serviceDetail(env, c, id) {
  const b = await getButton(env, id);
  if (!b) return show(env, c, "Service not found.", [[btn("⬅️ Services", "a:svc")]]);
  await show(env, c,
    `🧩 Service #${b.id}\n\nName: ${b.label}\nActive: ${yes(b.is_active)}\nOrder: ${b.sort_order}\n` +
      `Prompt: ${b.prompt || "(none)"}\nValidation pattern: ${b.validation_pattern || "(none)"}\n` +
      `Validation help: ${b.validation_help || "(none)"}\n` +
      `Preset message (after valid input): ${b.preset_message || "(using the global preset messages)"}\n` +
      `Unlock button text: ${b.unlock_button_text || "(using the global button text)"}`,
    [
      [btn("✏️ Name", `a:svc:e:${b.id}:name`), btn("💬 Prompt", `a:svc:e:${b.id}:prompt`)],
      [btn("🔎 Pattern", `a:svc:e:${b.id}:pattern`), btn("❗ Help text", `a:svc:e:${b.id}:help`)],
      [btn("⏱ Preset message", `a:svc:e:${b.id}:preset`), btn("🔓 Button text", `a:svc:e:${b.id}:unlock`)],
      [btn("🔢 Order", `a:svc:e:${b.id}:order`), btn(b.is_active ? "🚫 Disable" : "✅ Enable", `a:svc:t:${b.id}`)],
      [btn("🗑 Delete", `a:svc:d:${b.id}`)],
      [btn("⬅️ Services", "a:svc")],
    ]);
}

async function settingsScreen(env, c) {
  const s = await getSettings(env);
  const rows = SETTINGS.map((d) => [
    btn(`${d.label}: ${showValue(d, s[d.key])}`, d.type === "bool" ? `a:set:t:${d.key}` : `a:set:e:${d.key}`),
  ]);
  rows.push([BACK]);
  await show(env, c, "⚙️ Settings — tap one to change it.", rows);
}

async function presetsScreen(env, c) {
  const s = await getSettings(env);
  const { results } = await env.DB.prepare("SELECT * FROM preset_messages ORDER BY sort_order, id").all();
  const list = results || [];
  const rows = list.map((p) => [btn(`${p.is_active ? "✅" : "🚫"} ${short(p.text, 36)}`, `a:pre:v:${p.id}`)]);
  rows.push([btn(`Rotation: ${s.preset_enabled === "1" ? "ON" : "OFF"} (tap to switch)`, "a:set:t:preset_enabled")]);
  rows.push([btn("➕ Add preset message", "a:pre:new")], [BACK]);
  await show(env, c,
    "⏱ Preset messages\n\nShown to a user while their request waits for payment. With 2 or more active messages the bot " +
      `swaps them every 13–15 seconds (deleting only the previous preset message), up to ${s.preset_max_ticks} times.`,
    rows);
}

async function adminsScreen(env, c) {
  const { results } = await env.DB.prepare("SELECT * FROM admins ORDER BY telegram_user_id").all();
  const list = results || [];
  const owner = env.OWNER_ID ? String(env.OWNER_ID).trim() : null;
  const rows = list
    .filter((a) => a.telegram_user_id !== owner)
    .map((a) => [btn(`${a.is_active ? "✅ Deactivate" : "🚫 Activate"} ${a.telegram_user_id}`, `a:adm:t:${a.telegram_user_id}`)]);
  rows.push([btn("➕ Add admin", "a:adm:new")], [BACK]);
  await show(env, c,
    "👥 Admins\n\n" +
      (owner ? `Owner: ${owner} (always active)\n` : "") +
      (list.filter((a) => a.telegram_user_id !== owner).map((a) => `${a.is_active ? "✅" : "🚫"} ${a.telegram_user_id}`).join("\n") || "No other admins."),
    rows);
}

async function requestsScreen(env, c) {
  const { results } = await env.DB.prepare(
    "SELECT r.*, b.label AS service FROM requests r LEFT JOIN keyboard_buttons b ON b.id = r.button_id " +
      "WHERE r.status = 'pending_admin' ORDER BY r.id LIMIT 20"
  ).all();
  const waiting = await count(env, "SELECT COUNT(*) AS n FROM requests WHERE status = 'awaiting_payment'");
  const list = results || [];
  const text =
    `📩 Requests waiting for your reply: ${list.length}\n(${waiting} more are waiting for the user to pay)\n\n` +
    list.map((r) => `#${r.id} • ${r.service || "?"} • user ${r.telegram_user_id}\n${short(r.submitted_text, 80)}`).join("\n\n");
  const rows = list.map((r) => [btn(`↩️ Reply to #${r.id}`, `a:reply:${r.id}`)]);
  rows.push([BACK]);
  await show(env, c, text, rows);
}

async function paymentsScreen(env, c) {
  const { results } = await env.DB.prepare(
    "SELECT * FROM payment_reviews WHERE status = 'pending' ORDER BY id LIMIT 20"
  ).all();
  const list = results || [];
  const rows = list.map((p) => [btn(`📄 #${p.id} ${p.plan} ${p.method} ${formatMoney(p.amount_minor)}`, `a:pay:o:${p.id}`)]);
  rows.push([BACK]);
  await show(env, c, list.length ? "💳 Pending payments (tap to open the review card):" : "💳 No pending payments.", rows);
}

async function broadcastMenu(env, c) {
  const all = await countAudience(env, "all");
  const subs = await countAudience(env, "subs");
  await show(env, c, "📢 Broadcast — who should receive it?", [
    [btn(`Everyone (${all})`, "a:bc:a:all")],
    [btn(`Active subscribers (${subs})`, "a:bc:a:subs")],
    [BACK],
  ]);
}

// ---------------------------------------------------------------------------
// Replies to users
// ---------------------------------------------------------------------------
async function deliverReply(env, requestId, text, adminId) {
  const claim = await env.DB.prepare(
    "UPDATE requests SET status = 'answered', admin_reply = ?, replied_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'pending_admin'"
  ).bind(text, requestId).run();
  if (claim.meta.changes !== 1) {
    const r = await env.DB.prepare("SELECT status FROM requests WHERE id = ?").bind(requestId).first();
    return { ok: false, message: r ? `Request #${requestId} is already ${r.status}.` : `Request #${requestId} not found.` };
  }
  const req = await env.DB.prepare(
    "SELECT r.telegram_user_id, b.label AS service FROM requests r LEFT JOIN keyboard_buttons b ON b.id = r.button_id WHERE r.id = ?"
  ).bind(requestId).first();
  const res = await sendMessage(
    env, req.telegram_user_id,
    `💬 Reply to your request #${requestId}${req.service ? ` (${req.service})` : ""}:\n\n${text}`,
    await menuMarkup(env)
  );
  if (!res.ok) {
    // Could not deliver: put it back so it is not lost.
    await env.DB.prepare("UPDATE requests SET status = 'pending_admin', admin_reply = NULL, replied_at = NULL WHERE id = ?").bind(requestId).run();
    return { ok: false, message: `Could not deliver to the user (${res.description || "unknown error"}). Request #${requestId} is still open.` };
  }
  return { ok: true, message: `✅ Reply to #${requestId} delivered.` };
}

// ---------------------------------------------------------------------------
// Messages from admins
// ---------------------------------------------------------------------------
export async function handleAdminMessage(env, ctx, message) {
  const adminId = String(message.from.id);
  if (!(await isAdmin(env, adminId))) return false;

  const chatId = message.chat.id;
  const c = { chatId };
  const text = (message.text || "").trim();
  const cmd = text.startsWith("/") ? text.split(/\s+/)[0].split("@")[0].toLowerCase() : null;

  if (cmd === "/admin" || cmd === "/panel") { await clearAdminState(env, adminId); await mainMenu(env, c); return true; }
  if (cmd === "/admin_requests") { await requestsScreen(env, c); return true; }
  if (cmd === "/admin_payments") { await paymentsScreen(env, c); return true; }
  if (cmd === "/admin_buttons") { await servicesList(env, c); return true; }

  if (cmd === "/reply") {
    const m = text.match(/^\/reply(?:@\w+)?\s+(\d+)\s+([\s\S]+)$/i);
    if (!m) { await sendMessage(env, chatId, "Usage: /reply REQUEST_ID your answer"); return true; }
    const r = await deliverReply(env, parseInt(m[1], 10), m[2].trim(), adminId);
    await sendMessage(env, chatId, r.message);
    return true;
  }

  const st = await getAdminState(env, adminId);
  if (cmd === "/cancel") {
    if (!st) return false;
    await clearAdminState(env, adminId);
    await sendMessage(env, chatId, "Cancelled.");
    return true;
  }
  if (cmd === "/start") { await clearAdminState(env, adminId); return false; } // admins can use the bot like users too
  if (st && !cmd) { await handleInput(env, ctx, c, adminId, st, text); return true; }
  return false;
}

// Admin typed something while the bot was waiting for an answer.
async function handleInput(env, ctx, c, adminId, st, text) {
  const { state, data } = st;
  const say = (t) => sendMessage(env, c.chatId, t);
  if (!text) return say("Please send text (or /cancel).");

  // ---- add service (guided) ----
  if (state === "svc_add_label") {
    if (text.length > 40) return say("Keep the name under 40 characters.");
    if (await count(env, "SELECT COUNT(*) AS n FROM keyboard_buttons WHERE label = ?", text)) return say("A service with that name already exists. Send a different name.");
    await setAdminState(env, adminId, "svc_add_prompt", { label: text });
    return say("2/4 — What should the bot ask the user? (the prompt)\nExample: Please send the 10-digit number.");
  }
  if (state === "svc_add_prompt") {
    await setAdminState(env, adminId, "svc_add_pattern", { ...data, prompt: text === "-" ? "Please send the details for this service." : text });
    return say("3/4 — Validation pattern (a regular expression), e.g. ^\\d{10}$\nSend - for no validation.");
  }
  if (state === "svc_add_pattern") {
    let pattern = null;
    if (text !== "-") {
      const bad = checkPattern(text);
      if (bad) return say(bad);
      pattern = text;
    }
    await setAdminState(env, adminId, "svc_add_help", { ...data, pattern });
    return say("4/5 — Message shown when the user's input does not match.\nExample: That doesn't look right — send exactly 10 digits.\nSend - to skip.");
  }
  if (state === "svc_add_help") {
    await setAdminState(env, adminId, "svc_add_preset", { ...data, help: text === "-" ? null : text });
    return say("5/5 — Preset message shown to the user right after a valid answer (with the Unlock button).\nSend - to use the global preset messages instead.");
  }
  if (state === "svc_add_preset") {
    if (text.length > 1000) return say("Keep it under 1000 characters.");
    const max = await count(env, "SELECT COALESCE(MAX(sort_order), 0) AS n FROM keyboard_buttons");
    const res = await env.DB.prepare(
      "INSERT INTO keyboard_buttons (label, prompt, validation_pattern, validation_help, preset_message, sort_order, is_active) VALUES (?, ?, ?, ?, ?, ?, 1)"
    ).bind(data.label, data.prompt, data.pattern ?? null, data.help ?? null, text === "-" ? null : text, max + 1).run();
    await clearAdminState(env, adminId);
    await say("✅ Service created. Users see it the next time the bot replies to them.");
    return serviceDetail(env, c, res.meta.last_row_id);
  }

  // ---- edit a service field ----
  if (state === "svc_edit") {
    const { id, field } = data;
    let col, val = text;
    if (field === "name") {
      if (text.length > 40) return say("Keep the name under 40 characters.");
      if (await count(env, "SELECT COUNT(*) AS n FROM keyboard_buttons WHERE label = ? AND id != ?", text, id)) return say("Another service already uses that name.");
      col = "label";
    } else if (field === "prompt") col = "prompt";
    else if (field === "preset") {
      col = "preset_message";
      if (text === "-") val = null; else if (text.length > 1000) return say("Keep it under 1000 characters.");
    } else if (field === "unlock") {
      col = "unlock_button_text";
      if (text === "-") val = null; else if (text.length > 40) return say("Keep the button text under 40 characters.");
    }
    else if (field === "pattern") {
      col = "validation_pattern";
      if (text === "-") val = null;
      else { const bad = checkPattern(text); if (bad) return say(bad); }
    } else if (field === "help") { col = "validation_help"; if (text === "-") val = null; }
    else if (field === "order") {
      if (!/^-?\d{1,6}$/.test(text)) return say("Send a whole number, e.g. 1.");
      col = "sort_order"; val = parseInt(text, 10);
    } else return say("Unknown field.");
    await env.DB.prepare(`UPDATE keyboard_buttons SET ${col} = ? WHERE id = ?`).bind(val, id).run();
    await clearAdminState(env, adminId);
    await say("✅ Saved.");
    return serviceDetail(env, c, id);
  }

  // ---- edit a setting ----
  if (state === "set_edit") {
    const def = settingDef(data.key);
    if (!def) return say("Unknown setting.");
    if (text === "-") {
      await env.DB.prepare("DELETE FROM bot_settings WHERE setting_key = ?").bind(def.key).run(); // back to default
    } else {
      let val = text;
      if (def.type === "money") {
        if (!/^\d+(\.\d{1,2})?$/.test(text) || parseFloat(text) <= 0) return say("Send an amount in rupees, e.g. 99 or 99.50.");
        val = String(Math.round(parseFloat(text) * 100));
      } else if (def.type === "int") {
        const n = parseInt(text, 10);
        if (!/^\d+$/.test(text) || n < def.min || n > def.max) return say(`Send a whole number between ${def.min} and ${def.max}.`);
        val = String(n);
      } else if (text.length > (def.max || 1000)) return say(`Too long (maximum ${def.max || 1000} characters).`);
      await setSetting(env, def.key, val);
    }
    await clearAdminState(env, adminId);
    await say("✅ Saved.");
    return settingsScreen(env, c);
  }

  // ---- presets ----
  if (state === "preset_add") {
    if (text.length > 1000) return say("Keep it under 1000 characters.");
    const max = await count(env, "SELECT COALESCE(MAX(sort_order), 0) AS n FROM preset_messages");
    await env.DB.prepare("INSERT INTO preset_messages (text, sort_order, is_active) VALUES (?, ?, 1)").bind(text, max + 1).run();
    await clearAdminState(env, adminId);
    await say("✅ Preset message added.");
    return presetsScreen(env, c);
  }

  // ---- admins ----
  if (state === "admin_add") {
    if (!/^\d{5,15}$/.test(text)) return say("A Telegram ID is only digits (5–15). Ask the person to send /id to this bot.");
    await env.DB.prepare(
      "INSERT INTO admins (telegram_user_id, is_active) VALUES (?, 1) ON CONFLICT(telegram_user_id) DO UPDATE SET is_active = 1"
    ).bind(text).run();
    await clearAdminState(env, adminId);
    await say("✅ Admin added. They can now open the panel with /admin.");
    return adminsScreen(env, c);
  }

  // ---- broadcast ----
  if (state === "bc_text") {
    if (text.length > 3000) return say("Keep the broadcast under 3000 characters.");
    const n = await countAudience(env, data.audience);
    await setAdminState(env, adminId, "bc_confirm", { audience: data.audience, text });
    return show(env, c, `📢 Preview:\n\n${text}\n\n— Send to ${n} ${data.audience === "subs" ? "active subscribers" : "users"}?`, [
      [btn("✅ Send now", "a:bc:go"), btn("❌ Cancel", "a:bc:x")],
    ]);
  }
  if (state === "bc_confirm") return say("Tap “Send now” or “Cancel” on the preview above (or /cancel).");

  // ---- reply to a request ----
  if (state === "reply") {
    const r = await deliverReply(env, data.id, text, adminId);
    if (r.ok) await clearAdminState(env, adminId);
    return say(r.message);
  }

  await clearAdminState(env, adminId);
  return say("That is no longer needed. Send /admin to open the panel.");
}

function checkPattern(p) {
  if (p.length > 200) return "That pattern is too long (200 characters max).";
  try { new RegExp(p); } catch { return "That is not a valid pattern. Try again, or send - to skip."; }
  return null;
}

// ---------------------------------------------------------------------------
// Buttons from admins — returns { text, alert } for the toast
// ---------------------------------------------------------------------------
export async function handleAdminCallback(env, ctx, cb) {
  const adminId = String(cb.from.id);
  if (!(await isAdmin(env, adminId))) return { text: "Not authorised.", alert: true };

  const c = { chatId: cb.message?.chat?.id ?? cb.from.id, messageId: cb.message?.message_id };
  const p = String(cb.data).split(":");

  // Payment review buttons (on the card sent to every admin)
  if (p[0] === "payment") {
    const id = parseInt(p[2], 10);
    const r = p[1] === "approve" ? await approvePayment(env, id, adminId) : p[1] === "reject" ? await rejectPayment(env, id, adminId) : { ok: false, message: "Unknown action." };
    if (c.messageId) await clearButtons(env, c.chatId, c.messageId);
    if (r.ok) await sendMessage(env, c.chatId, `${p[1] === "approve" ? "✅" : "❌"} ${r.message}`);
    return { text: r.message, alert: !r.ok };
  }

  const [, area, act, arg, arg2] = p;
  const num = (v) => parseInt(v, 10);

  switch (area) {
    case "menu": await clearAdminState(env, adminId); await mainMenu(env, c); return {};
    case "close": if (c.messageId) await editMessageText(env, c.chatId, c.messageId, "Panel closed. Send /admin to open it again."); return {};

    case "svc":
      if (!act) { await servicesList(env, c); return {}; }
      if (act === "new") { await setAdminState(env, adminId, "svc_add_label"); await sendMessage(env, c.chatId, "1/4 — Name of the new service? (this is the button users tap)\n/cancel to stop."); return {}; }
      if (act === "v") { await serviceDetail(env, c, num(arg)); return {}; }
      if (act === "t") {
        await env.DB.prepare("UPDATE keyboard_buttons SET is_active = 1 - is_active WHERE id = ?").bind(num(arg)).run();
        await serviceDetail(env, c, num(arg)); return {};
      }
      if (act === "e") {
        const prompts = {
          name: "Send the new name.", prompt: "Send the new prompt.",
          pattern: "Send the new validation pattern, or - to remove it.", help: "Send the new help text, or - to remove it.",
          order: "Send the order number (1 = first).",
          preset: "Send the preset message shown after a valid answer (with the Unlock button), or - to use the global ones.",
          unlock: "Send the Unlock button text for this service (e.g. 🎭 Unmask It), or - to use the global one.",
        };
        if (!prompts[arg2]) return { text: "Unknown field." };
        await setAdminState(env, adminId, "svc_edit", { id: num(arg), field: arg2 });
        await sendMessage(env, c.chatId, `${prompts[arg2]}\n/cancel to stop.`); return {};
      }
      if (act === "d") {
        await show(env, c, "Delete this service? Requests already submitted are kept.", [
          [btn("🗑 Yes, delete", `a:svc:dd:${num(arg)}`), btn("Keep it", `a:svc:v:${num(arg)}`)]]);
        return {};
      }
      if (act === "dd") { await env.DB.prepare("DELETE FROM keyboard_buttons WHERE id = ?").bind(num(arg)).run(); await servicesList(env, c); return { text: "Deleted." }; }
      return {};

    case "set":
      if (!act) { await settingsScreen(env, c); return {}; }
      if (act === "e") {
        const def = settingDef(act === "e" ? arg : "");
        if (!def) return { text: "Unknown setting." };
        await setAdminState(env, adminId, "set_edit", { key: def.key });
        const s = await getSettings(env);
        await sendMessage(env, c.chatId,
          `${def.label}\nCurrent: ${s[def.key] ? (def.type === "money" ? formatMoney(s[def.key]) : s[def.key]) : "(not set)"}\n\n` +
            `Send the new value${def.type === "money" ? " in rupees (e.g. 99)" : ""}. Send - to reset/clear it. /cancel to stop.`);
        return {};
      }
      if (act === "t") {
        const def = settingDef(arg);
        if (!def || def.type !== "bool") return { text: "Unknown setting." };
        const s = await getSettings(env);
        await setSetting(env, def.key, s[def.key] === "1" ? "0" : "1");
        if (c.messageId && /^preset/.test(def.key) && cb.message?.text?.startsWith("⏱")) await presetsScreen(env, c);
        else await settingsScreen(env, c);
        return {};
      }
      return {};

    case "pre":
      if (!act) { await presetsScreen(env, c); return {}; }
      if (act === "new") { await setAdminState(env, adminId, "preset_add"); await sendMessage(env, c.chatId, "Send the text of the new preset message. /cancel to stop."); return {}; }
      if (act === "v") {
        const pm = await env.DB.prepare("SELECT * FROM preset_messages WHERE id = ?").bind(num(arg)).first();
        if (!pm) { await presetsScreen(env, c); return { text: "Not found." }; }
        await show(env, c, `⏱ Preset #${pm.id} (${pm.is_active ? "active" : "disabled"}):\n\n${pm.text}`, [
          [btn(pm.is_active ? "🚫 Disable" : "✅ Enable", `a:pre:t:${pm.id}`), btn("🗑 Delete", `a:pre:d:${pm.id}`)],
          [btn("⬅️ Back", "a:pre")]]);
        return {};
      }
      if (act === "t") { await env.DB.prepare("UPDATE preset_messages SET is_active = 1 - is_active WHERE id = ?").bind(num(arg)).run(); await presetsScreen(env, c); return {}; }
      if (act === "d") { await env.DB.prepare("DELETE FROM preset_messages WHERE id = ?").bind(num(arg)).run(); await presetsScreen(env, c); return { text: "Deleted." }; }
      return {};

    case "adm":
      if (!act) { await adminsScreen(env, c); return {}; }
      if (act === "new") { await setAdminState(env, adminId, "admin_add"); await sendMessage(env, c.chatId, "Send the new admin's numeric Telegram ID.\n(They can get it by sending /id to this bot.) /cancel to stop."); return {}; }
      if (act === "t") {
        const target = String(arg);
        if (target === adminId) return { text: "You cannot deactivate yourself.", alert: true };
        if (env.OWNER_ID && target === String(env.OWNER_ID).trim()) return { text: "The owner cannot be deactivated.", alert: true };
        await env.DB.prepare("UPDATE admins SET is_active = 1 - is_active WHERE telegram_user_id = ?").bind(target).run();
        await adminsScreen(env, c); return {};
      }
      return {};

    case "req": await requestsScreen(env, c); return {};
    case "pay":
      if (!act) { await paymentsScreen(env, c); return {}; }
      if (act === "o") { const n = await notifyPaymentAdmins(env, num(arg), adminId); return { text: n ? "Review card sent below." : "Could not open it." }; }
      return {};

    case "reply": {
      const id = num(act);
      const r = await env.DB.prepare("SELECT status FROM requests WHERE id = ?").bind(id).first();
      if (!r) return { text: "Request not found.", alert: true };
      if (r.status !== "pending_admin") return { text: `Request #${id} is already ${r.status}.`, alert: true };
      await setAdminState(env, adminId, "reply", { id });
      await sendMessage(env, c.chatId, `✍️ Type your reply to request #${id} now (it is sent to the user). /cancel to stop.`);
      return {};
    }

    case "bc":
      if (!act) { await broadcastMenu(env, c); return {}; }
      if (act === "a" && (arg === "all" || arg === "subs")) {
        await setAdminState(env, adminId, "bc_text", { audience: arg });
        await sendMessage(env, c.chatId, "Send the message to broadcast. /cancel to stop."); return {};
      }
      if (act === "go") {
        const st = await getAdminState(env, adminId);
        if (!st || st.state !== "bc_confirm") return { text: "Nothing to send — start again from the panel.", alert: true };
        const id = await createBroadcast(env, st.data.text, st.data.audience, adminId);
        await clearAdminState(env, adminId);
        if (c.messageId) await clearButtons(env, c.chatId, c.messageId);
        ctx.waitUntil(runBroadcastBatch(env));
        await sendMessage(env, c.chatId, `📢 Broadcast #${id} started. I will message you when it is finished.`);
        return { text: "Broadcast started." };
      }
      if (act === "x") { await clearAdminState(env, adminId); await broadcastMenu(env, c); return { text: "Cancelled." }; }
      return {};
  }
  return { text: "Unknown action." };
}
