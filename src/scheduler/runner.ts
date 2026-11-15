import { Cron } from "croner";
import { config } from "../config/index.js";
import { checkEngine, CheckEngine } from "../modules/checker/check-engine.js";
import { notificationDispatcher, NotificationDispatcher } from "../modules/notifier/dispatcher.js";
import { closeBrowser } from "../modules/scraper/browser.js";
import { logger } from "../shared/logger.js";

export type SchedulerStatus = "RUNNING" | "STOPPING" | "STOPPED";

export class SchedulerRunner {
  private cronJob: Cron | null = null;
  private retryCronJob: Cron | null = null;
  private isChecking: boolean = false;
  private status: SchedulerStatus = "STOPPED";
  private activeCyclePromise: Promise<void> | null = null;
  private activeStartupPromise: Promise<void> | null = null;
  private activeRetryPromise: Promise<void> | null = null;

  private engine: CheckEngine;
  private dispatcher: NotificationDispatcher;

  constructor(engine?: CheckEngine, dispatcher?: NotificationDispatcher) {
    this.engine = engine || checkEngine;
    this.dispatcher = dispatcher || notificationDispatcher;
  }

  getStatus(): SchedulerStatus {
    return this.status;
  }

  start(): void {
    if (this.status === "RUNNING") {
      logger.warn("Scheduler is already running. Ignoring duplicate start() call.");
      return;
    }

    if (this.status === "STOPPING") {
      logger.warn("Scheduler is currently stopping. Cannot start until shutdown completes.");
      return;
    }

    this.status = "RUNNING";
    const cronPattern = config.CHECK_INTERVAL_CRON;
    logger.info(`Initializing scheduler with pattern: "${cronPattern}"`);

    // Startup sweep: immediately attempt dispatch of any pending notifications from previous runs
    const startupPromise = (async () => {
      try {
        await this.dispatcher.dispatchPending();
      } catch (err) {
        logger.error("Error during scheduler startup notification sweep", err);
      }
    })();

    this.activeStartupPromise = startupPromise;

    startupPromise.finally(() => {
      if (this.activeStartupPromise === startupPromise) {
        this.activeStartupPromise = null;
      }
    });

    // Run first check cycle immediately upon startup
    this.executeCycle().catch((error) => {
      logger.error("Error during initial check cycle execution", error);
    });

    // Primary check interval cron
    this.cronJob = new Cron(cronPattern, async () => {
      if (this.status !== "RUNNING") return;
      await this.executeCycle();
    });

    // 1-minute notification retry cron for pending/backoff notifications
    this.retryCronJob = new Cron("*/1 * * * *", async () => {
      if (this.status !== "RUNNING") return;
      const retryPromise = (async () => {
        try {
          await this.dispatcher.dispatchPending();
        } catch (error) {
          logger.error("Error during scheduled notification retry sweep", error);
        }
      })();

      this.activeRetryPromise = retryPromise;

      retryPromise.finally(() => {
        if (this.activeRetryPromise === retryPromise) {
          this.activeRetryPromise = null;
        }
      });

      await retryPromise;
    });

    logger.info("Scheduler started successfully.");
  }

  async executeCycle(): Promise<void> {
    if (this.isChecking) {
      logger.warn("Previous check cycle is still running. Skipping current tick to prevent overlap.");
      return;
    }

    if (this.status === "STOPPING") {
      logger.debug("Scheduler is currently stopping. Skipping check cycle execution.");
      return;
    }

    this.isChecking = true;
    const cyclePromise = (async () => {
      try {
        // Run all sequential checks and guarantee Chromium is closed in finally
        try {
          await this.engine.runAllChecks();
        } finally {
          // Release Chromium memory resources immediately before Telegram network dispatch
          await closeBrowser();
        }

        // Post-check cycle notification sweep (only if not stopping)
        if (this.status !== "STOPPING") {
          await this.dispatcher.dispatchPending();
        }
      } catch (error) {
        logger.error("Unhandled error during scheduled check cycle", error);
      } finally {
        this.isChecking = false;
      }
    })();

    this.activeCyclePromise = cyclePromise;

    cyclePromise.finally(() => {
      if (this.activeCyclePromise === cyclePromise) {
        this.activeCyclePromise = null;
      }
    });

    await cyclePromise;
  }

  async stop(timeoutMs: number = 10000): Promise<boolean> {
    if (this.status === "STOPPED") {
      return true;
    }

    this.status = "STOPPING";
    logger.info("Stopping scheduler...");

    // Stop cron schedules immediately to prevent new ticks
    if (this.cronJob) {
      this.cronJob.stop();
      this.cronJob = null;
    }
    if (this.retryCronJob) {
      this.retryCronJob.stop();
      this.retryCronJob = null;
    }

    // Collect active in-flight promises
    const inFlight: Promise<unknown>[] = [];
    if (this.activeCyclePromise) inFlight.push(this.activeCyclePromise);
    if (this.activeStartupPromise) inFlight.push(this.activeStartupPromise);
    if (this.activeRetryPromise) inFlight.push(this.activeRetryPromise);

    if (inFlight.length === 0) {
      this.status = "STOPPED";
      logger.info("Scheduler stopped cleanly (no in-flight operations).");
      return true;
    }

    logger.info(`Waiting up to ${timeoutMs}ms for ${inFlight.length} in-flight operations to complete...`);

    let timeoutHandle: NodeJS.Timeout | null = null;
    const timeoutPromise = new Promise<"timed_out">((resolve) => {
      timeoutHandle = setTimeout(() => resolve("timed_out"), timeoutMs);
      if (timeoutHandle.unref) {
        timeoutHandle.unref();
      }
    });

    try {
      const raceResult = await Promise.race([
        Promise.allSettled(inFlight).then(() => "completed" as const),
        timeoutPromise,
      ]);

      if (raceResult === "timed_out") {
        logger.warn(
          `Scheduler stop() timed out after ${timeoutMs}ms. Some operations may still be running in background.`
        );
        return false;
      }

      this.status = "STOPPED";
      logger.info("Scheduler stopped cleanly.");
      return true;
    } finally {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    }
  }
}

export const schedulerRunner = new SchedulerRunner();
