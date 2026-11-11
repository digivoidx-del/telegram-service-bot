// Admin broadcasts. Messages go out in small batches (Cloudflare limits how
// many Telegram calls one run may make); the once-a-minute cron continues.

import { sendMessage } from "./telegram.js";

const subscriberFilter =
  " AND EXISTS (SELECT 1 FROM subscriptions s WHERE s.telegram_user_id = users.telegram_user_id " +
  "AND s.status = 'active' AND (s.plan = 'lifetime' OR s.expires_at > ?))";

export async function countAudience(env, audience) {
  const sql = "SELECT COUNT(*) AS n FROM users WHERE is_blocked = 0" + (audience === "subs" ? subscriberFilter : "");
  const stmt = env.DB.prepare(sql);
  const row = audience === "subs" ? await stmt.bind(new Date().toISOString()).first() : await stmt.first();
  return row?.n ?? 0;
}

export async function createBroadcast(env, text, audience, adminId) {
  const res = await env.DB.prepare(
    "INSERT INTO broadcast_jobs (text, audience, status, created_by) VALUES (?, ?, 'running', ?)"
  ).bind(text, audience, String(adminId)).run();
  return res.meta.last_row_id;
}

export async function runBroadcastBatch(env) {
  const budget = parseInt(env.FETCH_BUDGET, 10) || 40;
  const job = await env.DB.prepare("SELECT * FROM broadcast_jobs WHERE status = 'running' ORDER BY id LIMIT 1").first();
  if (!job) return;

  const audienceSql = job.audience === "subs" ? subscriberFilter : "";
  const stmt = env.DB.prepare(
    "SELECT rowid AS rid, chat_id FROM users WHERE is_blocked = 0 AND rowid > ?" + audienceSql + " ORDER BY rowid LIMIT ?"
  );
  const { results } = await (job.audience === "subs"
    ? stmt.bind(job.last_rowid, new Date().toISOString(), budget)
    : stmt.bind(job.last_rowid, budget)
  ).all();
  const batch = results || [];

  let sent = 0, failed = 0, last = job.last_rowid;
  for (const u of batch) {
    const res = await sendMessage(env, u.chat_id, job.text);
    last = u.rid;
    if (res.ok) sent++;
    else {
      failed++;
      if (res.error_code === 403) await env.DB.prepare("UPDATE users SET is_blocked = 1 WHERE rowid = ?").bind(u.rid).run();
    }
  }

  const finished = batch.length < budget;
  await env.DB.prepare(
    "UPDATE broadcast_jobs SET last_rowid = ?, sent = sent + ?, failed = failed + ?, status = ? WHERE id = ?"
  ).bind(last, sent, failed, finished ? "done" : "running", job.id).run();

  if (finished && job.created_by) {
    const fin = await env.DB.prepare("SELECT sent, failed FROM broadcast_jobs WHERE id = ?").bind(job.id).first();
    await sendMessage(env, job.created_by, `📢 Broadcast #${job.id} finished.\nDelivered: ${fin.sent}\nFailed: ${fin.failed}`);
  }
}
