// Thin wrapper around the Telegram Bot API. Never throws: failures are
// logged and returned as { ok:false } so one bad send can't crash a flow.

export async function tg(env, method, body = {}) {
  try {
    const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({ ok: false, description: `HTTP ${res.status}` }));
    if (!json.ok) console.error(`Telegram ${method} failed:`, json.error_code, json.description);
    return json;
  } catch (err) {
    console.error(`Telegram ${method} error:`, String(err));
    return { ok: false, description: String(err) };
  }
}

const clip = (text, max = 4096) => {
  const s = String(text ?? "");
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
};

export const sendMessage = (env, chatId, text, extra = {}) =>
  tg(env, "sendMessage", { chat_id: chatId, text: clip(text), ...extra });

export const editMessageText = (env, chatId, messageId, text, extra = {}) =>
  tg(env, "editMessageText", { chat_id: chatId, message_id: messageId, text: clip(text), ...extra });

export const clearButtons = (env, chatId, messageId) =>
  tg(env, "editMessageReplyMarkup", {
    chat_id: chatId,
    message_id: messageId,
    reply_markup: { inline_keyboard: [] },
  });

export const deleteMessage = (env, chatId, messageId) =>
  tg(env, "deleteMessage", { chat_id: chatId, message_id: messageId });

export const answerCallback = (env, id, text = "", showAlert = false) =>
  tg(env, "answerCallbackQuery", { callback_query_id: id, text: clip(text, 200), show_alert: showAlert });

export const sendPhoto = (env, chatId, photo, caption, extra = {}) =>
  tg(env, "sendPhoto", { chat_id: chatId, photo, caption: clip(caption, 1000), ...extra });

export const sendDocument = (env, chatId, document, caption, extra = {}) =>
  tg(env, "sendDocument", { chat_id: chatId, document, caption: clip(caption, 1000), ...extra });

// Long text (lists) is split so it never exceeds Telegram's 4096-character limit.
export async function sendLong(env, chatId, text, extra = {}) {
  const parts = [];
  let rest = String(text);
  while (rest.length > 3800) {
    let cut = rest.lastIndexOf("\n", 3800);
    if (cut < 1000) cut = 3800;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  parts.push(rest);
  let last;
  for (let i = 0; i < parts.length; i++) {
    last = await sendMessage(env, chatId, parts[i], i === parts.length - 1 ? extra : {});
  }
  return last;
}

export const messageIdOf = (res) => res?.result?.message_id ?? null;

export const inline = (rows) => ({ reply_markup: { inline_keyboard: rows } });
export const btn = (text, data) => ({ text, callback_data: data });
