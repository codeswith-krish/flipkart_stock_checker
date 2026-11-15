import path from "node:path";
import { ProductRepository } from "../../db/repositories/product.repository.js";
import { telegramNotifier } from "./telegram.js";
import type { INotifier } from "./types.js";
import { formatCartSuccessMessage } from "./templates.js";
import { logger } from "../../shared/logger.js";
import { config } from "../../config/index.js";
import { acquireProcessLock, releaseProcessLock } from "../checker/process-lock.js";

export interface DispatchSummary {
  totalPending: number;
  dispatchedCount: number;
  failedCount: number;
  skippedCount: number;
  lockAcquired: boolean;
  abortedDueToRateLimit?: boolean;
}

export class NotificationDispatcher {
  private productRepo: ProductRepository;
  private notifier: INotifier;
  private lockFilePath: string;
  private chatId: string;
  private pacingDelayMs: number;

  constructor(
    productRepo?: ProductRepository,
    notifier?: INotifier,
    lockFilePath?: string,
    pacingDelayMs: number = 1000,
    chatId?: string
  ) {
    this.productRepo = productRepo || new ProductRepository();
    this.notifier = notifier || telegramNotifier;
    this.chatId = chatId || config.TELEGRAM_CHAT_ID;
    this.pacingDelayMs = pacingDelayMs;

    const baseDataDir =
      config.DATABASE_PATH && config.DATABASE_PATH !== ":memory:"
        ? path.dirname(config.DATABASE_PATH)
        : path.join(process.cwd(), "data");

    this.lockFilePath = lockFilePath || path.join(baseDataDir, ".dispatcher_execution_lock.sqlite");
  }

  /**
   * Sweeps the database for pending notifications, respects cross-process locks,
   * rate limits, and per-chat cooldowns, and updates delivery states atomically via CAS.
   */
  async dispatchPending(): Promise<DispatchSummary> {
    const lock = acquireProcessLock(this.lockFilePath);
    if (!lock.acquired) {
      logger.info("Notification dispatch sweep skipped: Lock actively held by another process.");
      return {
        totalPending: 0,
        dispatchedCount: 0,
        failedCount: 0,
        skippedCount: 0,
        lockAcquired: false,
      };
    }

    try {
      const now = new Date().toISOString();

      // 1. Persistent Shared Chat Cooldown Check
      const activeCooldown = this.productRepo.getChatCooldown(this.chatId, now);
      if (activeCooldown) {
        logger.warn(
          `Telegram dispatch suppressed: Chat ${this.chatId} is under cooldown until ${activeCooldown}.`
        );
        return {
          totalPending: 0,
          dispatchedCount: 0,
          failedCount: 0,
          skippedCount: 0,
          lockAcquired: true,
          abortedDueToRateLimit: true,
        };
      }

      // 2. Fetch pending candidates
      const candidates = this.productRepo.findPendingNotifications(now);
      if (candidates.length === 0) {
        return {
          totalPending: 0,
          dispatchedCount: 0,
          failedCount: 0,
          skippedCount: 0,
          lockAcquired: true,
        };
      }

      logger.info(`Found ${candidates.length} candidate notification(s) pending dispatch.`);

      let dispatchedCount = 0;
      let failedCount = 0;
      let skippedCount = 0;
      let abortedDueToRateLimit = false;

      // 3. Process candidates sequentially
      for (let i = 0; i < candidates.length; i++) {
        const candidate = candidates[i];

        // Re-check chat cooldown before each message transmission
        const currentCheckTime = new Date().toISOString();
        if (this.productRepo.getChatCooldown(this.chatId, currentCheckTime)) {
          logger.warn(
            `Telegram dispatch aborted: Chat ${this.chatId} entered cooldown during batch processing.`
          );
          abortedDueToRateLimit = true;
          break;
        }

        // Re-verify product state directly from SQLite to guard against concurrent check changes
        const fresh = this.productRepo.findById(candidate.id);
        if (
          !fresh ||
          !fresh.isActive ||
          fresh.notificationState !== "PENDING" ||
          fresh.cartAvailability !== "AVAILABLE" ||
          fresh.notificationCycle !== candidate.notificationCycle ||
          fresh.retryCount >= 5
        ) {
          logger.debug(
            `Product ID ${candidate.id} no longer qualifies for dispatch (state modified). Skipping.`
          );
          skippedCount++;
          continue;
        }

        // Inter-message pacing delay (1000ms by default, 0ms in fast tests)
        if (dispatchedCount > 0 && this.pacingDelayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, this.pacingDelayMs));
        }

        // Format and transmit notification
        const messageText = formatCartSuccessMessage(fresh);
        const result = await this.notifier.sendMessageWithResult(messageText);

        if (result.status === "SUCCESS") {
          const sentAt = new Date().toISOString();
          const casUpdated = this.productRepo.markNotificationDelivered(
            fresh.id,
            fresh.notificationCycle,
            sentAt
          );

          if (casUpdated) {
            dispatchedCount++;
            logger.info(
              `Alert delivered and recorded for product ${fresh.id} (Cycle: ${fresh.notificationCycle}).`
            );
          } else {
            logger.warn(
              `Stale CAS delivery update for product ${fresh.id}; state changed concurrently during dispatch.`
            );
            skippedCount++;
          }
        } else if (result.status === "RATE_LIMIT") {
          failedCount++;
          const retryAfter = result.retryAfterSeconds || 30;
          this.productRepo.setChatCooldown(this.chatId, retryAfter);
          this.productRepo.recordNotificationFailure(fresh.id, fresh.notificationCycle, {
            error: result.error || `HTTP 429 Rate Limited: retry after ${retryAfter}s`,
            isPermanent: false,
          });

          logger.warn(
            `Batch dispatch aborted due to Telegram rate limit (HTTP 429). Cooldown: ${retryAfter}s.`
          );
          abortedDueToRateLimit = true;
          break; // Abort remaining batch items immediately
        } else if (result.status === "PERMANENT_FAILURE") {
          failedCount++;
          this.productRepo.recordNotificationFailure(fresh.id, fresh.notificationCycle, {
            error: result.error || "Permanent delivery failure",
            isPermanent: true,
          });

          logger.error(
            `Permanent delivery failure for product ${fresh.id}. Notification cycle suspended.`
          );
        } else {
          // TEMPORARY_FAILURE or UNKNOWN_DELIVERY
          failedCount++;
          this.productRepo.recordNotificationFailure(fresh.id, fresh.notificationCycle, {
            error: result.error || "Temporary delivery failure",
            isPermanent: false,
          });

          logger.warn(
            `Temporary delivery failure for product ${fresh.id}. Authoritative retry scheduled.`
          );
        }
      }

      return {
        totalPending: candidates.length,
        dispatchedCount,
        failedCount,
        skippedCount,
        lockAcquired: true,
        abortedDueToRateLimit,
      };
    } finally {
      if (lock.token) {
        releaseProcessLock(this.lockFilePath, lock.token);
      }
    }
  }
}

export const notificationDispatcher = new NotificationDispatcher();
