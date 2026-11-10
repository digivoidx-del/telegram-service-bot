
import { sendMessage } from "./telegram.js";

const PLANS = {
  monthly: { amount: 9900, days: 30 },
  lifetime: { amount: 299900, days: null }
};

export async function createPaymentReview(env, userId, plan, method, proofFileId, reference) {
  const selectedPlan = PLANS[plan];

  if (!selectedPlan || !["upi", "crypto"].includes(method)) {
    throw new Error("Invalid plan or payment method");
  }

  if (!proofFileId && !reference) {
    throw new Error("Payment proof or transaction reference is required");
  }

  return env.DB.prepare(
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
}

export async function notifyPaymentAdmins(env, reviewId) {
  const admins = await env.DB.prepare(
    "SELECT telegram_user_id FROM admins WHERE is_active = 1"
  ).all();

  const review = await env.DB.prepare(
    `SELECT * FROM payment_reviews WHERE id = ?`
  ).bind(reviewId).first();

  if (!review) return;

  for (const admin of admins.results || []) {
    await sendMessage(
      env,
      admin.telegram_user_id,
      `New payment submission #${review.id}\nUser: ${review.telegram_user_id}\nPlan: ${review.plan}\nMethod: ${review.method}\nAmount: ₹${(review.amount_minor / 100).toFixed(2)}\n\nVerify the transaction independently before approval.`
    );
  }
}
