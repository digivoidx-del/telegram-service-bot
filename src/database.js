
export async function isAdmin(env, userId) {
  const result = await env.DB.prepare(
    `SELECT telegram_user_id FROM admins
     WHERE telegram_user_id = ? AND is_active = 1`
  ).bind(String(userId)).first();

  return Boolean(result);
}

export async function getButtons(env) {
  const result = await env.DB.prepare(
    `SELECT id, label FROM keyboard_buttons
     WHERE is_active = 1
     ORDER BY sort_order ASC`
  ).all();

  return result.results || [];
}

export async function getSubscription(env, userId) {
  return env.DB.prepare(
    `SELECT * FROM subscriptions
     WHERE telegram_user_id = ?
     AND status = 'active'
     AND (plan = 'lifetime' OR expires_at > ?)
     ORDER BY id DESC LIMIT 1`
  ).bind(String(userId), new Date().toISOString()).first();
}

export async function saveSession(env, userId, state, buttonId = null) {
  await env.DB.prepare(
    `INSERT INTO user_sessions
     (telegram_user_id, state, selected_button_id, updated_at)
     VALUES (?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(telegram_user_id)
     DO UPDATE SET state = excluded.state,
     selected_button_id = excluded.selected_button_id,
     updated_at = CURRENT_TIMESTAMP`
  ).bind(String(userId), state, buttonId).run();
}
