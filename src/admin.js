
import { sendMessage } from "./telegram.js";
import {
  approvePayment,
  rejectPayment
} from "./subscriptions.js";

async function isAdmin(env, userId) {
  const admin = await env.DB.prepare(
    `SELECT 1 FROM admins
     WHERE telegram_user_id = ? AND is_active = 1`
  ).bind(String(userId)).first();

  return Boolean(admin);
}

export async function handleAdmin(message, env) {
  if (!message?.from || !message.chat) return false;

  const userId = String(message.from.id);
  const chatId = message.chat.id;
  const text = message.text || "";

  if (!(await isAdmin(env, userId))) return false;

  if (text === "/admin") {
    await sendMessage(
      env,
      chatId,
      "⚙️ ADMIN PANEL\n\n" +
      "/admin_requests - View pending requests\n" +
      "/admin_payments - View payment records\n" +
      "/admin_buttons - Button management status\n" +
      "/reply REQUEST_ID Your response"
    );
    return true;
  }

  if (text === "/admin_requests") {
    const rows = await env.DB.prepare(
      `SELECT * FROM requests
       WHERE status = 'pending_admin'
       ORDER BY created_at DESC LIMIT 20`
    ).all();

    const output = (rows.results || []).map(r =>
      `#${r.id} | User: ${r.telegram_user_id}\n${r.submitted_text}`
    );

    await sendMessage(
      env,
      chatId,
      output.join("\n\n") || "No pending requests."
    );
    return true;
  }

  if (text === "/admin_payments") {
    const rows = await env.DB.prepare(
      `SELECT id, telegram_user_id, plan, method,
       amount_minor, currency, status
       FROM payment_reviews
       ORDER BY id DESC LIMIT 20`
    ).all();

    const output = (rows.results || []).map(p =>
      `#${p.id} | User: ${p.telegram_user_id}\n` +
      `${p.plan} | ${p.method} | ${p.currency || "INR"} ` +
      `${(p.amount_minor / 100).toFixed(2)}\n` +
      `Status: ${p.status}`
    );

    await sendMessage(
      env,
      chatId,
      output.join("\n\n") || "No payments."
    );
    return true;
  }

  if (text === "/admin_buttons") {
    await sendMessage(
      env,
      chatId,
      "🛠 Button management is not implemented yet.\n\n" +
      "We'll add create, edit, delete and reorder options in a later step."
    );
    return true;
  }

  if (text.startsWith("/reply ")) {
    const match = text.match(/^\/reply\s+(\d+)\s+([\s\S]+)/);

    if (!match) {
      await sendMessage(
        env,
        chatId,
        "Usage: /reply REQUEST_ID Your response"
      );
      return true;
    }

    const requestId = Number(match[1]);
    const reply = match[2].trim();

    if (!reply) {
      await sendMessage(env, chatId, "Please enter a response.");
      return true;
    }

    const request = await env.DB.prepare(
      `SELECT * FROM requests
       WHERE id = ? AND status = 'pending_admin'`
    ).bind(requestId).first();

    if (!request) {
      await sendMessage(
        env,
        chatId,
        "Request not found or already answered."
      );
      return true;
    }

    await sendMessage(
      env,
      request.telegram_user_id,
      `📩 Admin response:\n\n${reply}`
    );

    await env.DB.prepare(
      `UPDATE requests
       SET status = 'answered',
           admin_reply = ?,
           replied_at = CURRENT_TIMESTAMP
       WHERE id = ? AND status = 'pending_admin'`
    ).bind(reply, requestId).run();

    await sendMessage(
      env,
      chatId,
      `Reply sent for request #${requestId}.`
    );
    return true;
  }

  return false;
}

export async function handlePaymentCallback(callback, env) {
  if (!callback?.from) {
    return { handled: true, message: "Invalid callback." };
  }

  const userId = String(callback.from.id);
  const data = callback.data || "";

  if (!(await isAdmin(env, userId))) {
    return { handled: true, message: "Not authorized." };
  }

  const match = data.match(/^payment:(approve|reject):(\d+)$/);

  if (!match) {
    return { handled: true, message: "Unknown payment action." };
  }

  const action = match[1];
  const reviewId = Number(match[2]);

  try {
    const result = action === "approve"
      ? await approvePayment(env, reviewId, userId)
      : await rejectPayment(env, reviewId, userId);

    return {
      handled: true,
      message: result.message || (
        result.success ? "Payment processed." : "Payment action failed."
      )
    };
  } catch (error) {
    console.error("Payment callback error:", error);

    return {
      handled: true,
      message: "Payment action failed. Please check the Worker logs."
    };
  }
}
