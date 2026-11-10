
import { sendMessage } from "./telegram.js";
import { approvePayment } from "./subscriptions.js";

export async function handleAdmin(message, env) {
  const text = message.text || "";
  const chatId = message.chat.id;
  const userId = String(message.from.id);

  const admin = await env.DB.prepare(
    `SELECT telegram_user_id FROM admins
     WHERE telegram_user_id = ? AND is_active = 1`
  ).bind(userId).first();

  if (!admin) return false;

  // Main admin panel
  if (text === "/admin") {
    await sendMessage(
      env,
      chatId,
      "⚙️ ADMIN PANEL\n\n" +
      "/admin_buttons - View menu buttons\n" +
      "/admin_requests - View recent requests\n" +
      "/admin_payments - View payment submissions\n" +
      "/approve ID - Approve a verified payment\n" +
      "/reject ID - Reject a payment"
    );
    return true;
  }

  // List menu buttons
  if (text === "/admin_buttons") {
    const result = await env.DB.prepare(
      `SELECT id, label, is_active
       FROM keyboard_buttons
       ORDER BY sort_order`
    ).all();

    const lines = (result.results || []).map(
      b => `${b.id}. ${b.label} ${b.is_active ? "✅" : "❌"}`
    );

    await sendMessage(
      env,
      chatId,
      "📋 MENU BUTTONS\n\n" +
      (lines.join("\n") || "No buttons created yet.")
    );
    return true;
  }

  // List recent requests
  if (text === "/admin_requests") {
    const result = await env.DB.prepare(
      `SELECT id, telegram_user_id, submitted_text, status
       FROM requests
       ORDER BY created_at DESC
       LIMIT 20`
    ).all();

    const lines = (result.results || []).map(
      r =>
        `#${r.id} | User: ${r.telegram_user_id}\n` +
        `${r.submitted_text}\nStatus: ${r.status}`
    );

    await sendMessage(
      env,
      chatId,
      "📨 RECENT REQUESTS\n\n" +
      (lines.join("\n\n") || "No requests yet.")
    );
    return true;
  }

  // List payment submissions
  if (text === "/admin_payments") {
    const result = await env.DB.prepare(
      `SELECT id, telegram_user_id, plan, method,
              amount_minor, currency, status,
              transaction_reference
       FROM payment_reviews
       ORDER BY created_at DESC
       LIMIT 20`
    ).all();

    const lines = (result.results || []).map(
      p =>
        `#${p.id} | User: ${p.telegram_user_id}\n` +
        `Plan: ${p.plan}\n` +
        `Method: ${p.method}\n` +
        `Amount: ${p.currency} ${(p.amount_minor / 100).toFixed(2)}\n` +
        `Reference: ${p.transaction_reference || "Not provided"}\n` +
        `Status: ${p.status}`
    );

    await sendMessage(
      env,
      chatId,
      "💳 PAYMENT REVIEWS\n\n" +
      (lines.join("\n\n") || "No payment submissions.")
    );
    return true;
  }

  // Approve a verified payment
  if (text.startsWith("/approve ")) {
    const reviewId = Number(text.split(/\s+/)[1]);

    if (!Number.isInteger(reviewId) || reviewId <= 0) {
      await sendMessage(env, chatId, "Usage: /approve PAYMENT_ID");
      return true;
    }

    try {
      await approvePayment(env, reviewId, userId);

      await sendMessage(
        env,
        chatId,
        `✅ Payment #${reviewId} approved. Subscription activated.`
      );
    } catch (error) {
      console.error("Payment approval error:", error);

      await sendMessage(
        env,
        chatId,
        `Approval failed: ${error.message}`
      );
    }

    return true;
  }

  // Reject a payment submission
  if (text.startsWith("/reject ")) {
    const reviewId = Number(text.split(/\s+/)[1]);

    if (!Number.isInteger(reviewId) || reviewId <= 0) {
      await sendMessage(env, chatId, "Usage: /reject PAYMENT_ID");
      return true;
    }

    const result = await env.DB.prepare(
      `UPDATE payment_reviews
       SET status = 'rejected', reviewed_by = ?
       WHERE id = ? AND status = 'pending'`
    ).bind(userId, reviewId).run();

    if (result.meta.changes > 0) {
      await sendMessage(env, chatId, `❌ Payment #${reviewId} rejected.`);
    } else {
      await sendMessage(
        env,
        chatId,
        "Payment not found or already reviewed."
      );
    }

    return true;
  }

  return false;
}
