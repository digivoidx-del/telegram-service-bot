-- New tables + indexes. Safe to run on a database that already has your
-- manual changes: everything is "IF NOT EXISTS".

-- People who have talked to the bot (needed for broadcasts).
CREATE TABLE IF NOT EXISTS users (
    telegram_user_id TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL,
    username TEXT,
    first_name TEXT,
    is_blocked INTEGER DEFAULT 0,
    first_seen TEXT DEFAULT CURRENT_TIMESTAMP,
    last_seen TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Admin-defined rotating "processing" messages.
CREATE TABLE IF NOT EXISTS preset_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    text TEXT NOT NULL,
    sort_order INTEGER DEFAULT 0,
    is_active INTEGER DEFAULT 1
);

-- What an admin is in the middle of typing (e.g. a new service name).
CREATE TABLE IF NOT EXISTS admin_state (
    telegram_user_id TEXT PRIMARY KEY,
    state TEXT NOT NULL,
    data TEXT,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Broadcast jobs (sent in small batches so Telegram limits are respected).
CREATE TABLE IF NOT EXISTS broadcast_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    text TEXT NOT NULL,
    audience TEXT NOT NULL DEFAULT 'all',
    status TEXT NOT NULL DEFAULT 'running',
    last_rowid INTEGER NOT NULL DEFAULT 0,
    sent INTEGER NOT NULL DEFAULT 0,
    failed INTEGER NOT NULL DEFAULT 0,
    created_by TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Remembers which Telegram updates were already handled (stops double-processing).
CREATE TABLE IF NOT EXISTS processed_updates (
    update_id INTEGER PRIMARY KEY,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- One subscription per approved payment, no matter how many times Approve is tapped.
CREATE UNIQUE INDEX IF NOT EXISTS idx_subscriptions_payment_review_unique
    ON subscriptions(payment_review_id) WHERE payment_review_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_subscriptions_user ON subscriptions(telegram_user_id, status);
CREATE INDEX IF NOT EXISTS idx_requests_user_status ON requests(telegram_user_id, status);
CREATE INDEX IF NOT EXISTS idx_requests_status ON requests(status);
CREATE INDEX IF NOT EXISTS idx_payment_reviews_status ON payment_reviews(status);
CREATE INDEX IF NOT EXISTS idx_payment_reviews_user ON payment_reviews(telegram_user_id, status);
CREATE INDEX IF NOT EXISTS idx_buttons_active ON keyboard_buttons(is_active, sort_order);
