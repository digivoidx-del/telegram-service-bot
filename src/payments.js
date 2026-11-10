
import { sendMessage } from "./telegram.js";

const PLANS = {
  monthly: { amount: 9900 },
  lifetime: { amount: 299900 }
};

export async function createPaymentReview(
  env,
  userId,
  plan,
  method,
  proofFileId,
  reference
) {
  const selectedPlan = PLANS[plan];

  if (!selectedPlan || !["upi", "crypto"].includes(method)) {
    throw new Error("Invalid plan or payment method");
  }

  if (!proofFileId && !reference) {
    throw new Error("Payment proof or transaction reference is required");
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
    selectedPlan.amount,
    proofFileId || null,
    reference || null
  ).run();

  const reviewId = result.meta.last_row_id;

  await notifyPaymentAdmins(env, reviewId);

  return reviewId;
}

export async function notifyPaymentAdmins(env, reviewId) {
  const admins = await env.DB.prepare(
    `SELECT telegram_user_id FROM admins WHERE is_active = 1`
  ).all();

  const review = await env.DB.prepare(
    `SELECT * FROM payment_reviews WHERE id = ?`
  ).bind(reviewId).first();

  if (!review) return;

  const caption =
    `💳 PAYMENT REVIEW #${review.id}\n\n` +
    `User ID: ${review.telegram_user_id}\n` +
    `Plan: ${review.plan}\n` +
    `Method: ${review.method}\n` +
    `Amount: ₹${(review.amount_minor / 100).toFixed(2)}\n` +
    `Reference: ${review.transaction_reference || "Not provided"}\n\n` +
    `Verify the transaction independently before approving.`;

  const replyMarkup = {
    inline_keyboard: [[
      {
        text: "✅ Approve",
        callback_data: `payment:approve:${review.id}`
      },
      {
        text: "❌ Reject",
        callback_data: `payment:reject:${review.id}`
      }
    ]]
  };

  for (const admin of admins.results || []) {
    if (review.proof_file_id) {
      await fetch(
        `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendPhoto`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: admin.telegram_user_id,
            photo: review.proof_file_id,
            caption,
            reply_markup: replyMarkup
          })
        }
      );
    } else {
      await sendMessage(
        env,
        admin.telegram_user_id,
        caption,
        { reply_markup: replyMarkup }
      );
    }
  }
}
