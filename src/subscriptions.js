
import { sendMessage } from "./telegram.js";

export async function approvePayment(env, reviewId, adminId) {
  const admin = await env.DB.prepare(
    "SELECT 1 FROM admins WHERE telegram_user_id = ? AND is_active = 1"
  ).bind(String(adminId)).first();

  if (!admin) throw new Error("Unauthorized administrator");

  const review = await env.DB.prepare(
    "SELECT * FROM payment_reviews WHERE id = ? AND status = 'pending'"
  ).bind(reviewId).first();

  if (!review) throw new Error("Payment not found or already reviewed");

  const now = new Date();
  const startsAt = now.toISOString();
  const expiresAt = review.plan === "monthly"
    ? new Date(now.getTime() + 30 * 86400000).toISOString()
    : null;

  await env.DB.batch([
    env.DB.prepare(
      `UPDATE payment_reviews
       SET status = 'approved', reviewed_by = ?
       WHERE id = ? AND status = 'pending'`
    ).bind(String(adminId), reviewId),

    env.DB.prepare(
      `INSERT INTO subscriptions
       (telegram_user_id, plan, starts_at, expires_at, status)
       VALUES (?, ?, ?, ?, 'active')`
    ).bind(
      String(review.telegram_user_id),
      review.plan,
      startsAt,
      expiresAt
    )
  ]);

  const requests = await env.DB.prepare(
    `SELECT * FROM requests
     WHERE telegram_user_id = ? AND status = 'awaiting_payment'
     ORDER BY created_at ASC`
  ).bind(String(review.telegram_user_id)).all();

  const admins = await env.DB.prepare(
    "SELECT telegram_user_id FROM admins WHERE is_active = 1"
  ).all();

  for (const request of requests.results || []) {
    await env.DB.prepare(
      "UPDATE requests SET status = 'pending_admin' WHERE id = ?"
    ).bind(request.id).run();

    for (const admin of admins.results || []) {
      await sendMessage(
        env,
        admin.telegram_user_id,
        `📨 PAID REQUEST #${request.id}\n\n` +
        `User: ${request.telegram_user_id}\n` +
        `Service ID: ${request.button_id}\n` +
        `Information: ${request.submitted_text}\n\n` +
        `Reply using:\n/reply ${request.id} Your response`
      );
    }
  }

  await sendMessage(
    env,
    review.telegram_user_id,
    "✅ Your payment has been approved and your subscription is active."
  );

  return true;
}

export async function rejectPayment(env, reviewId, adminId) {
  const admin = await env.DB.prepare(
    "SELECT 1 FROM admins WHERE telegram_user_id = ? AND is_active = 1"
  ).bind(String(adminId)).first();

  if (!admin) throw new Error("Unauthorized administrator");

  const result = await env.DB.prepare(
    `UPDATE payment_reviews
     SET status = 'rejected', reviewed_by = ?
     WHERE id = ? AND status = 'pending'`
  ).bind(String(adminId), reviewId).run();

  if (!result.meta.changes) {
    throw new Error("Payment not found or already reviewed");
  }

  const review = await env.DB.prepare(
    "SELECT telegram_user_id FROM payment_reviews WHERE id = ?"
  ).bind(reviewId).first();

  await sendMessage(
    env,
    review.telegram_user_id,
    "Your payment submission was rejected. Please contact the administrator if you believe this is an error."
  );

  return true;
}
