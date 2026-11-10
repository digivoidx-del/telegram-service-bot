
import { handleAdmin } from "./admin.js";
import { sendMessage } from "./telegram.js";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return Response.json({ ok: true, service: "telegram-service-bot" });
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

      if (!message?.text) {
        return Response.json({ ok: true });
      }

      const handled = await handleAdmin(message, env);

      if (!handled && message.text === "/start") {
        await sendMessage(
          env,
          message.chat.id,
          "Welcome! The service bot is being configured."
        );
      }

      return Response.json({ ok: true });
    } catch (error) {
      console.error("Webhook error:", error);
      return Response.json({ ok: false }, { status: 500 });
    }
  }
};
