import { Cron } from "croner";
import { config } from "../config/index.js";
import { checkEngine } from "../modules/checker/check-engine.js";
import { logger } from "../shared/logger.js";

export class SchedulerRunner {
  private cronJob: Cron | null = null;
  private isChecking: boolean = false;

  start(): void {
    const cronPattern = config.CHECK_INTERVAL_CRON;
    logger.info(`Initializing scheduler with pattern: "${cronPattern}"`);

    // Run first check cycle immediately upon startup
    this.executeCycle();

    this.cronJob = new Cron(cronPattern, async () => {
      await this.executeCycle();
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
      await checkEngine.runAllChecks();
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
      logger.info("Scheduler stopped.");
    }
  }
}

export const schedulerRunner = new SchedulerRunner();
