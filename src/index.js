
import {
  handleAdmin,
  handlePaymentCallback
} from "./admin.js";

import { handleUser } from "./user.js";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return Response.json({
        ok: true,
        service: "telegram-service-bot",
        database: Boolean(env.DB)
      });
    }

    if (
      url.pathname !== "/telegram/webhook" ||
      request.method !== "POST"
    ) {
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

      // Handle payment approval/rejection button clicks
      if (update.callback_query) {
        const callback = update.callback_query;

        try {
          const result = await handlePaymentCallback(callback, env);

          await fetch(
            `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`,
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json"
              },
              body: JSON.stringify({
                callback_query_id: callback.id,
                text: result.message || "Processed"
              })
            }
          );
        } catch (error) {
          console.error("Callback error:", error);
        }

        return Response.json({ ok: true });
      }

      // Handle ordinary messages
      const message = update.message;

      if (!message) {
        return Response.json({ ok: true });
      }

      const handled = await handleAdmin(message, env);

      if (!handled) {
        await handleUser(env, message);
      }

      return Response.json({ ok: true });

    } catch (error) {
      console.error("Webhook error:", error);

      return Response.json(
        { ok: false },
        { status: 500 }
      );
    }
  }
};
