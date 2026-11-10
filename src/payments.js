
import { sendMessage } from "./telegram.js";

const PLANS = {
  monthly: 9900,
  lifetime: 299900
};

export async function createPaymentReview(
  env, userId, plan, method, proofFileId, reference
) {
  if (!PLANS[plan] || !["upi", "crypto"].includes(method)) {
    throw new Error("Invalid payment details");
  }

  if (!proofFileId && !reference) {
    throw new Error("Payment proof required");
  }

  const result = await env.DB.prepare(
    `INSERT INTO payment_reviews
     (telegram_user_id, plan, method, amount_minor, currency,
      proof_file_id, transaction_reference, status)
     VALUES (?, ?, ?, ?, 'INR', ?, ?, 'pending')`
  ).bind(
    String(userId),
    plan,
    method,
    PLANS[plan],
    proofFileId || null,
    reference || null
  ).run();

  const reviewId = result.meta.last_row_id;

  await notifyPaymentAdmins(env, reviewId);

  return reviewId;
}

export async function notifyPaymentAdmins(env, reviewId) {
  const review = await env.DB.prepare(
    "SELECT * FROM payment_reviews WHERE id = ?"
  ).bind(reviewId).first();

  if (!review) return;

  const admins = await env.DB.prepare(
    "SELECT telegram_user_id FROM admins WHERE is_active = 1"
  ).all();

  const caption =
    `💳 PAYMENT REVIEW #${review.id}\n\n` +
    `User: ${review.telegram_user_id}\n` +
    `Plan: ${review.plan}\n` +
    `Method: ${review.method}\n` +
    `Amount: ₹${(review.amount_minor / 100).toFixed(2)}\n` +
    `Reference: ${review.transaction_reference || "Not provided"}\n\n` +
    `Verify the actual transaction before approving.`;

  const markup = {
    inline_keyboard: [[
      { text: "✅ Approve", callback_data: `payment:approve:${review.id}` },
      { text: "❌ Reject", callback_data: `payment:reject:${review.id}` }
    ]]
  };

  for (const admin of admins.results || []) {
    const endpoint = review.proof_file_id ? "sendPhoto" : "sendMessage";

    const payload = review.proof_file_id
      ? {
          chat_id: admin.telegram_user_id,
          photo: review.proof_file_id,
          caption,
          reply_markup: markup
        }
      : {
          chat_id: admin.telegram_user_id,
          text: caption,
          reply_markup: markup
        };

    await fetch(
      `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${endpoint}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      }
    );
  }
}
