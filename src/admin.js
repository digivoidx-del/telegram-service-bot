import { sendMessage } from "./telegram.js";

export async function handleAdmin(message, env) {
  const text = message.text || "";
  const chatId = message.chat.id;
  const userId = String(message.from.id);

  const admin = await env.DB.prepare(
    "SELECT telegram_user_id FROM admins WHERE telegram_user_id = ? AND is_active = 1"
  ).bind(userId).first();

  if (!admin) return false;

  if (text === "/admin") {
    await sendMessage(env, chatId,
      "⚙️ Admin Panel\n\n/admin_buttons - Manage menu buttons\n/admin_requests - View pending requests\n/admin_payments - Review payment submissions"
    );
    return true;
  }

  if (text === "/admin_buttons") {
    const result = await env.DB.prepare(
      "SELECT id, label, is_active FROM keyboard_buttons ORDER BY sort_order"
    ).all();

    const lines = result.results.map(
      b => `${b.id}. ${b.label} ${b.is_active ? "✅" : "❌"}`
    );

    await sendMessage(env, chatId,
      "📋 Menu Buttons\n\n" + (lines.join("\n") || "No buttons created yet.")
    );
    return true;
  }

  if (text === "/admin_requests") {
    const result = await env.DB.prepare(
      "SELECT id, telegram_user_id, submitted_text, status FROM requests ORDER BY created_at DESC LIMIT 20"
    ).all();

    const lines = result.results.map(
      r => `#${r.id} | User: ${r.telegram_user_id}\n${r.submitted_text}\nStatus: ${r.status}`
    );

    await sendMessage(env, chatId,
      "📨 Recent Requests\n\n" + (lines.join("\n\n") || "No requests yet.")
    );
    return true;
  }

  if (text === "/admin_payments") {
    const result = await env.DB.prepare(
      "SELECT id, telegram_user_id, plan, method, amount_minor, currency, status FROM payment_reviews ORDER BY created_at DESC LIMIT 20"
    ).all();

    const lines = result.results.map(
      p => `#${p.id} | User: ${p.telegram_user_id}\n${p.plan} | ${p.method} | ${p.amount_minor} ${p.currency}\nStatus: ${p.status}`
    );

    await sendMessage(env, chatId,
      "💳 Payment Reviews\n\n" + (lines.join("\n\n") || "No payment submissions.")
    );
    return true;
  }

  return false;
}
