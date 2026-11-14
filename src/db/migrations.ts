import type { Database as DatabaseInstance } from "better-sqlite3";
import { getDb } from "./client.js";
import { SCHEMA_SQL } from "./schema.js";
import { DatabaseError } from "../shared/errors.js";
import { logger } from "../shared/logger.js";

export function runMigrations(db?: DatabaseInstance): void {
  const database = db || getDb();
  try {
    logger.info("Running database migrations...");
    database.exec(SCHEMA_SQL);
    logger.info("Database migrations completed successfully.");
  } catch (error) {
    throw new DatabaseError("Failed to run database migrations", error);
  }
}
