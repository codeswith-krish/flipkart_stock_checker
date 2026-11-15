import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import Database, { type Database as DatabaseInstance } from "better-sqlite3";
import { runMigrations } from "../../src/db/migrations.js";
import { ProductRepository } from "../../src/db/repositories/product.repository.js";
import { CheckEngine } from "../../src/modules/checker/check-engine.js";
import { NotificationDispatcher } from "../../src/modules/notifier/dispatcher.js";
import { TelegramNotifier, redactTelegramToken } from "../../src/modules/notifier/telegram.js";
import { SchedulerRunner } from "../../src/scheduler/runner.js";
import type { IScraper, CartCheckResult } from "../../src/modules/scraper/types.js";
import { _resetActiveLockConnectionsForTesting } from "../../src/modules/checker/process-lock.js";

/**
 * Deterministic Offline Scraper with Strict Domain Enforcement.
 * Intercepts all product and cart checks completely offline without network access.
 */
class OfflineCartScraper implements IScraper {
  public routeHandlers: Map<string, (url: string) => CartCheckResult> = new Map();
  public unexpectedRequests: string[] = [];

  async checkCartAvailability(url: string, expectedProductId?: string | null): Promise<CartCheckResult> {
    // Strict offline domain guard
    if (!url.includes("flipkart.com")) {
      this.unexpectedRequests.push(url);
      return {
        checkStatus: "ERROR",
        cartAvailability: "UNKNOWN",
        url,
        productId: expectedProductId || null,
        productTitle: null,
        errorReason: "NAVIGATION_TIMEOUT",
        errorMessage: `External request to unauthorized domain strictly blocked: ${url}`,
        checkedAt: new Date().toISOString(),
      };
    }

    const handler = this.routeHandlers.get(url);
    if (handler) {
      return handler(url);
    }

    // Default: Verified new add to cart
    return {
      checkStatus: "SUCCESS",
      cartAvailability: "AVAILABLE",
      url,
      productId: expectedProductId || "itm_default",
      productTitle: "Offline Test Product",
      reason: "VERIFIED_NEW_ADD_TO_CART",
      evidence: {
        buttonFound: true,
        buttonText: "ADD TO CART",
        buttonState: "ENABLED",
        cartNavigated: true,
        cartUrl: "https://www.flipkart.com/viewcart",
        matchedBy: "PRODUCT_ID",
        matchedItemId: expectedProductId || "itm_default",
        matchedItemTitle: "Offline Test Product",
        staleCartDetected: false,
        preExistingCartCheckPerformed: false,
      },
      checkedAt: new Date().toISOString(),
    };
  }

  async scrapeProduct(url: string) {
    return {
      url,
      title: "Offline Test Product",
      price: 999,
      inStock: true,
    };
  }

  async close(): Promise<void> {}
}

describe("E2E Notification Pipeline — Full Production Flow Validation", () => {
  let tempDir: string;
  let dbPath: string;
  let engineLockFile: string;
  let dispatcherLockFile: string;
  let db: DatabaseInstance;
  let repo: ProductRepository;
  let scraper: OfflineCartScraper;
  let checkEngine: CheckEngine;
  let mockFetch: ReturnType<typeof vi.fn>;
  let notifier: TelegramNotifier;
  let dispatcher: NotificationDispatcher;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "e2e_pipeline_"));
    dbPath = path.join(tempDir, "e2e.db");
    engineLockFile = path.join(tempDir, ".engine_lock.sqlite");
    dispatcherLockFile = path.join(tempDir, ".dispatcher_lock.sqlite");

    db = new Database(dbPath);
    runMigrations(db);
    repo = new ProductRepository(db);

    scraper = new OfflineCartScraper();
    checkEngine = new CheckEngine(repo, scraper, undefined, engineLockFile);

    mockFetch = vi.fn();
    notifier = new TelegramNotifier("test_bot_token", "test_chat_id", mockFetch as any);
    dispatcher = new NotificationDispatcher(repo, notifier, dispatcherLockFile, 0, "test_chat_id");
  });

  afterEach(() => {
    _resetActiveLockConnectionsForTesting();
    try {
      db.close();
    } catch {}
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
    vi.restoreAllMocks();
  });

  it("E2E-1: Full 12-Step Product Restock, Alert, Depletion, and Re-Arm Lifecycle", async () => {
    const productUrl = "https://www.flipkart.com/sony-wh-1000xm5/p/itm_sony_xm5?pid=AUDIO12345";
    const productTitle = "Sony WH-1000XM5 Headphones";

    // Step 1: Product Storage in SQLite
    const created = repo.create({ url: productUrl, title: productTitle });
    expect(created.id).toBeGreaterThan(0);
    expect(created.notificationState).toBe("IDLE");
    expect(created.cartAvailability).toBe("UNKNOWN");
    expect(created.notificationCycle).toBe(0);
    expect(created.retryCount).toBe(0);

    // Step 2 & 3: CheckEngine executes verification -> AVAILABLE
    scraper.routeHandlers.set(productUrl, (url) => ({
      checkStatus: "SUCCESS",
      cartAvailability: "AVAILABLE",
      url,
      productId: "AUDIO12345",
      productTitle,
      reason: "VERIFIED_NEW_ADD_TO_CART",
      checkedAt: new Date().toISOString(),
    }));

    const check1 = await checkEngine.runSingleCheck(created.id);
    expect(check1.checkStatus).toBe("SUCCESS");
    expect(check1.cartAvailability).toBe("AVAILABLE");
    expect(check1.notificationQueued).toBe(true);

    // Step 4: Notification state becomes PENDING, notification_cycle becomes 1
    const pAfterCheck1 = repo.findById(created.id)!;
    expect(pAfterCheck1.notificationState).toBe("PENDING");
    expect(pAfterCheck1.notificationCycle).toBe(1);
    expect(pAfterCheck1.retryCount).toBe(0);

    // Step 5: Dispatcher candidate sweep discovers pending notification
    // Step 6 & 7: Telegram HTTP request intercepted and HTTP 200 response returned
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        result: { message_id: 8001 },
      }),
    });

    const dispatch1 = await dispatcher.dispatchPending();
    expect(dispatch1.totalPending).toBe(1);
    expect(dispatch1.dispatchedCount).toBe(1);
    expect(dispatch1.failedCount).toBe(0);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Inspect intercepted Telegram payload
    const [apiUrl, fetchOpts] = mockFetch.mock.calls[0];
    // Actual outgoing HTTPS request must contain the configured bot token
    expect(apiUrl).toBe("https://api.telegram.org/bottest_bot_token/sendMessage");
    // Diagnostic and log redaction utility must strictly mask the bot token
    expect(redactTelegramToken(apiUrl, "test_bot_token")).toBe(
      "https://api.telegram.org/bot[REDACTED]/sendMessage"
    );
    const sentBody = JSON.parse(fetchOpts.body);
    expect(sentBody.chat_id).toBe("test_chat_id");
    expect(sentBody.parse_mode).toBe("HTML");
    expect(sentBody.text).toContain("Sony WH-1000XM5 Headphones");
    expect(sentBody.text).toContain("Cart Availability Confirmed");
    expect(sentBody.text).toContain("Open on Flipkart");

    // Step 8: CAS transitions PENDING -> DELIVERED, records last_alert_sent_at
    const pAfterDelivery = repo.findById(created.id)!;
    expect(pAfterDelivery.notificationState).toBe("DELIVERED");
    expect(pAfterDelivery.lastAlertSentAt).toBeDefined();
    expect(pAfterDelivery.notificationCycle).toBe(1);

    // Step 9: Repeated AVAILABLE check -> Idempotent duplicate suppression
    scraper.routeHandlers.set(productUrl, (url) => ({
      checkStatus: "SUCCESS",
      cartAvailability: "AVAILABLE",
      url,
      productId: "AUDIO12345",
      productTitle,
      reason: "ALREADY_IN_CART",
      checkedAt: new Date().toISOString(),
    }));

    const check2 = await checkEngine.runSingleCheck(created.id);
    expect(check2.checkStatus).toBe("SUCCESS");
    expect(check2.cartAvailability).toBe("AVAILABLE");
    expect(check2.notificationQueued).toBe(false); // No duplicate alert queued!

    // Verify dispatcher finds 0 pending items and makes 0 Telegram calls
    const dispatch2 = await dispatcher.dispatchPending();
    expect(dispatch2.totalPending).toBe(0);
    expect(dispatch2.dispatchedCount).toBe(0);
    expect(mockFetch).toHaveBeenCalledTimes(1); // Still 1 from earlier

    // Step 10: Stock Depletion -> OUT_OF_STOCK resets notificationState to IDLE
    scraper.routeHandlers.set(productUrl, (url) => ({
      checkStatus: "SUCCESS",
      cartAvailability: "OUT_OF_STOCK",
      url,
      productId: "AUDIO12345",
      productTitle,
      reason: "EXPLICIT_OUT_OF_STOCK_BANNER",
      checkedAt: new Date().toISOString(),
    }));

    const check3 = await checkEngine.runSingleCheck(created.id);
    expect(check3.cartAvailability).toBe("OUT_OF_STOCK");
    expect(check3.notificationQueued).toBe(false);

    const pOos = repo.findById(created.id)!;
    expect(pOos.notificationState).toBe("IDLE"); // Re-armed!
    expect(pOos.cartAvailability).toBe("OUT_OF_STOCK");
    expect(pOos.notificationCycle).toBe(1); // Cycle preserved

    // Step 11: Restock triggers new cycle -> AVAILABLE and PENDING (Cycle 2)
    scraper.routeHandlers.set(productUrl, (url) => ({
      checkStatus: "SUCCESS",
      cartAvailability: "AVAILABLE",
      url,
      productId: "AUDIO12345",
      productTitle,
      reason: "VERIFIED_NEW_ADD_TO_CART",
      checkedAt: new Date().toISOString(),
    }));

    const check4 = await checkEngine.runSingleCheck(created.id);
    expect(check4.cartAvailability).toBe("AVAILABLE");
    expect(check4.notificationQueued).toBe(true);

    const pRestocked = repo.findById(created.id)!;
    expect(pRestocked.notificationState).toBe("PENDING");
    expect(pRestocked.notificationCycle).toBe(2); // Bumped to Cycle 2!
    expect(pRestocked.retryCount).toBe(0);

    // Step 12: Second Telegram notification transmitted and recorded for Cycle 2
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        result: { message_id: 8002 },
      }),
    });

    const dispatch3 = await dispatcher.dispatchPending();
    expect(dispatch3.totalPending).toBe(1);
    expect(dispatch3.dispatchedCount).toBe(1);
    expect(mockFetch).toHaveBeenCalledTimes(2);

    const pFinal = repo.findById(created.id)!;
    expect(pFinal.notificationState).toBe("DELIVERED");
    expect(pFinal.notificationCycle).toBe(2);

    // Monitoring continues safely without further alerts
    const dispatch4 = await dispatcher.dispatchPending();
    expect(dispatch4.totalPending).toBe(0);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("E2E-2: Multi-Product Batch Cycle with Simultaneous Available Items", async () => {
    const p1 = repo.create({ url: "https://www.flipkart.com/prod-1/p/itm1?pid=PID1", title: "Product 1" });
    const p2 = repo.create({ url: "https://www.flipkart.com/prod-2/p/itm2?pid=PID2", title: "Product 2" });
    const p3 = repo.create({ url: "https://www.flipkart.com/prod-3/p/itm3?pid=PID3", title: "Product 3" });

    // Run full check engine cycle across all active products
    const summary = await checkEngine.runAllChecks();
    expect(summary.totalChecked).toBe(3);
    expect(summary.alertsTriggered).toBe(3);

    // All 3 are PENDING
    const candidates = repo.findPendingNotifications();
    expect(candidates.length).toBe(3);

    // Mock Telegram returns 200 for all 3
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result: { message_id: 9000 } }),
    });

    const dispatchSummary = await dispatcher.dispatchPending();
    expect(dispatchSummary.dispatchedCount).toBe(3);
    expect(dispatchSummary.failedCount).toBe(0);
    expect(mockFetch).toHaveBeenCalledTimes(3);

    // Verify all 3 transitioned to DELIVERED
    expect(repo.findById(p1.id)!.notificationState).toBe("DELIVERED");
    expect(repo.findById(p2.id)!.notificationState).toBe("DELIVERED");
    expect(repo.findById(p3.id)!.notificationState).toBe("DELIVERED");

    // Subsequent sweep delivers nothing
    const secondSweep = await dispatcher.dispatchPending();
    expect(secondSweep.totalPending).toBe(0);
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it("E2E-3: SchedulerRunner Full Check and Post-Check Dispatch Sweep Integration", async () => {
    const p = repo.create({ url: "https://www.flipkart.com/prod-sched/p/itm_s?pid=PIDS", title: "Sched Item" });

    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result: { message_id: 9500 } }),
    });

    const runner = new SchedulerRunner(checkEngine, dispatcher);

    // Execute single scheduler cycle (runs all checks then dispatches pending)
    await runner.executeCycle();

    const delivered = repo.findById(p.id)!;
    expect(delivered.cartAvailability).toBe("AVAILABLE");
    expect(delivered.notificationState).toBe("DELIVERED");
    expect(mockFetch).toHaveBeenCalledTimes(1);

    runner.stop();
  });

  it("E2E-4: Strict Offline Domain Boundary Enforcement", async () => {
    // Attempt checking an unauthorized external URL
    const externalResult = await scraper.checkCartAvailability("https://www.amazon.in/dp/B08L5WH74G");
    expect(externalResult.checkStatus).toBe("ERROR");
    expect(externalResult.errorMessage).toContain("unauthorized domain strictly blocked");
    expect(scraper.unexpectedRequests.length).toBe(1);

    // Verify Telegram notifier does not send when bot token is dummy/empty
    const dummyNotifier = new TelegramNotifier("dummy_token", "test_chat_id", mockFetch as any);
    const sendResult = await dummyNotifier.sendMessageWithResult("Test Message");
    expect(sendResult.status).toBe("PERMANENT_FAILURE");
    expect(sendResult.error).toContain("Telegram bot token is not configured");
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
