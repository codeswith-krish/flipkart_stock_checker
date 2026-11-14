import Database, { type Database as DatabaseInstance } from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { config } from "../config/index.js";
import { DatabaseError } from "../shared/errors.js";
import { logger } from "../shared/logger.js";

let dbInstance: DatabaseInstance | null = null;

export function getDb(customPath?: string): DatabaseInstance {
  if (dbInstance && !customPath) {
    return dbInstance;
  }

  const dbPath = customPath || config.DATABASE_PATH;

  try {
    if (dbPath !== ":memory:") {
      const dir = path.dirname(dbPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }

    const db = new Database(dbPath);

    // Optimize SQLite for concurrent reading and write resilience
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    db.pragma("busy_timeout = 5000");

    if (!customPath) {
      dbInstance = db;
    }

    logger.debug(`Database initialized at: ${dbPath}`);
    return db;
  } catch (error) {
    throw new DatabaseError(`Failed to connect to SQLite database at ${dbPath}`, error);
  }
}

export function closeDb(): void {
  if (dbInstance) {
    try {
      dbInstance.close();
      logger.debug("Database connection closed");
    } catch (error) {
      logger.error("Error closing database connection", error);
    } finally {
      dbInstance = null;
    }
  }
}
