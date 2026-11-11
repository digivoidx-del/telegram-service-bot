// Request forwarding, payment approval/rejection and subscription activation.

import { getSettings, getPlans, getActiveAdmins, getUser } from "./database.js";
import { sendMessage, inline, btn } from "./telegram.js";
import { stopRotation } from "./presets.js";

// ---- forwarding requests to admins ---------------------------------------
export async function forwardRequest(env, requestId) {
  const r = await env.DB.prepare(
    "SELECT r.*, b.label AS service FROM requests r LEFT JOIN keyboard_buttons b ON b.id = r.button_id WHERE r.id = ?"
  ).bind(requestId).first();
  if (!r) return 0;
  const user = await getUser(env, r.telegram_user_id);
  const who = [user?.first_name, r.username ? "@" + r.username : null].filter(Boolean).join(" ");
  const text =
    `📩 New request #${r.id}\n` +
    `Service: ${r.service || "(deleted service)"}\n` +
    `User: ${who || "(no name)"} — ID ${r.telegram_user_id}\n\n` +
    `${r.submitted_text}\n\n` +
    `Tap Reply, or send: /reply ${r.id} your answer`;
  let delivered = 0;
  for (const adminId of await getActiveAdmins(env)) {
    const res = await sendMessage(env, adminId, text, inline([[btn("↩️ Reply", `a:reply:${r.id}`)]]));
    if (res.ok) delivered++;
  }
  return delivered;
}

// Moves every waiting request of this user to the admins. Each request is
// claimed with a conditional UPDATE, so it can never be forwarded twice.
export async function releaseRequests(env, userId) {
  const { results } = await env.DB.prepare(
    "SELECT id FROM requests WHERE telegram_user_id = ? AND status = 'awaiting_payment' ORDER BY id"
  ).bind(String(userId)).all();
  let released = 0;
  for (const row of results || []) {
    const res = await env.DB.prepare(
      "UPDATE requests SET status = 'pending_admin' WHERE id = ? AND status = 'awaiting_payment'"
    ).bind(row.id).run();
    if (res.meta.changes === 1) {
      await forwardRequest(env, row.id);
      released++;
    }
  }
  return released;
}

// ---- payments --------------------------------------------------------------
export async function approvePayment(env, reviewId, adminId) {
  const review = await env.DB.prepare("SELECT * FROM payment_reviews WHERE id = ?").bind(reviewId).first();
  if (!review) return { ok: false, message: "Payment not found." };
  if (review.status !== "pending") return { ok: false, message: `Already ${review.status}.` };

  const plan = getPlans(await getSettings(env))[review.plan];
  if (!plan) return { ok: false, message: "Unknown plan on this payment." };

  const now = new Date();
  const nowIso = now.toISOString();
  let expiresAt = null;
  if (plan.key === "monthly") {
    // Buying again while still subscribed extends the current period.
    const cur = await env.DB.prepare(
      "SELECT MAX(expires_at) AS e FROM subscriptions WHERE telegram_user_id = ? AND plan = 'monthly' AND status = 'active' AND expires_at > ?"
    ).bind(review.telegram_user_id, nowIso).first();
    const base = cur?.e && cur.e > nowIso ? new Date(cur.e) : now;
    expiresAt = new Date(base.getTime() + plan.days * 86400000).toISOString();
  }

  // One atomic step: mark approved + create the subscription. The UNIQUE index
  // on payment_review_id guarantees a payment can only ever activate once.
  const [upd] = await env.DB.batch([
    env.DB.prepare("UPDATE payment_reviews SET status = 'approved', reviewed_by = ? WHERE id = ? AND status = 'pending'")
      .bind(String(adminId), reviewId),
    env.DB.prepare(
      "INSERT OR IGNORE INTO subscriptions (telegram_user_id, plan, starts_at, expires_at, status, payment_review_id) " +
        "SELECT telegram_user_id, plan, ?, ?, 'active', id FROM payment_reviews WHERE id = ? AND status = 'approved'"
    ).bind(nowIso, expiresAt, reviewId),
  ]);
  if (upd.meta.changes !== 1) return { ok: false, message: "Already processed by another admin." };

  const userId = review.telegram_user_id;
  await stopRotation(env, userId, true); // remove the leftover preset message
  const released = await releaseRequests(env, userId);

  const until = expiresAt ? `Valid until ${expiresAt.slice(0, 10)}.` : "It never expires.";
  await sendMessage(
    env,
    userId,
    `✅ Payment approved! Your ${plan.name} plan is active. ${until}` +
      (released ? `\n\n${released} waiting request${released > 1 ? "s were" : " was"} sent for processing. You will get the answer here.` : "")
  );
  return { ok: true, message: `Payment #${reviewId} approved.`, released };
}

export async function rejectPayment(env, reviewId, adminId) {
  const review = await env.DB.prepare("SELECT * FROM payment_reviews WHERE id = ?").bind(reviewId).first();
  if (!review) return { ok: false, message: "Payment not found." };
  if (review.status !== "pending") return { ok: false, message: `Already ${review.status}.` };

  const res = await env.DB.prepare(
    "UPDATE payment_reviews SET status = 'rejected', reviewed_by = ? WHERE id = ? AND status = 'pending'"
  ).bind(String(adminId), reviewId).run();
  if (res.meta.changes !== 1) return { ok: false, message: "Already processed by another admin." };

  await sendMessage(
    env,
    review.telegram_user_id,
    "❌ We could not verify your payment, so no subscription was activated.\n" +
      "If you did pay, tap “Unlock It” on your request again and send a clear screenshot or the correct reference."
  );
  return { ok: true, message: `Payment #${reviewId} rejected.` };
}
