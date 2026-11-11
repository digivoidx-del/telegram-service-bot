// Everything a normal user sees: menu, service requests, unlock + payment.

import {
  getSettings, getPlans, formatMoney, getButtons, getButton, getSession, saveSession,
  getSubscription, upsertUser,
} from "./database.js";
import { sendMessage, editMessageText, inline, btn } from "./telegram.js";
import { sendProcessingMessage, stopRotation } from "./presets.js";
import { forwardRequest, releaseRequests } from "./subscriptions.js";
import { createPaymentReview, notifyPaymentAdmins, pendingReviewFor } from "./payments.js";
import { sendPhoto } from "./telegram.js";

const MAX_INPUT = 1000;
const MAX_WAITING = 5;

// The reply keyboard is rebuilt from the database on (almost) every reply,
// so changes made in the admin panel reach users automatically.
export async function menuMarkup(env) {
  const buttons = await getButtons(env);
  if (!buttons.length) return { reply_markup: { remove_keyboard: true } };
  const rows = [];
  for (let i = 0; i < buttons.length; i += 2) rows.push(buttons.slice(i, i + 2).map((b) => ({ text: b.label })));
  return { reply_markup: { keyboard: rows, resize_keyboard: true } };
}

async function showMenu(env, chatId, text) {
  const settings = await getSettings(env);
  const buttons = await getButtons(env);
  const msg = text || (buttons.length ? settings.welcome_message : settings.no_services_message);
  return sendMessage(env, chatId, msg, await menuMarkup(env));
}

async function reply(env, chatId, text) {
  return sendMessage(env, chatId, text, await menuMarkup(env));
}

function planLines(plans) {
  return (
    `• Monthly — ${formatMoney(plans.monthly.amount)} (${plans.monthly.days} days)\n` +
    `• Lifetime — ${formatMoney(plans.lifetime.amount)} (never expires)`
  );
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------
export async function handleUserMessage(env, message) {
  const userId = String(message.from.id);
  const chatId = message.chat.id;
  const text = (message.text || "").trim();
  await upsertUser(env, message.from, chatId);

  const cmd = text.startsWith("/") ? text.split(/\s+/)[0].split("@")[0].toLowerCase() : null;

  if (cmd === "/start" || cmd === "/menu" || cmd === "/help") {
    await stopRotation(env, chatId, false);
    await saveSession(env, userId, "idle", { selected_button_id: null, payment_plan: null, payment_method: null });
    return showMenu(env, chatId);
  }
  if (cmd === "/cancel") {
    await stopRotation(env, chatId, false);
    await saveSession(env, userId, "idle", { selected_button_id: null, payment_plan: null, payment_method: null });
    return showMenu(env, chatId, "Cancelled. Choose a service whenever you are ready.");
  }
  if (cmd === "/id") return reply(env, chatId, `Your Telegram ID is: ${userId}`);
  if (cmd === "/status") {
    const sub = await getSubscription(env, userId);
    if (!sub) return reply(env, chatId, "You do not have an active subscription.");
    return reply(
      env, chatId,
      sub.plan === "lifetime" ? "✅ Lifetime plan — never expires." : `✅ Monthly plan — valid until ${sub.expires_at.slice(0, 10)}.`
    );
  }

  const session = await getSession(env, userId);

  // Tapping a service button always (re)starts that service.
  const buttons = await getButtons(env);
  const chosen = buttons.find((b) => b.label === text);
  if (chosen) {
    await saveSession(env, userId, "awaiting_input", { selected_button_id: chosen.id });
    return reply(env, chatId, chosen.prompt || "Please send the details for this service.");
  }

  if (session?.state === "awaiting_payment_proof") return receivePaymentProof(env, message, session);
  if (session?.state === "awaiting_input") return receiveServiceInput(env, message, session, text);

  return showMenu(env, chatId, buttons.length ? "Please choose a service from the menu below." : null);
}

async function receiveServiceInput(env, message, session, text) {
  const userId = String(message.from.id);
  const chatId = message.chat.id;

  const button = session.selected_button_id ? await getButton(env, session.selected_button_id) : null;
  if (!button || !button.is_active) {
    await saveSession(env, userId, "idle", { selected_button_id: null });
    return showMenu(env, chatId, "That service is no longer available. Please choose another.");
  }
  if (!text) return reply(env, chatId, "Please send your answer as text.");
  if (text.length > MAX_INPUT) return reply(env, chatId, `That is too long (maximum ${MAX_INPUT} characters).`);

  if (button.validation_pattern) {
    let ok = true;
    try {
      ok = new RegExp(button.validation_pattern).test(text);
    } catch (err) {
      console.error(`Bad validation pattern on service #${button.id}:`, String(err));
      return reply(env, chatId, "This service is temporarily unavailable. Please try again later.");
    }
    if (!ok) return reply(env, chatId, button.validation_help || "That doesn't look right. Please check it and try again.");
  }

  const sub = await getSubscription(env, userId);
  await saveSession(env, userId, "idle", { selected_button_id: null });

  if (sub) {
    const res = await env.DB.prepare(
      "INSERT INTO requests (telegram_user_id, username, button_id, submitted_text, status) VALUES (?, ?, ?, ?, 'pending_admin')"
    ).bind(userId, message.from.username ?? null, button.id, text).run();
    const id = res.meta.last_row_id;
    await forwardRequest(env, id);
    return reply(env, chatId, `✅ Request #${id} received. You will get the answer here.`);
  }

  // Not subscribed: save it, but keep it away from admins until payment is approved.
  let row = await env.DB.prepare(
    "SELECT id FROM requests WHERE telegram_user_id = ? AND button_id = ? AND submitted_text = ? AND status = 'awaiting_payment'"
  ).bind(userId, button.id, text).first();
  if (!row) {
    const waiting = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM requests WHERE telegram_user_id = ? AND status = 'awaiting_payment'"
    ).bind(userId).first();
    if (waiting.n >= MAX_WAITING) {
      return reply(env, chatId, `You already have ${MAX_WAITING} requests waiting. Please unlock them first.`);
    }
    const res = await env.DB.prepare(
      "INSERT INTO requests (telegram_user_id, username, button_id, submitted_text, status) VALUES (?, ?, ?, ?, 'awaiting_payment')"
    ).bind(userId, message.from.username ?? null, button.id, text).run();
    row = { id: res.meta.last_row_id };
  }
  return sendProcessingMessage(env, chatId, userId, row.id, button);
}

async function receivePaymentProof(env, message, session) {
  const userId = String(message.from.id);
  const chatId = message.chat.id;
  const plan = session.payment_plan;
  const method = session.payment_method;
  if (!plan || !method) {
    await saveSession(env, userId, "idle", { payment_plan: null, payment_method: null });
    return showMenu(env, chatId, "Your payment session expired. Tap “Unlock It” on your request to start again.");
  }

  const photoId = message.photo?.length ? message.photo[message.photo.length - 1].file_id : null;
  const doc = message.document;
  const docOk = doc && (/^image\//.test(doc.mime_type || "") || doc.mime_type === "application/pdf");
  const proof = photoId ? { type: "photo", fileId: photoId } : docOk ? { type: "doc", fileId: doc.file_id } : null;
  const reference = (message.text || message.caption || "").trim().slice(0, 200);

  if (method === "upi" && !proof) return reply(env, chatId, "Please send a screenshot of your payment (as a photo).");
  if (method === "crypto" && !proof && reference.length < 8) {
    return reply(env, chatId, "Please send the transaction ID/hash (or a screenshot) as proof of payment.");
  }

  const existing = await pendingReviewFor(env, userId);
  if (existing) {
    await saveSession(env, userId, "idle", { payment_plan: null, payment_method: null });
    return reply(env, chatId, `Your payment #${existing.id} is already being reviewed. Please wait for the result.`);
  }

  const reviewId = await createPaymentReview(env, userId, plan, method, proof, reference);
  await saveSession(env, userId, "idle", { payment_plan: null, payment_method: null });
  const delivered = await notifyPaymentAdmins(env, reviewId);
  return reply(
    env, chatId,
    `✅ Payment proof received (#${reviewId}). An admin will verify it and you will be notified here.` +
      (delivered ? "" : "\n\n(We could not reach an admin right now — your submission is saved and will be reviewed.)")
  );
}

// ---------------------------------------------------------------------------
// Buttons under messages (callbacks)  — returns { text, alert } for the toast
// ---------------------------------------------------------------------------
export async function handleUserCallback(env, cb) {
  const userId = String(cb.from.id);
  const chatId = cb.message?.chat?.id ?? cb.from.id;
  const messageId = cb.message?.message_id;
  const [, action, arg] = String(cb.data).split(":");
  const settings = await getSettings(env);
  const plans = getPlans(settings);
  await upsertUser(env, cb.from, chatId);

  if (action === "unlock") {
    const req = await env.DB.prepare(
      "SELECT id, status FROM requests WHERE id = ? AND telegram_user_id = ?"
    ).bind(parseInt(arg, 10), userId).first();
    if (!req || req.status !== "awaiting_payment") return { text: "This request is no longer waiting." };

    await stopRotation(env, chatId, false);
    if (await getSubscription(env, userId)) {
      await releaseRequests(env, userId);
      return { text: "You are already subscribed — your request was sent!" };
    }
    await sendMessage(
      env, chatId,
      `🔓 Choose a plan to unlock your request:\n\n${planLines(plans)}`,
      inline([
        [btn(`Monthly — ${formatMoney(plans.monthly.amount)}`, "u:plan:monthly")],
        [btn(`Lifetime — ${formatMoney(plans.lifetime.amount)}`, "u:plan:lifetime")],
      ])
    );
    return {};
  }

  if (action === "plan") {
    const plan = plans[arg];
    if (!plan) return { text: "Unknown plan." };
    await saveSession(env, userId, "choose_method", { payment_plan: plan.key, payment_method: null });
    const text = `${plan.name} plan — ${formatMoney(plan.amount)}\n\nHow would you like to pay?`;
    const kb = inline([
      [btn("📲 UPI", "u:method:upi"), btn("🪙 Cryptocurrency", "u:method:crypto")],
      [btn("✖ Cancel", "u:cancel")],
    ]);
    if (messageId) await editMessageText(env, chatId, messageId, text, kb);
    else await sendMessage(env, chatId, text, kb);
    return {};
  }

  if (action === "method") {
    const session = await getSession(env, userId);
    const plan = plans[session?.payment_plan];
    if (!plan) return { text: "Session expired. Tap “Unlock It” on your request again.", alert: true };

    if (arg === "upi") {
      if (!settings.upi_id) return { text: "UPI payments are not set up yet. Please contact support.", alert: true };
      await saveSession(env, userId, "upi_pay", { payment_method: "upi" });
      const amount = (plan.amount / 100).toFixed(2);
      const caption =
        `${plan.name} plan — ${formatMoney(plan.amount)}\n\n${settings.upi_instructions}\n\n` +
        `UPI ID: ${settings.upi_id}${settings.upi_name ? ` (${settings.upi_name})` : ""}\nAmount: ${formatMoney(plan.amount)}\n\n` +
        `After paying, tap “Payment Done”.`;
      const kb = inline([[btn("✅ Payment Done", "u:paid")], [btn("✖ Cancel", "u:cancel")]]);
      // Dynamic QR: encodes this exact amount (rendered by a free QR image service).
      const upiUri =
        `upi://pay?pa=${encodeURIComponent(settings.upi_id).replace(/%40/g, "@")}&pn=${encodeURIComponent(settings.upi_name || "Payment")}` +
        `&am=${amount}&cu=INR&tn=${encodeURIComponent(plan.name + " plan")}`;
      const qr = `https://api.qrserver.com/v1/create-qr-code/?size=500x500&margin=12&data=${encodeURIComponent(upiUri)}`;
      const res = await sendPhoto(env, chatId, qr, caption, kb);
      if (!res.ok) await sendMessage(env, chatId, caption, kb); // QR service unreachable: text-only fallback
      return {};
    }
    if (arg === "crypto") {
      if (!settings.crypto_instructions) return { text: "Crypto payments are not set up yet. Please contact support.", alert: true };
      await saveSession(env, userId, "awaiting_payment_proof", { payment_method: "crypto" });
      await sendMessage(
        env, chatId,
        `${plan.name} plan — ${formatMoney(plan.amount)}\n\n${settings.crypto_instructions}\n\n` +
          `After paying, send the transaction ID/hash here (or a screenshot).`,
        inline([[btn("✖ Cancel", "u:cancel")]])
      );
      return {};
    }
    return { text: "Unknown payment method." };
  }

  if (action === "paid") {
    if (await pendingReviewFor(env, userId)) return { text: "Your payment is already being reviewed.", alert: true };
    const session = await getSession(env, userId);
    if (!session?.payment_plan || session.payment_method !== "upi") {
      return { text: "Session expired. Tap “Unlock It” on your request again.", alert: true };
    }
    await saveSession(env, userId, "awaiting_payment_proof");
    await sendMessage(env, chatId, "📸 Please send a screenshot of your payment now. You can add the UTR/reference number as the caption.");
    return {};
  }

  if (action === "cancel") {
    await saveSession(env, userId, "idle", { payment_plan: null, payment_method: null });
    await sendMessage(env, chatId, "Cancelled. Your request is still saved — tap “Unlock It” on it when you are ready.", await menuMarkup(env));
    return {};
  }

  return { text: "Unknown action." };
}
