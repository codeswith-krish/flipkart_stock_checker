import { runMigrations } from "../db/migrations.js";
import { schedulerRunner } from "./runner.js";
import { closeDb } from "../db/client.js";
import { closeBrowser } from "../modules/scraper/browser.js";
import { logger } from "../shared/logger.js";

let isShuttingDown = false;

export async function shutdown(signal: string, exitCode = 0): Promise<void> {
  if (isShuttingDown) {
    logger.warn(`Shutdown already in progress. Ignoring additional signal: ${signal}`);
    return;
  }
  isShuttingDown = true;
  logger.info(`Received ${signal}. Shutting down gracefully...`);

  // Hard watchdog timer: if graceful shutdown hangs beyond 15 seconds, force exit
  const watchdog = setTimeout(() => {
    logger.error("Graceful shutdown watchdog timer expired (15s). Forcing immediate termination.");
    process.exit(1);
  }, 15000);
  if (watchdog.unref) {
    watchdog.unref();
  }

  try {
    const clean = await schedulerRunner.stop(10000);

    if (!clean) {
      logger.error(
        "Active operations did not drain within 10s shutdown deadline. Skipping database closure to avoid state corruption."
      );
      process.exit(1);
      return;
    }

    await closeBrowser();
    closeDb();
    logger.info("Cleanup completed successfully. Exiting.");
    process.exit(exitCode);
  } catch (error) {
    logger.error("Unhandled error during shutdown sequence", error);
    process.exit(1);
  } finally {
    clearTimeout(watchdog);
  }
}

export function _resetShutdownStateForTesting(): void {
  isShuttingDown = false;
}

export async function main(): Promise<void> {
  logger.info("Starting Stock Checker Background Daemon...");

  // Ensure DB tables exist
  runMigrations();

  // Start scheduler loop
  schedulerRunner.start();

  process.on("SIGINT", () => {
    shutdown("SIGINT", 0).catch((err) => {
      logger.error("Error during SIGINT shutdown", err);
      process.exit(1);
    });
  });

  process.on("SIGTERM", () => {
    shutdown("SIGTERM", 0).catch((err) => {
      logger.error("Error during SIGTERM shutdown", err);
      process.exit(1);
    });
  });

  process.on("unhandledRejection", (reason) => {
    logger.error("Unhandled Promise Rejection detected", reason);
    shutdown("unhandledRejection", 1).catch(() => process.exit(1));
  });

  process.on("uncaughtException", (error) => {
    logger.error("Uncaught Exception detected", error);
    shutdown("uncaughtException", 1).catch(() => process.exit(1));
  });
}

// Auto-run daemon unless executing inside a test runner
if (process.env.NODE_ENV !== "test") {
  main().catch((err) => {
    logger.error("Fatal daemon startup error", err);
    process.exit(1);
  });
}
