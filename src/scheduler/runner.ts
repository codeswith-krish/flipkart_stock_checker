import { Cron } from "croner";
import { config } from "../config/index.js";
import { checkEngine, CheckEngine } from "../modules/checker/check-engine.js";
import { notificationDispatcher, NotificationDispatcher } from "../modules/notifier/dispatcher.js";
import { logger } from "../shared/logger.js";

export class SchedulerRunner {
  private cronJob: Cron | null = null;
  private retryCronJob: Cron | null = null;
  private isChecking: boolean = false;
  private engine: CheckEngine;
  private dispatcher: NotificationDispatcher;

  constructor(engine?: CheckEngine, dispatcher?: NotificationDispatcher) {
    this.engine = engine || checkEngine;
    this.dispatcher = dispatcher || notificationDispatcher;
  }

  start(): void {
    const cronPattern = config.CHECK_INTERVAL_CRON;
    logger.info(`Initializing scheduler with pattern: "${cronPattern}"`);

    // Startup sweep: immediately attempt dispatch of any pending notifications from previous runs
    this.dispatcher.dispatchPending().catch((err) => {
      logger.error("Error during scheduler startup notification sweep", err);
    });

    // Run first check cycle immediately upon startup
    this.executeCycle();

    // Primary check interval cron
    this.cronJob = new Cron(cronPattern, async () => {
      await this.executeCycle();
    });

    // 1-minute notification retry cron for pending/backoff notifications
    this.retryCronJob = new Cron("*/1 * * * *", async () => {
      try {
        await this.dispatcher.dispatchPending();
      } catch (error) {
        logger.error("Error during scheduled notification retry sweep", error);
      }
    });

    logger.info("Scheduler started successfully.");
  }

  async executeCycle(): Promise<void> {
    if (this.isChecking) {
      logger.warn("Previous check cycle is still running. Skipping current tick to prevent overlap.");
      return;
    }

    this.isChecking = true;
    try {
      await this.engine.runAllChecks();
      // Post-check cycle notification sweep
      await this.dispatcher.dispatchPending();
    } catch (error) {
      logger.error("Unhandled error during scheduled check cycle", error);
    } finally {
      this.isChecking = false;
    }
  }

  stop(): void {
    if (this.cronJob) {
      this.cronJob.stop();
      this.cronJob = null;
    }
    if (this.retryCronJob) {
      this.retryCronJob.stop();
      this.retryCronJob = null;
    }
    logger.info("Scheduler stopped.");
  }
}

export const schedulerRunner = new SchedulerRunner();
