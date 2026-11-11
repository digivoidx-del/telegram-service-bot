// Payment submissions and the admin review cards.

import { getSettings, getPlans, formatMoney, getActiveAdmins, getUser } from "./database.js";
import { sendMessage, sendPhoto, sendDocument, inline, btn } from "./telegram.js";

export async function pendingReviewFor(env, userId) {
  return env.DB.prepare(
    "SELECT id FROM payment_reviews WHERE telegram_user_id = ? AND status = 'pending' LIMIT 1"
  ).bind(String(userId)).first();
}

export async function createPaymentReview(env, userId, planKey, method, proof, reference) {
  const plan = getPlans(await getSettings(env))[planKey];
  if (!plan) throw new Error("Unknown plan: " + planKey);
  const stored = proof ? `${proof.type}:${proof.fileId}` : null;
  const res = await env.DB.prepare(
    "INSERT INTO payment_reviews (telegram_user_id, plan, method, amount_minor, currency, proof_file_id, transaction_reference, status) " +
      "VALUES (?, ?, ?, ?, 'INR', ?, ?, 'pending')"
  ).bind(String(userId), planKey, method, plan.amount, stored, reference || null).run();
  return res.meta.last_row_id;
}

export const reviewKeyboard = (id) =>
  inline([[btn("✅ Approve", `payment:approve:${id}`), btn("❌ Reject", `payment:reject:${id}`)]]);

async function reviewCard(env, review) {
  const user = await getUser(env, review.telegram_user_id);
  const who = [user?.first_name, user?.username ? "@" + user.username : null].filter(Boolean).join(" ");
  const plan = getPlans(await getSettings(env))[review.plan];
  return (
    `💳 Payment review #${review.id}\n` +
    `User: ${who || "(no name)"} — ID ${review.telegram_user_id}\n` +
    `Plan: ${plan ? plan.name : review.plan} — ${formatMoney(review.amount_minor)}\n` +
    `Method: ${review.method.toUpperCase()}\n` +
    `Reference: ${review.transaction_reference || "(none)"}\n` +
    `Status: ${review.status}` +
    (review.status === "pending" ? "\n\n⚠️ Confirm the money really arrived in your bank/wallet before approving." : "")
  );
}

// Sends the card to one admin (or to every active admin). Returns how many got it.
export async function notifyPaymentAdmins(env, reviewId, onlyAdminId = null) {
  const review = await env.DB.prepare("SELECT * FROM payment_reviews WHERE id = ?").bind(reviewId).first();
  if (!review) return 0;
  const card = await reviewCard(env, review);
  const markup = review.status === "pending" ? reviewKeyboard(review.id) : {};
  const admins = onlyAdminId ? [String(onlyAdminId)] : await getActiveAdmins(env);

  let delivered = 0;
  for (const adminId of admins) {
    let res;
    const [kind, ...rest] = (review.proof_file_id || "").split(":");
    const fileId = rest.join(":");
    if (review.proof_file_id && kind === "doc") res = await sendDocument(env, adminId, fileId, card, markup);
    else if (review.proof_file_id) res = await sendPhoto(env, adminId, kind === "photo" ? fileId : review.proof_file_id, card, markup);
    if (!res || !res.ok) res = await sendMessage(env, adminId, card, markup);
    if (res.ok) delivered++;
  }
  if (delivered === 0) console.error(`Payment review #${reviewId}: no admin could be notified`);
  return delivered;
}
