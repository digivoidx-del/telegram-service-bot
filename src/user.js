
import { sendMessage } from "./telegram.js";
import {
  getButtons,
  getSubscription,
  saveSession
} from "./database.js";

export async function handleUser(env, message) {
  const userId = String(message.from.id);
  const chatId = message.chat.id;
  const text = message.text || "";

  if (text === "/start") {
    const buttons = await getButtons(env);
    const keyboard = [];

    for (let i = 0; i < buttons.length; i += 2) {
      keyboard.push(
        buttons.slice(i, i + 2).map(b => b.label)
      );
    }

    await sendMessage(env, chatId, "Welcome! Select a service.", {
      reply_markup: {
        keyboard,
        resize_keyboard: true
      }
    });
    return;
  }

  const buttons = await getButtons(env);
  const selected = buttons.find(b => b.label === text);

  if (selected) {
    const record = await env.DB.prepare(
      "SELECT prompt FROM keyboard_buttons WHERE id = ?"
    ).bind(selected.id).first();

    await saveSession(env, userId, "awaiting_input", selected.id);

    await sendMessage(
      env,
      chatId,
      record?.prompt || "Please submit your information."
    );
    return;
  }

  const session = await env.DB.prepare(
    "SELECT * FROM user_sessions WHERE telegram_user_id = ?"
  ).bind(userId).first();

  if (session?.state === "awaiting_input") {
    const button = await env.DB.prepare(
      "SELECT * FROM keyboard_buttons WHERE id = ?"
    ).bind(session.selected_button_id).first();

    if (!button) {
      await sendMessage(env, chatId, "This service is unavailable.");
      return;
    }

    if (button.validation_pattern) {
      let valid = false;

      try {
        valid = new RegExp(button.validation_pattern).test(text);
      } catch {
        await sendMessage(env, chatId, "Service configuration error.");
        return;
      }

      if (!valid) {
        await sendMessage(
          env,
          chatId,
          button.validation_help || "Invalid format. Please try again."
        );
        return;
      }
    }

    const subscription = await getSubscription(env, userId);

    if (!subscription) {
      await saveSession(env, userId, "payment_required", button.id);

      await sendMessage(
        env,
        chatId,
        "A subscription is required to continue.\n\nMonthly: ₹99 (30 days)\nLifetime: ₹2,999 (no expiry)\n\nPayment options will be available soon."
      );
      return;
    }

    const request = await env.DB.prepare(
      `INSERT INTO requests
       (telegram_user_id, username, button_id, submitted_text, status)
       VALUES (?, ?, ?, ?, 'pending_admin')`
    ).bind(
      userId,
      message.from.username || "",
      button.id,
      text
    ).run();

    await saveSession(env, userId, "awaiting_admin_reply");

    await sendMessage(
      env,
      chatId,
      "Your request has been submitted to the admin. Request ID: " +
        request.meta.last_row_id
    );

    return;
  }

  if (session?.state === "payment_required") {
    await sendMessage(
      env,
      chatId,
      "Your request is waiting for an active subscription. Please complete the subscription process."
    );
    return;
  }

  await sendMessage(env, chatId, "Please select a service from the keyboard.");
}
