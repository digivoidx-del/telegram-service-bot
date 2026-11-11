// Preset ("processing") messages.
//
// When a user submits a request but has not paid yet, the bot shows an
// admin-written preset message with the Unlock button. If the admin has
// configured 2+ preset messages, a small Durable Object (one per chat) swaps
// the message every 13-15 seconds: it DELETES the previous preset message,
// then sends the next one. Nothing else in the chat is ever deleted.

import { sendMessage, deleteMessage, messageIdOf, inline, btn } from "./telegram.js";
import { getSettings, getSubscription } from "./database.js";

const randomDelay = () => 13000 + Math.floor(Math.random() * 2001); // 13000..15000 ms
const MAX_FAILURES = 3;

export async function getActivePresets(env) {
  const { results } = await env.DB.prepare(
    "SELECT id, text FROM preset_messages WHERE is_active = 1 ORDER BY sort_order, id"
  ).all();
  return results || [];
}

const unlockMarkup = (settings, requestId) =>
  inline([[btn(settings.unlock_button_text, `u:unlock:${requestId}`)]]);

async function rotationStub(env, chatId) {
  if (!env.ROTATION) return null;
  return env.ROTATION.get(env.ROTATION.idFromName(String(chatId)));
}

// `service` is the keyboard_buttons row the user just used. If the admin gave it its
// own preset message / button text, those win; otherwise the global ones are used.
export async function sendProcessingMessage(env, chatId, userId, requestId, service = null) {
  const settings = await getSettings(env);
  const unlockText = (service?.unlock_button_text || "").trim() || settings.unlock_button_text;
  const markup = unlockMarkup({ unlock_button_text: unlockText }, requestId);

  if (service?.preset_message && service.preset_message.trim()) {
    await stopRotation(env, chatId, false); // a fixed per-service message never rotates
    const res = await sendMessage(env, chatId, service.preset_message, markup);
    return messageIdOf(res);
  }

  const presets = await getActivePresets(env);
  const text = presets.length ? presets[0].text : settings.processing_message;
  const res = await sendMessage(env, chatId, text, markup);
  const messageId = messageIdOf(res);

  if (messageId && settings.preset_enabled === "1" && presets.length >= 2) {
    try {
      const stub = await rotationStub(env, chatId);
      if (stub) {
        await stub.fetch("https://rotation/start", {
          method: "POST",
          body: JSON.stringify({ chatId, userId: String(userId), requestId, lastMessageId: messageId, unlockText }),
        });
      }
    } catch (err) {
      console.error("Could not start preset rotation:", String(err));
    }
  }
  return messageId;
}

export async function stopRotation(env, chatId, deleteLast = false) {
  try {
    const stub = await rotationStub(env, chatId);
    if (stub) {
      await stub.fetch("https://rotation/stop", { method: "POST", body: JSON.stringify({ deleteLast }) });
    }
  } catch (err) {
    console.error("Could not stop preset rotation:", String(err));
  }
}

export class PresetRotation {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    const path = new URL(request.url).pathname;
    const body = request.method === "POST" ? await request.json().catch(() => ({})) : {};

    if (path === "/start") {
      await this.stop(true); // a newer request replaces the old preset message
      await this.state.storage.put("job", {
        chatId: body.chatId,
        userId: body.userId,
        requestId: body.requestId,
        lastMessageId: body.lastMessageId,
        unlockText: body.unlockText || null,
        idx: 1, // message #0 was already sent by sendProcessingMessage
        ticks: 1,
        failures: 0,
      });
      await this.state.storage.setAlarm(Date.now() + randomDelay());
      return new Response("started");
    }
    if (path === "/stop") {
      await this.stop(Boolean(body.deleteLast));
      return new Response("stopped");
    }
    return new Response("not found", { status: 404 });
  }

  async stop(deleteLast) {
    const job = await this.state.storage.get("job");
    if (job && deleteLast && job.lastMessageId) {
      await deleteMessage(this.env, job.chatId, job.lastMessageId);
    }
    await this.state.storage.deleteAlarm();
    await this.state.storage.deleteAll();
  }

  async alarm() {
    const job = await this.state.storage.get("job");
    if (!job) return;
    try {
      const env = this.env;
      const settings = await getSettings(env);
      const presets = await getActivePresets(env);
      const req = await env.DB.prepare("SELECT status FROM requests WHERE id = ?").bind(job.requestId).first();
      const waiting = req && req.status === "awaiting_payment";
      const subscribed = await getSubscription(env, job.userId);

      if (!waiting || subscribed) return await this.stop(true); // paid/answered: tidy up
      if (settings.preset_enabled !== "1" || presets.length < 2) return await this.stop(false);
      if (job.ticks >= (parseInt(settings.preset_max_ticks, 10) || 20)) return await this.stop(false);

      // 1) delete ONLY the previous preset message, 2) send the replacement.
      if (job.lastMessageId) {
        await deleteMessage(env, job.chatId, job.lastMessageId);
        job.lastMessageId = null;
      }
      const preset = presets[job.idx % presets.length];
      const res = await sendMessage(env, job.chatId, preset.text,
        unlockMarkup({ unlock_button_text: job.unlockText || settings.unlock_button_text }, job.requestId));
      const newId = messageIdOf(res);
      if (newId) {
        job.lastMessageId = newId;
        job.failures = 0;
      } else if (++job.failures >= MAX_FAILURES) {
        return await this.stop(false); // e.g. the user blocked the bot
      }
      job.idx += 1;
      job.ticks += 1;
      await this.state.storage.put("job", job);
      await this.state.storage.setAlarm(Date.now() + randomDelay());
    } catch (err) {
      console.error("Preset rotation error:", String(err));
      job.failures = (job.failures || 0) + 1;
      if (job.failures >= MAX_FAILURES) return await this.stop(false);
      await this.state.storage.put("job", job);
      await this.state.storage.setAlarm(Date.now() + randomDelay());
    }
  }
}
