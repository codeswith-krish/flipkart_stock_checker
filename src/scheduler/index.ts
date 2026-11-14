import { runMigrations } from "../db/migrations.js";
import { schedulerRunner } from "./runner.js";
import { closeDb } from "../db/client.js";
import { closeBrowser } from "../modules/scraper/browser.js";
import { logger } from "../shared/logger.js";

async function main(): Promise<void> {
  logger.info("Starting Stock Checker Background Daemon...");

  // Ensure DB tables exist
  runMigrations();

  // Start 5-minute scheduler loop
  schedulerRunner.start();

  // Graceful shutdown handling
  const shutdown = async (signal: string) => {
    logger.info(`Received ${signal}. Shutting down gracefully...`);
    schedulerRunner.stop();
    await closeBrowser();
    closeDb();
    logger.info("Cleanup completed. Exiting.");
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  logger.error("Fatal daemon startup error", err);
  process.exit(1);
});
