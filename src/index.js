
import { handleAdmin } from "./admin.js";
import { handleUser } from "./user.js";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return Response.json({ ok: true, database: Boolean(env.DB) });
    }

    if (url.pathname !== "/telegram/webhook" || request.method !== "POST") {
      return new Response("Not found", { status: 404 });
    }

    if (
      request.headers.get("X-Telegram-Bot-Api-Secret-Token") !==
      env.TELEGRAM_WEBHOOK_SECRET
    ) {
      return new Response("Unauthorized", { status: 401 });
    }

    try {
      const update = await request.json();
      const message = update.message;

      if (!message) return Response.json({ ok: true });

      const adminHandled = await handleAdmin(message, env);

      if (!adminHandled) {
        await handleUser(env, message);
      }

      return Response.json({ ok: true });
    } catch (error) {
      console.error("Webhook error:", error);
      return Response.json({ ok: false }, { status: 500 });
    }
  }
};
