
import { sendMessage } from "./telegram.js";
import { isAdmin } from "./database.js";

export async function handleAdmin(env, message) {
  const userId = String(message.from.id);
  const chatId = message.chat.id;
  const text = message.text || "";

  if (!(await isAdmin(env, userId))) return false;

  if (text === "/admin") {
    await sendMessage(env, chatId,
      "ADMIN PANEL\n\n" +
      "/requests - View pending requests\n" +
      "/addbutton - Add keyboard button\n" +
      "/subscribers - View subscribers\n" +
      "/payments - Review payments"
    );
    return true;
  }

  if (text === "/requests") {
    const rows = await env.DB.prepare(
      `SELECT id, telegram_user_id, submitted_text
       FROM requests WHERE status = 'pending'
       ORDER BY id ASC LIMIT 20`
    ).all();

    if (!rows.results.length) {
      await sendMessage(env, chatId, "No pending requests.");
      return true;
    }

    for (const r of rows.results) {
      await sendMessage(env, chatId,
        `Request #${r.id}\nUser: ${r.telegram_user_id}\nDetails: ${r.submitted_text}`
      );
    }
    return true;
  }

  return false;
}
