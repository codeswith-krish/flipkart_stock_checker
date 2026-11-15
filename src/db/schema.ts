export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  url TEXT NOT NULL UNIQUE,
  product_id TEXT,
  title TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  cart_availability TEXT NOT NULL DEFAULT 'UNKNOWN',
  last_check_status TEXT NOT NULL DEFAULT 'NEVER_CHECKED',
  last_error_message TEXT,
  notification_state TEXT NOT NULL DEFAULT 'IDLE',
  last_alert_sent_at TEXT,
  last_checked_at TEXT,
  notification_cycle INTEGER NOT NULL DEFAULT 0,
  retry_count INTEGER NOT NULL DEFAULT 0,
  next_retry_at TEXT,
  last_delivery_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_products_active ON products(is_active);
CREATE UNIQUE INDEX IF NOT EXISTS idx_products_url ON products(url);
CREATE INDEX IF NOT EXISTS idx_products_product_id ON products(product_id);
CREATE INDEX IF NOT EXISTS idx_products_pending_dispatch ON products(notification_state, is_active, cart_availability, retry_count, next_retry_at);

CREATE TABLE IF NOT EXISTS chat_cooldowns (
  chat_id TEXT PRIMARY KEY,
  cooldown_until TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;
