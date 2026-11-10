
CREATE TABLE IF NOT EXISTS admins (
    telegram_user_id TEXT PRIMARY KEY,
    is_active INTEGER DEFAULT 1
);

CREATE TABLE IF NOT EXISTS bot_settings (
    setting_key TEXT PRIMARY KEY,
    setting_value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS keyboard_buttons (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    label TEXT NOT NULL,
    prompt TEXT DEFAULT '',
    validation_pattern TEXT,
    validation_help TEXT,
    sort_order INTEGER DEFAULT 0,
    is_active INTEGER DEFAULT 1
);

CREATE TABLE IF NOT EXISTS user_sessions (
    telegram_user_id TEXT PRIMARY KEY,
    state TEXT DEFAULT 'idle',
    selected_button_id INTEGER,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_user_id TEXT NOT NULL,
    username TEXT,
    button_id INTEGER,
    submitted_text TEXT NOT NULL,
    status TEXT DEFAULT 'awaiting_unlock',
    admin_reply TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    replied_at TEXT
);

CREATE TABLE IF NOT EXISTS subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_user_id TEXT NOT NULL,
    plan TEXT NOT NULL,
    starts_at TEXT NOT NULL,
    expires_at TEXT,
    status TEXT DEFAULT 'active'
);

CREATE TABLE IF NOT EXISTS payment_reviews (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_user_id TEXT NOT NULL,
    plan TEXT NOT NULL,
    method TEXT NOT NULL,
    amount_minor INTEGER NOT NULL,
    currency TEXT DEFAULT 'INR',
    proof_file_id TEXT,
    transaction_reference TEXT,
    status TEXT DEFAULT 'pending',
    reviewed_by TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
