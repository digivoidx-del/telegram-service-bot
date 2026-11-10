
import { handleUser } from "./user.js";
import { handleAdmin } from "./admin.js";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return json({ ok: true, service: "telegram-service-bot" });
    }

    if (url.pathname !== "/telegram/webhook" || request.method !== "POST") {
      return json({ error: "Not found" }, 404);
    }

    if (
      request.headers.get("X-Telegram-Bot-Api-Secret-Token") !==
      env.TELEGRAM_WEBHOOK_SECRET
    ) {
      return json({ error: "Unauthorized" }, 401);
    }

    try {
      const update = await request.json();

      if (update.message) {
        const handled = await handleAdmin(env, update.message);

        if (!handled) {
          await handleUser(env, update.message);
        }
      }

      return json({ ok: true });
    } catch (error) {
      console.error("Webhook error:", error);
      return json({ ok: false }, 500);
    }
  }
};
