import { handleAdminMessage, handleAdminCallback } from "./admin.js";
import { handleUserMessage, handleUserCallback } from "./user.js";
import { runBroadcastBatch } from "./broadcast.js";
import { answerCallback, tg } from "./telegram.js";

export { PresetRotation } from "./presets.js";

// Constant-time comparison so the secret can't be guessed from response timing.
function safeEqual(a, b) {
  a = String(a ?? ""); b = String(b ?? "");
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function processUpdate(env, ctx, update) {
  if (update.callback_query) {
    const cb = update.callback_query;
    let result = {};
    try {
      const data = String(cb.data || "");
      if (data.startsWith("a:") || data.startsWith("payment:")) result = await handleAdminCallback(env, ctx, cb);
      else if (data.startsWith("u:")) result = await handleUserCallback(env, cb);
      else result = { text: "Unknown button." };
    } catch (err) {
      console.error("Callback error:", err?.stack || String(err));
      result = { text: "Something went wrong. Please try again.", alert: true };
    }
    await answerCallback(env, cb.id, result?.text || "", Boolean(result?.alert));
    return;
  }

  const message = update.message;
  if (!message || !message.from || message.from.is_bot) return;
  if (message.chat?.type !== "private") return; // the bot only works in private chats

  try {
    if (await handleAdminMessage(env, ctx, message)) return;
    await handleUserMessage(env, message);
  } catch (err) {
    console.error("Message error:", err?.stack || String(err));
    await tg(env, "sendMessage", { chat_id: message.chat.id, text: "Something went wrong. Please try again in a moment." });
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/health") return new Response("ok");

    // One-time setup: open  https://YOUR-WORKER/setup?key=YOUR_WEBHOOK_SECRET  in a browser.
    if (url.pathname === "/setup") {
      if (!env.TELEGRAM_WEBHOOK_SECRET || !safeEqual(url.searchParams.get("key"), env.TELEGRAM_WEBHOOK_SECRET)) {
        return new Response("Forbidden", { status: 403 });
      }
      const hook = await tg(env, "setWebhook", {
        url: `${url.origin}/telegram/webhook`,
        secret_token: env.TELEGRAM_WEBHOOK_SECRET,
        allowed_updates: ["message", "callback_query"],
        drop_pending_updates: true,
      });
      await tg(env, "setMyCommands", {
        commands: [
          { command: "start", description: "Open the menu" },
          { command: "status", description: "Check my subscription" },
          { command: "cancel", description: "Cancel what I'm doing" },
          { command: "id", description: "Show my Telegram ID" },
        ],
      });
      return new Response(JSON.stringify({ webhook: hook, owner_configured: Boolean(env.OWNER_ID) }, null, 2), {
        headers: { "Content-Type": "application/json" },
      });
    }

    if (url.pathname === "/telegram/webhook" && request.method === "POST") {
      if (!env.TELEGRAM_WEBHOOK_SECRET ||
          !safeEqual(request.headers.get("X-Telegram-Bot-Api-Secret-Token"), env.TELEGRAM_WEBHOOK_SECRET)) {
        return new Response("Unauthorized", { status: 401 });
      }
      let update;
      try { update = await request.json(); } catch { return new Response("Bad request", { status: 400 }); }

      try {
        // Telegram re-sends an update if we are slow; handle each update_id only once.
        if (Number.isInteger(update.update_id)) {
          const seen = await env.DB.prepare("INSERT OR IGNORE INTO processed_updates (update_id) VALUES (?)").bind(update.update_id).run();
          if (seen.meta.changes === 0) return new Response("ok");
        }
        await processUpdate(env, ctx, update);
      } catch (err) {
        console.error("Webhook error:", err?.stack || String(err));
      }
      return new Response("ok"); // always 200 so Telegram does not keep retrying
    }

    return new Response("Not found", { status: 404 });
  },

  // Runs every minute.
  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      try {
        await runBroadcastBatch(env);
        await env.DB.prepare("DELETE FROM processed_updates WHERE created_at < datetime('now', '-1 day')").run();
      } catch (err) {
        console.error("Scheduled job error:", err?.stack || String(err));
      }
    })());
  },
};
