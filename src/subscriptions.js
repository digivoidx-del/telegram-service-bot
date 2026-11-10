
import { sendMessage } from "./telegram.js";

async function isActiveAdmin(env, adminId) {
  const admin = await env.DB.prepare(
    `SELECT telegram_user_id
     FROM admins
     WHERE telegram_user_id = ? AND is_active = 1`
  ).bind(String(adminId)).first();

  return Boolean(admin);
}

export async function approvePayment(env, reviewId, adminId) {
  if (!(await isActiveAdmin(env, adminId))) {
    return { success: false, message: "You are not an active admin." };
  }

  const review = await env.DB.prepare(
    `SELECT * FROM payment_reviews
     WHERE id = ? AND status = 'pending'`
  ).bind(reviewId).first();

  if (!review) {
    return {
      success: false,
      message: "Payment is already reviewed or does not exist."
    };
  }

  const startsAt = new Date().toISOString();

  const expiresAt = review.plan === "monthly"
    ? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
    : null;

  if (!["monthly", "lifetime"].includes(review.plan)) {
    return { success: false, message: "Invalid subscription plan." };
  }

  // D1 batch runs these statements transactionally.
  // The unique payment_review_id prevents duplicate subscriptions.
  const results = await env.DB.batch([
    env.DB.prepare(
      `UPDATE payment_reviews
       SET status = 'approved', reviewed_by = ?
       WHERE id = ? AND status = 'pending'`
    ).bind(String(adminId), reviewId),

    env.DB.prepare(
      `INSERT OR IGNORE INTO subscriptions
       (telegram_user_id, plan, starts_at, expires_at, status, payment_review_id)
       SELECT telegram_user_id, plan, ?, ?, 'active', id
       FROM payment_reviews
       WHERE id = ?
         AND status = 'approved'
         AND reviewed_by = ?`
    ).bind(startsAt, expiresAt, reviewId, String(adminId))
  ]);

  const inserted = results[1]?.meta?.changes || 0;

  if (inserted !== 1) {
    return {
      success: false,
      message: "This payment was already processed. No duplicate subscription was created."
    };
  }

  const pendingRequests = await env.DB.prepare(
    `SELECT id, telegram_user_id, submitted_text
     FROM requests
     WHERE telegram_user_id = ?
       AND status = 'awaiting_payment'`
  ).bind(String(review.telegram_user_id)).all();

  const requests = pendingRequests.results || [];

  const adminsResult = await env.DB.prepare(
    `SELECT telegram_user_id
     FROM admins
     WHERE is_active = 1`
  ).all();

  const admins = adminsResult.results || [];

  for (const request of requests) {
    await env.DB.prepare(
      `UPDATE requests
       SET status = 'pending_admin'
       WHERE id = ? AND status = 'awaiting_payment'`
    ).bind(request.id).run();

    const requestText =
      `📩 NEW PAID REQUEST #${request.id}\n\n` +
      `User ID: ${request.telegram_user_id}\n` +
      `Request:\n${request.submitted_text}\n\n` +
      `Reply using:\n/reply ${request.id} Your response`;

    for (const admin of admins) {
      await sendMessage(env, admin.telegram_user_id, requestText);
    }
  }

  await sendMessage(
    env,
    review.telegram_user_id,
    `✅ Your ${review.plan} subscription has been activated.`
  );

  return {
    success: true,
    message: "Payment approved and subscription activated."
  };
}

export async function rejectPayment(env, reviewId, adminId) {
  if (!(await isActiveAdmin(env, adminId))) {
    return { success: false, message: "You are not an active admin." };
  }

  const result = await env.DB.prepare(
    `UPDATE payment_reviews
     SET status = 'rejected', reviewed_by = ?
     WHERE id = ? AND status = 'pending'`
  ).bind(String(adminId), reviewId).run();

  if ((result.meta?.changes || 0) !== 1) {
    return {
      success: false,
      message: "This payment was already reviewed or does not exist."
    };
  }

  const review = await env.DB.prepare(
    `SELECT telegram_user_id
     FROM payment_reviews
     WHERE id = ?`
  ).bind(reviewId).first();

  if (review) {
    await sendMessage(
      env,
      review.telegram_user_id,
      "❌ Your payment review was rejected. Please contact an administrator if you believe this is a mistake."
    );
  }

  return {
    success: true,
    message: "Payment rejected."
  };
}
