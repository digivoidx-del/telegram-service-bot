
import { sendMessage } from "./telegram.js";
import {
  getButtons,
  getSubscription,
  saveSession
} from "./database.js";
import { createPaymentReview } from "./payments.js";

export async function handleUser(env, message) {
  const userId = String(message.from.id);
  const chatId = message.chat.id;
  const text = (message.text || "").trim();

  let session = await env.DB.prepare(
    "SELECT * FROM user_sessions WHERE telegram_user_id = ?"
  ).bind(userId).first();

  if (text === "/start") {
    const buttons = await getButtons(env);
    const keyboard = [];

    for (let i = 0; i < buttons.length; i += 2) {
      keyboard.push(buttons.slice(i, i + 2).map(b => b.label));
    }

    await sendMessage(env, chatId, "Welcome! Select a service.", {
      reply_markup: {
        keyboard,
        resize_keyboard: true
      }
    });
    return true;
  }

  // Select subscription plan
  if (session?.state === "payment_required") {
    let plan;

    if (text === "Monthly ₹99") plan = "monthly";
    if (text === "Lifetime ₹2,999") plan = "lifetime";

    if (!plan) {
      await sendMessage(env, chatId, "Please select a subscription plan.");
      return true;
    }

    await env.DB.prepare(
      `UPDATE user_sessions
       SET state = 'choose_payment_method', payment_plan = ?
       WHERE telegram_user_id = ?`
    ).bind(plan, userId).run();

    await sendMessage(env, chatId, "Choose your payment method.", {
      reply_markup: {
        keyboard: [[{ text: "UPI" }, { text: "Crypto" }]],
        resize_keyboard: true
      }
    });
    return true;
  }

  // Select payment method
  if (session?.state === "choose_payment_method") {
    const method = text.toLowerCase();

    if (!["upi", "crypto"].includes(method)) {
      await sendMessage(env, chatId, "Please choose UPI or Crypto.");
      return true;
    }

    await env.DB.prepare(
      `UPDATE user_sessions
       SET state = 'awaiting_payment_proof', payment_method = ?
       WHERE telegram_user_id = ?`
    ).bind(method, userId).run();

    await sendMessage(
      env,
      chatId,
      "Payment instructions will be provided by the service administrator. After paying, send your payment screenshot or transaction reference here."
    );
    return true;
  }

  // Receive payment proof
  if (session?.state === "awaiting_payment_proof") {
    const proofFileId = message.photo?.at(-1)?.file_id || null;
    const reference = text || null;

    if (!proofFileId && !reference) {
      await sendMessage(env, chatId, "Please send a screenshot or transaction reference.");
      return true;
    }

    try {
      const reviewId = await createPaymentReview(
        env,
        userId,
        session.payment_plan,
        session.payment_method,
        proofFileId,
        reference
      );

      await saveSession(env, userId, "payment_review_submitted");

      await sendMessage(
        env,
        chatId,
        `Payment submission #${reviewId} received. Your subscription will activate only after payment verification.`
      );
    } catch (error) {
      console.error(error);
      await sendMessage(env, chatId, "Could not submit your payment proof. Please try again.");
    }

    return true;
  }

  // Select a service
  const buttons = await getButtons(env);
  const selected = buttons.find(b => b.label === text);

  if (selected) {
    const subscription = await getSubscription(env, userId);

    const record = await env.DB.prepare(
      "SELECT prompt FROM keyboard_buttons WHERE id = ?"
    ).bind(selected.id).first();

    await saveSession(env, userId, "awaiting_input", selected.id);

    await sendMessage(
      env,
      chatId,
      record?.prompt || "Please submit your information."
    );
    return true;
  }

  // Receive service information
  if (session?.state === "awaiting_input") {
    const button = await env.DB.prepare(
      "SELECT * FROM keyboard_buttons WHERE id = ?"
    ).bind(session.selected_button_id).first();

    if (!button) {
      await sendMessage(env, chatId, "This service is unavailable.");
      return true;
    }

    if (button.validation_pattern) {
      try {
        if (!new RegExp(button.validation_pattern).test(text)) {
          await sendMessage(
            env,
            chatId,
            button.validation_help || "Invalid format. Please try again."
          );
          return true;
        }
      } catch {
        await sendMessage(env, chatId, "Service configuration error.");
        return true;
      }
    }

    const subscription = await getSubscription(env, userId);

    if (!subscription) {
      await env.DB.prepare(
        `INSERT INTO requests
         (telegram_user_id, username, button_id, submitted_text, status)
         VALUES (?, ?, ?, ?, 'awaiting_payment')`
      ).bind(
        userId,
        message.from.username || "",
        button.id,
        text
      ).run();

      await saveSession(env, userId, "payment_required", button.id);

      await sendMessage(env, chatId, "Choose your subscription:", {
        reply_markup: {
          keyboard: [[
            { text: "Monthly ₹99" },
            { text: "Lifetime ₹2,999" }
          ]],
          resize_keyboard: true
        }
      });
      return true;
    }

    const result = await env.DB.prepare(
      `INSERT INTO requests
       (telegram_user_id, username, button_id, submitted_text, status)
       VALUES (?, ?, ?, ?, 'pending_admin')`
    ).bind(
      userId,
      message.from.username || "",
      button.id,
      text
    ).run();

    const admins = await env.DB.prepare(
      "SELECT telegram_user_id FROM admins WHERE is_active = 1"
    ).all();

    for (const admin of admins.results || []) {
      await sendMessage(
        env,
        admin.telegram_user_id,
        `📨 NEW REQUEST #${result.meta.last_row_id}\nUser: ${userId}\n${text}\n\nReply: /reply ${result.meta.last_row_id} Your response`
      );
    }

    await saveSession(env, userId, "awaiting_admin_reply");
    await sendMessage(env, chatId, "Your request has been forwarded to the admin.");
    return true;
  }

  await sendMessage(env, chatId, "Please select a service from the keyboard.");
  return true;
}
