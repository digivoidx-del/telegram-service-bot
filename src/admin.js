
import { sendMessage } from "./telegram.js";
import {
  approvePayment,
  rejectPayment
} from "./subscriptions.js";

export async function handleAdmin(message, env) {
  const userId = String(message.from.id);
  const chatId = message.chat.id;
  const text = message.text || "";

  const admin = await env.DB.prepare(
    `SELECT 1 FROM admins
     WHERE telegram_user_id = ? AND is_active = 1`
  ).bind(userId).first();

  if (!admin) return false;

  if (text === "/admin") {
    await sendMessage(env, chatId,
      "⚙️ ADMIN PANEL\n\n" +
      "/admin_requests\n" +
      "/admin_payments\n" +
      "/admin_buttons\n" +
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

    await sendMessage(env, chatId, output.join("\n\n") || "No pending requests.");
    return true;
  }

  if (text === "/admin_payments") {
    const rows = await env.DB.prepare(
      `SELECT id, telegram_user_id, plan, method,
       amount_minor, status
       FROM payment_reviews
       ORDER BY id DESC LIMIT 20`
    ).all();

    const output = (rows.results || []).map(p =>
      `#${p.id} | User: ${p.telegram_user_id}\n` +
      `${p.plan} | ${p.method} | ₹${p.amount_minor / 100}\n` +
      `Status: ${p.status}`
    );

    await sendMessage(env, chatId, output.join("\n\n") || "No payments.");
    return true;
  }

  if (text.startsWith("/reply ")) {
    const match = text.match(/^\/reply\s+(\d+)\s+([\s\S]+)/);

    if (!match) {
      await sendMessage(env, chatId, "Usage: /reply REQUEST_ID Your response");
      return true;
    }

    const requestId = Number(match[1]);
    const reply = match[2];

    const request = await env.DB.prepare(
      `SELECT * FROM requests
       WHERE id = ? AND status = 'pending_admin'`
    ).bind(requestId).first();

    if (!request) {
      await sendMessage(env, chatId, "Request not found or already answered.");
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
       WHERE id = ?`
    ).bind(reply, requestId).run();

    await sendMessage(env, chatId, `Reply sent for request #${requestId}.`);
    return true;
  }

  return false;
}

export async function handlePaymentCallback(callback, env) {
  const userId = String(callback.from.id);
  const chatId = callback.message.chat.id;
  const data = callback.data || "";

  const admin = await env.DB.prepare(
    `SELECT 1 FROM admins
     WHERE telegram_user_id = ? AND is_active = 1`
  ).bind(userId).first();

  if (!admin) {
    return { handled: true, message: "Not authorized." };
  }

  const match = data.match(/^payment:(approve|reject):(\d+)$/);

  if (!match) return { handled: false };

  const reviewId = Number(match[2]);

  try {
    if (match[1] === "approve") {
      await approvePayment(env, reviewId, userId);
    } else {
      await rejectPayment(env, reviewId, userId);
    }

    return {
      handled: true,
      message: `Payment #${reviewId} ${match[1]}d.`
    };
  } catch (error) {
    console.error(error);

    return {
      handled: true,
      message: error.message || "Payment action failed."
    };
  }
}
