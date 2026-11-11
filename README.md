# Telegram Service Bot

A configurable Telegram service + subscription bot on **Cloudflare Workers + D1**.
Everything (services, prices, payment details, preset messages, admins, broadcasts) is managed
from the **admin panel inside Telegram** — nothing is hard-coded.

## How it works
1. User taps a service button, answers the prompt, input is checked against the admin's pattern.
2. Without a subscription the request is saved but **not shown to admins**. The user sees a preset
   message with an **Unlock It** button (rotating every 13–15 s if 2+ presets exist).
3. User picks Monthly / Lifetime, then UPI (dynamic QR + Payment Done + screenshot) or Crypto (reference).
4. All active admins get the proof with **Approve / Reject**. Only an approved payment creates a
   subscription (once — enforced by a UNIQUE index) and releases the user's waiting requests.
5. Admin replies with the **Reply** button or `/reply ID text`; the answer goes to the user privately.

## Admin commands
`/admin` panel · `/reply ID text` · `/admin_requests` · `/admin_payments` · `/admin_buttons` · `/cancel`
Users: `/start` `/status` `/cancel` `/id`

## Secrets (Cloudflare dashboard → Worker → Settings → Variables and Secrets, type *Secret*)
| Name | Value |
|---|---|
| `TELEGRAM_BOT_TOKEN` | token from @BotFather |
| `TELEGRAM_WEBHOOK_SECRET` | any long random text (letters, numbers, `_` `-`) |
| `OWNER_ID` | your numeric Telegram ID (send `/id` to the bot) — the first admin |
| `FETCH_BUDGET` *(optional)* | Telegram calls per minute for broadcasts (default 40) |

## Database
Run `migrations/0001_init.sql`, then `migrations/0002_features.sql` (D1 → your database → Console).
Both are safe to re-run. On an existing database, check first:
`PRAGMA table_info(user_sessions);` must list `payment_plan`, `payment_method`, and
`PRAGMA table_info(subscriptions);` must list `payment_review_id`.

## Register the webhook
Open `https://YOUR-WORKER.workers.dev/setup?key=YOUR_TELEGRAM_WEBHOOK_SECRET` once.

## Good to know
- Payments are **manually verified**: a screenshot is not proof. Check your bank/wallet before approving.
- The dynamic UPI QR image is rendered by the free service api.qrserver.com (your UPI ID and the amount are
  sent to it). If it is unreachable, users get the UPI ID as text instead.
- Rotating presets use a Durable Object (needs a Workers plan that supports Durable Objects; the
  free plan supports SQLite-backed ones). With only 1 active preset the message is shown but not rotated.
- Broadcasts are sent in batches each minute. On the free plan Cloudflare allows 50 outgoing calls per run.
- Keep services limited to information users are entitled to receive. You are responsible for what you
  configure and who you serve.

## Tests
`npm test` runs the whole user/admin/payment journey against an in-memory SQLite database and a fake Telegram.
