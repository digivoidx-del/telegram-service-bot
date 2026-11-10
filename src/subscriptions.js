
export async function approvePayment(env, reviewId, adminId) {
  const review = await env.DB.prepare(
    `SELECT * FROM payment_reviews
     WHERE id = ? AND status = 'pending'`
  ).bind(reviewId).first();

  if (!review) {
    throw new Error("Payment review not found or already reviewed");
  }

  const admin = await env.DB.prepare(
    `SELECT telegram_user_id FROM admins
     WHERE telegram_user_id = ? AND is_active = 1`
  ).bind(String(adminId)).first();

  if (!admin) {
    throw new Error("Unauthorized administrator");
  }

  const now = new Date();
  const startsAt = now.toISOString();

  const expiresAt = review.plan === "monthly"
    ? new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString()
    : null;

  const batch = await env.DB.batch([
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

  return batch;
}
