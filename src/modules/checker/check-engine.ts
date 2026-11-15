import path from "node:path";
import { ProductRepository } from "../../db/repositories/product.repository.js";
import { flipkartScraper } from "../scraper/flipkart.js";
import { telegramNotifier } from "../notifier/telegram.js";
import type { IScraper } from "../scraper/types.js";
import type { INotifier } from "../notifier/types.js";
import type { CheckResult, Product } from "../../types/index.js";
import type { CheckCycleSummary } from "./types.js";
import { AppError, DatabaseError } from "../../shared/errors.js";
import { logger } from "../../shared/logger.js";
import { config } from "../../config/index.js";
import { acquireProcessLock, releaseProcessLock } from "./process-lock.js";

export interface SingleCheckOptions {
  isInternalCycleCall?: boolean;
}

export class CheckEngine {
  private productRepo: ProductRepository;
  private scraper: IScraper;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  private notifier?: INotifier;
  private lockFilePath: string;
  private activeChecks: Set<number> = new Set();
  private isCycleRunning: boolean = false;

  constructor(
    productRepo?: ProductRepository,
    scraper?: IScraper,
    notifier?: INotifier,
    lockFilePath?: string
  ) {
    this.productRepo = productRepo || new ProductRepository();
    this.scraper = scraper || flipkartScraper;
    this.notifier = notifier || telegramNotifier;

    const baseDataDir = config.DATABASE_PATH && config.DATABASE_PATH !== ":memory:"
      ? path.dirname(config.DATABASE_PATH)
      : path.join(process.cwd(), "data");

    this.lockFilePath = lockFilePath || path.join(baseDataDir, ".execution_lock.sqlite");
  }

  /**
   * Sanitizes error messages by redacting sensitive tokens, cookies, credentials, and internal paths.
   */
  public sanitizeError(raw: unknown): string {
    if (!raw) return "Unknown check error";
    const message = typeof raw === "string" ? raw : (raw as Error).message || String(raw);

    let sanitized = message.replace(
      /(cookie|token|auth|bearer|password|session|secret|credential|key)[=:\s]+[^\s,;&]+/gi,
      "$1=[REDACTED]"
    );

    sanitized = sanitized.replace(/[\w\-./\\ ]*flipkart_session\.json/gi, "[SESSION_STORAGE_PATH]");

    if (sanitized.length > 500) {
      sanitized = sanitized.slice(0, 497) + "...";
    }

    return sanitized.trim();
  }

  /**
   * Runs an Add-to-Cart availability check for a single product.
   * Reloads the authoritative record from SQLite, validates active status,
   * enforces concurrency locks, and updates SQLite state atomically.
   */
  async runSingleCheck(
    productOrId: number | Product,
    options?: SingleCheckOptions
  ): Promise<CheckResult> {
    const productId = typeof productOrId === "number" ? productOrId : productOrId.id;

    if (!productId || typeof productId !== "number") {
      throw new AppError("Invalid product ID provided for check", "INVALID_PRODUCT_ID");
    }

    // Always reload the authoritative product record directly from SQLite
    const product = this.productRepo.findById(productId);
    if (!product) {
      throw new AppError(`Product with ID ${productId} not found`, "PRODUCT_NOT_FOUND");
    }

    if (!product.isActive) {
      throw new AppError(`Product with ID ${productId} is inactive`, "PRODUCT_INACTIVE");
    }

    // Guard against concurrency collisions within the instance
    if (!options?.isInternalCycleCall && this.isCycleRunning) {
      throw new AppError(
        "A full check cycle is currently running; single check cannot execute concurrently",
        "CONCURRENT_CYCLE_CONFLICT"
      );
    }

    if (this.activeChecks.has(productId)) {
      throw new AppError(
        `Check for product ID ${productId} is already in progress`,
        "CONCURRENT_CHECK_CONFLICT"
      );
    }

    // Cross-process lock when executed as standalone check
    let processLockToken: string | null = null;
    if (!options?.isInternalCycleCall && this.lockFilePath !== ":memory:") {
      const lockAcq = acquireProcessLock(this.lockFilePath);
      if (!lockAcq.acquired) {
        throw new AppError(
          `Cannot execute check: ${lockAcq.reason || "cross-process lock contention"}`,
          "CONCURRENT_PROCESS_CONFLICT"
        );
      }
      processLockToken = lockAcq.token || null;
    }

    this.activeChecks.add(productId);

    try {
      logger.info(`Executing check for product ID ${product.id}: "${product.title}" (${product.url})`);

      const scraperResult = await this.scraper.checkCartAvailability(
        product.url,
        product.productId
      );

      if (scraperResult.checkStatus === "SUCCESS") {
        this.productRepo.updateCheckResult(product.id, {
          checkStatus: "SUCCESS",
          cartAvailability: scraperResult.cartAvailability,
          checkedAt: scraperResult.checkedAt,
        });

        // Re-read authoritative record to derive notificationQueued from committed DB state
        const updatedProduct = this.productRepo.findById(product.id)!;
        const notificationQueued =
          product.notificationState === "IDLE" && updatedProduct.notificationState === "PENDING";

        logger.info(
          `Check SUCCESS for ID ${product.id}: availability=${updatedProduct.cartAvailability}, reason=${scraperResult.reason || "N/A"}, notificationQueued=${notificationQueued}`
        );

        return {
          productId: product.id,
          url: product.url,
          cartAvailability: updatedProduct.cartAvailability,
          checkStatus: "SUCCESS",
          alertTriggered: notificationQueued,
          notificationQueued,
          reason: scraperResult.reason,
        };
      }

      // Technical check error: preserve previous business availability in SQLite
      const sanitized = this.sanitizeError(scraperResult.errorMessage);
      this.productRepo.updateCheckResult(product.id, {
        checkStatus: "ERROR",
        errorMessage: sanitized,
        checkedAt: scraperResult.checkedAt,
      });

      const updatedProduct = this.productRepo.findById(product.id)!;
      logger.warn(
        `Check ERROR for ID ${product.id}: preserved availability=${updatedProduct.cartAvailability}, error=${sanitized}`
      );

      return {
        productId: product.id,
        url: product.url,
        cartAvailability: updatedProduct.cartAvailability,
        checkStatus: "ERROR",
        alertTriggered: false,
        notificationQueued: false,
        error: sanitized,
      };
    } catch (error: any) {
      // Propagate database write failures directly
      if (error instanceof DatabaseError) {
        throw error;
      }

      // Unexpected scraper exception: record as technical error, preserving availability
      const sanitized = this.sanitizeError(error);
      const now = new Date().toISOString();

      try {
        this.productRepo.updateCheckResult(product.id, {
          checkStatus: "ERROR",
          errorMessage: sanitized,
          checkedAt: now,
        });
      } catch (dbErr) {
        throw dbErr; // Ensure database write errors always propagate
      }

      const updatedProduct = this.productRepo.findById(product.id) || product;
      logger.error(`Unhandled error during check for ID ${product.id}: ${sanitized}`);

      return {
        productId: product.id,
        url: product.url,
        cartAvailability: updatedProduct.cartAvailability,
        checkStatus: "ERROR",
        alertTriggered: false,
        notificationQueued: false,
        error: sanitized,
      };
    } finally {
      this.activeChecks.delete(productId);
      if (processLockToken && this.lockFilePath !== ":memory:") {
        releaseProcessLock(this.lockFilePath, processLockToken);
      }
    }
  }

  /**
   * Executes a sequential full check cycle across all active products.
   * Enforces in-memory and cross-process cycle overlap locks, isolates individual
   * product errors so the cycle continues, and returns a CheckCycleSummary.
   */
  async runAllChecks(): Promise<CheckCycleSummary> {
    if (this.isCycleRunning) {
      throw new AppError(
        "A check cycle is already currently running",
        "CONCURRENT_CYCLE_CONFLICT"
      );
    }

    let processLockToken: string | null = null;
    if (this.lockFilePath !== ":memory:") {
      const lockAcq = acquireProcessLock(this.lockFilePath);
      if (!lockAcq.acquired) {
        throw new AppError(
          `Cannot start check cycle: ${lockAcq.reason || "cross-process lock contention"}`,
          "CONCURRENT_CYCLE_CONFLICT"
        );
      }
      processLockToken = lockAcq.token || null;
    }

    this.isCycleRunning = true;
    const startedAt = new Date().toISOString();

    try {
      logger.info("Starting sequential check cycle for all active products...");

      const activeProducts = this.productRepo.findActive();
      const results: CheckResult[] = [];
      let alertsTriggered = 0;

      // Sequential execution: checks one product at a time to respect 1GB VM limits
      for (const product of activeProducts) {
        try {
          const result = await this.runSingleCheck(product.id, { isInternalCycleCall: true });
          results.push(result);
          if (result.notificationQueued || result.alertTriggered) {
            alertsTriggered++;
          }
        } catch (itemError: any) {
          if (itemError instanceof DatabaseError) {
            throw itemError; // Propagate fatal database errors
          }

          const sanitized = this.sanitizeError(itemError);
          logger.error(`Product check failed during cycle for ID ${product.id}: ${sanitized}`);

          results.push({
            productId: product.id,
            url: product.url,
            cartAvailability: product.cartAvailability,
            checkStatus: "ERROR",
            alertTriggered: false,
            notificationQueued: false,
            error: sanitized,
          });
        }
      }

      const completedAt = new Date().toISOString();
      logger.info(
        `Check cycle completed: ${results.length} checked, ${alertsTriggered} notifications queued`
      );

      return {
        startedAt,
        completedAt,
        totalChecked: results.length,
        alertsTriggered,
        results,
      };
    } finally {
      this.isCycleRunning = false;
      if (processLockToken && this.lockFilePath !== ":memory:") {
        releaseProcessLock(this.lockFilePath, processLockToken);
      }
    }
  }
}

export const checkEngine = new CheckEngine();
