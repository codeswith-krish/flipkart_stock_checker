import type { Database as DatabaseInstance } from "better-sqlite3";
import fs from "node:fs";
import { getDb } from "./client.js";
import { SCHEMA_SQL } from "./schema.js";
import { DatabaseError } from "../shared/errors.js";
import { logger } from "../shared/logger.js";
import { config } from "../config/index.js";

interface ColumnInfo {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

export function runMigrations(db?: DatabaseInstance): void {
  const database = db || getDb();

  try {
    logger.info("Executing safe database migrations...");

    // 1. Safe backup check for existing disk database
    // Only perform disk backup when running against the persistent database, never for in-memory test databases
    const dbPath = config.DATABASE_PATH;
    const isDiskDatabase = !db && database.name !== ":memory:" && dbPath !== ":memory:";

    if (isDiskDatabase && fs.existsSync(dbPath)) {
      const stats = fs.statSync(dbPath);
      if (stats.size > 0) {
        const backupPath = `${dbPath}.bak-${Date.now()}`;
        try {
          // Flush any pending WAL frames to the main database file before copying
          database.pragma("wal_checkpoint(TRUNCATE)");
          fs.copyFileSync(dbPath, backupPath);
          logger.info(`Existing database safely backed up to: ${backupPath}`);
        } catch (backupErr) {
          logger.warn("Could not create database backup before migration", backupErr);
        }
      }
    }

    // 2. Check if products table exists
    const tableExists = database
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='products'")
      .get() as { name: string } | undefined;

    if (!tableExists) {
      // Clean creation if table does not exist
      database.exec(SCHEMA_SQL);
      logger.info("Created products table with minimal schema.");
    } else {
      // Non-destructive column addition for existing database
      const existingColumns = database
        .prepare("PRAGMA table_info(products)")
        .all() as ColumnInfo[];
      const columnNames = new Set(existingColumns.map((col) => col.name.toLowerCase()));

      const desiredColumns: { name: string; ddl: string }[] = [
        { name: "product_id", ddl: "ALTER TABLE products ADD COLUMN product_id TEXT" },
        { name: "cart_availability", ddl: "ALTER TABLE products ADD COLUMN cart_availability TEXT NOT NULL DEFAULT 'UNKNOWN'" },
        { name: "last_check_status", ddl: "ALTER TABLE products ADD COLUMN last_check_status TEXT NOT NULL DEFAULT 'NEVER_CHECKED'" },
        { name: "last_error_message", ddl: "ALTER TABLE products ADD COLUMN last_error_message TEXT" },
        { name: "notification_state", ddl: "ALTER TABLE products ADD COLUMN notification_state TEXT NOT NULL DEFAULT 'IDLE'" },
        { name: "last_alert_sent_at", ddl: "ALTER TABLE products ADD COLUMN last_alert_sent_at TEXT" },
        { name: "last_checked_at", ddl: "ALTER TABLE products ADD COLUMN last_checked_at TEXT" },
        { name: "notification_cycle", ddl: "ALTER TABLE products ADD COLUMN notification_cycle INTEGER NOT NULL DEFAULT 0" },
        { name: "retry_count", ddl: "ALTER TABLE products ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0" },
        { name: "next_retry_at", ddl: "ALTER TABLE products ADD COLUMN next_retry_at TEXT" },
        { name: "last_delivery_error", ddl: "ALTER TABLE products ADD COLUMN last_delivery_error TEXT" },
      ];

      database.transaction(() => {
        for (const col of desiredColumns) {
          if (!columnNames.has(col.name.toLowerCase())) {
            logger.info(`Adding missing column to products: ${col.name}`);
            database.exec(col.ddl);
          }
        }

        // Ensure indexes and auxiliary tables exist non-destructively
        database.exec(`
          CREATE INDEX IF NOT EXISTS idx_products_active ON products(is_active);
          CREATE UNIQUE INDEX IF NOT EXISTS idx_products_url ON products(url);
          CREATE INDEX IF NOT EXISTS idx_products_product_id ON products(product_id);
          CREATE INDEX IF NOT EXISTS idx_products_pending_dispatch ON products(notification_state, is_active, cart_availability, retry_count, next_retry_at);
          CREATE TABLE IF NOT EXISTS chat_cooldowns (
            chat_id TEXT PRIMARY KEY,
            cooldown_until TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );
        `);
      })();
      logger.info("Products table verified and upgraded safely.");
    }

    // 3. Inspect if legacy price_history table exists; preserve it without dropping data
    const legacyHistoryExists = database
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='price_history'")
      .get() as { name: string } | undefined;

    if (legacyHistoryExists) {
      logger.info(
        "Preserving existing price_history table data without destructive deletion."
      );
    }

    logger.info("Database migrations completed successfully without data loss.");
  } catch (error) {
    throw new DatabaseError("Failed to execute database migrations safely", error);
  }
}
