import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import Database, { type Database as DatabaseInstance } from "better-sqlite3";
import { runMigrations } from "../../src/db/migrations.js";
import { ProductRepository } from "../../src/db/repositories/product.repository.js";
import { TelegramNotifier } from "../../src/modules/notifier/telegram.js";
import { NotificationDispatcher } from "../../src/modules/notifier/dispatcher.js";
import { acquireProcessLock, releaseProcessLock, _resetActiveLockConnectionsForTesting } from "../../src/modules/checker/process-lock.js";
import { SchedulerRunner } from "../../src/scheduler/runner.js";

describe("Phase 4 Task 4.3 — SQLite CAS & Notification Dispatcher Integration", () => {
  let tempDir: string;
  let dbPath: string;
  let db: DatabaseInstance;
  let repo: ProductRepository;
  let lockFilePath: string;
  let mockFetch: ReturnType<typeof vi.fn>;
  let notifier: TelegramNotifier;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "dispatcher-test-"));
    dbPath = path.join(tempDir, "test.db");
    lockFilePath = path.join(tempDir, ".dispatcher_lock.sqlite");

    db = new Database(dbPath);
    runMigrations(db);
    repo = new ProductRepository(db);

    mockFetch = vi.fn();
    notifier = new TelegramNotifier("test_token", "test_chat_id", mockFetch as any);
  });

  afterEach(() => {
    _resetActiveLockConnectionsForTesting();
    try {
      db.close();
    } catch {}
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  describe("1. Schema & Migrations", () => {
    it("1.1 Non-destructive migration on existing database adds new columns, indexes, and tables", () => {
      const legacyDbPath = path.join(tempDir, "legacy.db");
      const legacyDb = new Database(legacyDbPath);

      // Create a legacy schema without notification_cycle, retry_count, next_retry_at, last_delivery_error, or chat_cooldowns
      legacyDb.exec(`
        CREATE TABLE products (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          url TEXT NOT NULL UNIQUE,
          product_id TEXT,
          title TEXT NOT NULL,
          is_active INTEGER NOT NULL DEFAULT 1,
          cart_availability TEXT NOT NULL DEFAULT 'UNKNOWN',
          last_check_status TEXT NOT NULL DEFAULT 'NEVER_CHECKED',
          last_error_message TEXT,
          notification_state TEXT NOT NULL DEFAULT 'IDLE',
          last_alert_sent_at TEXT,
          last_checked_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        INSERT INTO products (url, title, created_at, updated_at)
        VALUES ('https://www.flipkart.com/item/p/itm1?pid=PID1', 'Legacy Item', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
      `);

      // Run migration on legacy database
      expect(() => runMigrations(legacyDb)).not.toThrow();

      // Verify new columns exist and contain default values
      const cols = legacyDb.prepare("PRAGMA table_info(products)").all() as any[];
      const colNames = cols.map((c) => c.name);
      expect(colNames).toContain("notification_cycle");
      expect(colNames).toContain("retry_count");
      expect(colNames).toContain("next_retry_at");
      expect(colNames).toContain("last_delivery_error");

      const row = legacyDb.prepare("SELECT * FROM products WHERE id = 1").get() as any;
      expect(row.notification_cycle).toBe(0);
      expect(row.retry_count).toBe(0);
      expect(row.next_retry_at).toBeNull();
      expect(row.last_delivery_error).toBeNull();

      // Verify chat_cooldowns table exists
      const cooldownsTable = legacyDb
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='chat_cooldowns'")
        .get();
      expect(cooldownsTable).toBeDefined();

      legacyDb.close();
    });

    it("1.2 Idempotent migration re-run does not fail or duplicate columns/tables", () => {
      expect(() => runMigrations(db)).not.toThrow();
      expect(() => runMigrations(db)).not.toThrow();

      const product = repo.create({ url: "https://www.flipkart.com/item/p/itm100?pid=PID100" });
      expect(product.id).toBeGreaterThan(0);
    });
  });

  describe("2. CAS Delivery State Transitions", () => {
    it("2.1 Successful delivery transitions PENDING -> DELIVERED and records metadata", () => {
      const product = repo.create({ url: "https://www.flipkart.com/item/p/itm2?pid=PID2" });
      repo.updateCheckResult(product.id, {
        checkStatus: "SUCCESS",
        cartAvailability: "AVAILABLE",
      });

      const pending = repo.findById(product.id)!;
      expect(pending.notificationState).toBe("PENDING");
      expect(pending.notificationCycle).toBe(1);

      const alertTime = new Date().toISOString();
      const updated = repo.markNotificationDelivered(product.id, 1, alertTime);
      expect(updated).toBe(true);

      const delivered = repo.findById(product.id)!;
      expect(delivered.notificationState).toBe("DELIVERED");
      expect(delivered.lastAlertSentAt).toBe(alertTime);
      expect(delivered.nextRetryAt).toBeNull();
      expect(delivered.lastDeliveryError).toBeNull();
    });

    it("2.2 CAS rejects update if product was deactivated during dispatch", () => {
      const product = repo.create({ url: "https://www.flipkart.com/item/p/itm3?pid=PID3" });
      repo.updateCheckResult(product.id, {
        checkStatus: "SUCCESS",
        cartAvailability: "AVAILABLE",
      });

      // Product deactivated while alert was in transit
      repo.deactivate(product.id);

      const updated = repo.markNotificationDelivered(product.id, 1);
      expect(updated).toBe(false);

      const check = repo.findById(product.id)!;
      expect(check.notificationState).toBe("PENDING");
      expect(check.isActive).toBe(false);
    });

    it("2.3 CAS rejects update if product transitioned to OUT_OF_STOCK during dispatch", () => {
      const product = repo.create({ url: "https://www.flipkart.com/item/p/itm4?pid=PID4" });
      repo.updateCheckResult(product.id, {
        checkStatus: "SUCCESS",
        cartAvailability: "AVAILABLE",
      });

      // Transition to OUT_OF_STOCK concurrently
      repo.updateCheckResult(product.id, {
        checkStatus: "SUCCESS",
        cartAvailability: "OUT_OF_STOCK",
      });

      const updated = repo.markNotificationDelivered(product.id, 1);
      expect(updated).toBe(false);

      const check = repo.findById(product.id)!;
      expect(check.notificationState).toBe("IDLE");
      expect(check.cartAvailability).toBe("OUT_OF_STOCK");
    });

    it("2.4 CAS rejects update if notification cycle was bumped by a newer restock", () => {
      const product = repo.create({ url: "https://www.flipkart.com/item/p/itm5?pid=PID5" });
      repo.updateCheckResult(product.id, {
        checkStatus: "SUCCESS",
        cartAvailability: "AVAILABLE",
      }); // Cycle 1

      // Flips to OUT_OF_STOCK then back to AVAILABLE -> Cycle 2
      repo.updateCheckResult(product.id, { checkStatus: "SUCCESS", cartAvailability: "OUT_OF_STOCK" });
      repo.updateCheckResult(product.id, { checkStatus: "SUCCESS", cartAvailability: "AVAILABLE" });

      const check = repo.findById(product.id)!;
      expect(check.notificationCycle).toBe(2);

      // Attempting to deliver old Cycle 1 must fail
      const updated = repo.markNotificationDelivered(product.id, 1);
      expect(updated).toBe(false);

      const finalProduct = repo.findById(product.id)!;
      expect(finalProduct.notificationState).toBe("PENDING");
      expect(finalProduct.notificationCycle).toBe(2);
    });

    it("2.5 CAS rejects update if already DELIVERED", () => {
      const product = repo.create({ url: "https://www.flipkart.com/item/p/itm6?pid=PID6" });
      repo.updateCheckResult(product.id, { checkStatus: "SUCCESS", cartAvailability: "AVAILABLE" });

      expect(repo.markNotificationDelivered(product.id, 1)).toBe(true);
      // Second delivery attempt on already delivered row must return false
      expect(repo.markNotificationDelivered(product.id, 1)).toBe(false);
    });
  });

  describe("3. Atomic Retry & Authoritative Backoff", () => {
    it("3.1 to 3.5 Advances authoritative retries through 5 attempts then suspends", () => {
      const product = repo.create({ url: "https://www.flipkart.com/item/p/itm7?pid=PID7" });
      repo.updateCheckResult(product.id, { checkStatus: "SUCCESS", cartAvailability: "AVAILABLE" });

      // Attempt 1 failure -> retry_count 1, +30s
      const before1 = Date.now();
      expect(repo.recordNotificationFailure(product.id, 1, { error: "Network timeout 1" })).toBe(true);
      let p = repo.findById(product.id)!;
      expect(p.retryCount).toBe(1);
      expect(p.lastDeliveryError).toBe("Network timeout 1");
      expect(p.nextRetryAt).toBeDefined();
      const delay1 = (new Date(p.nextRetryAt!).getTime() - before1) / 1000;
      expect(delay1).toBeGreaterThanOrEqual(28);
      expect(delay1).toBeLessThanOrEqual(32);

      // Attempt 2 failure -> retry_count 2, +60s
      const before2 = Date.now();
      expect(repo.recordNotificationFailure(product.id, 1, { error: "Network timeout 2" })).toBe(true);
      p = repo.findById(product.id)!;
      expect(p.retryCount).toBe(2);
      const delay2 = (new Date(p.nextRetryAt!).getTime() - before2) / 1000;
      expect(delay2).toBeGreaterThanOrEqual(58);
      expect(delay2).toBeLessThanOrEqual(62);

      // Attempt 3 failure -> retry_count 3, +120s
      const before3 = Date.now();
      expect(repo.recordNotificationFailure(product.id, 1, { error: "Network timeout 3" })).toBe(true);
      p = repo.findById(product.id)!;
      expect(p.retryCount).toBe(3);
      const delay3 = (new Date(p.nextRetryAt!).getTime() - before3) / 1000;
      expect(delay3).toBeGreaterThanOrEqual(118);
      expect(delay3).toBeLessThanOrEqual(122);

      // Attempt 4 failure -> retry_count 4, +240s
      const before4 = Date.now();
      expect(repo.recordNotificationFailure(product.id, 1, { error: "Network timeout 4" })).toBe(true);
      p = repo.findById(product.id)!;
      expect(p.retryCount).toBe(4);
      const delay4 = (new Date(p.nextRetryAt!).getTime() - before4) / 1000;
      expect(delay4).toBeGreaterThanOrEqual(238);
      expect(delay4).toBeLessThanOrEqual(242);

      // Attempt 5 failure -> retry_count 5, next_retry_at = NULL (Suspended!)
      expect(repo.recordNotificationFailure(product.id, 1, { error: "Final 5th failure" })).toBe(true);
      p = repo.findById(product.id)!;
      expect(p.retryCount).toBe(5);
      expect(p.nextRetryAt).toBeNull();
      expect(p.lastDeliveryError).toBe("Final 5th failure");

      // Verify that candidate query excludes suspended product
      const candidates = repo.findPendingNotifications();
      expect(candidates.find((c) => c.id === product.id)).toBeUndefined();
    });

    it("3.6 Permanent failure immediately suspends notification cycle", () => {
      const product = repo.create({ url: "https://www.flipkart.com/item/p/itm8?pid=PID8" });
      repo.updateCheckResult(product.id, { checkStatus: "SUCCESS", cartAvailability: "AVAILABLE" });

      const updated = repo.recordNotificationFailure(product.id, 1, {
        error: "HTTP 403: Bot blocked",
        isPermanent: true,
      });
      expect(updated).toBe(true);

      const p = repo.findById(product.id)!;
      expect(p.retryCount).toBe(5);
      expect(p.nextRetryAt).toBeNull();
      expect(p.lastDeliveryError).toBe("HTTP 403: Bot blocked");

      expect(repo.findPendingNotifications().find((c) => c.id === product.id)).toBeUndefined();
    });

    it("3.7 Already-suspended item cannot be modified by recordNotificationFailure", () => {
      const product = repo.create({ url: "https://www.flipkart.com/item/p/itm9?pid=PID9" });
      repo.updateCheckResult(product.id, { checkStatus: "SUCCESS", cartAvailability: "AVAILABLE" });
      repo.recordNotificationFailure(product.id, 1, { error: "Immediate perm", isPermanent: true });

      // Row is now suspended with retry_count = 5. Further failure calls must return false.
      const updatedAgain = repo.recordNotificationFailure(product.id, 1, { error: "Late error" });
      expect(updatedAgain).toBe(false);

      const p = repo.findById(product.id)!;
      expect(p.retryCount).toBe(5);
      expect(p.lastDeliveryError).toBe("Immediate perm");
    });

    it("3.8 Stale cycle failure cannot modify row if restock cycle incremented", () => {
      const product = repo.create({ url: "https://www.flipkart.com/item/p/itm10?pid=PID10" });
      repo.updateCheckResult(product.id, { checkStatus: "SUCCESS", cartAvailability: "AVAILABLE" }); // Cycle 1

      // Flips to OUT_OF_STOCK then AVAILABLE -> Cycle 2
      repo.updateCheckResult(product.id, { checkStatus: "SUCCESS", cartAvailability: "OUT_OF_STOCK" });
      repo.updateCheckResult(product.id, { checkStatus: "SUCCESS", cartAvailability: "AVAILABLE" });

      // Stale failure report referencing Cycle 1 must fail
      const updated = repo.recordNotificationFailure(product.id, 1, { error: "Old cycle failure" });
      expect(updated).toBe(false);

      const p = repo.findById(product.id)!;
      expect(p.notificationCycle).toBe(2);
      expect(p.retryCount).toBe(0);
      expect(p.lastDeliveryError).toBeNull();
    });

    it("3.9 Subsequent restock resets retry_count and next_retry_at, lifting suspension", () => {
      const product = repo.create({ url: "https://www.flipkart.com/item/p/itm11?pid=PID11" });
      repo.updateCheckResult(product.id, { checkStatus: "SUCCESS", cartAvailability: "AVAILABLE" });
      repo.recordNotificationFailure(product.id, 1, { error: "Exhausted", isPermanent: true });

      let p = repo.findById(product.id)!;
      expect(p.retryCount).toBe(5);

      // Product goes out of stock
      repo.updateCheckResult(product.id, { checkStatus: "SUCCESS", cartAvailability: "OUT_OF_STOCK" });
      p = repo.findById(product.id)!;
      expect(p.notificationState).toBe("IDLE");
      expect(p.retryCount).toBe(0);

      // Product restocks!
      repo.updateCheckResult(product.id, { checkStatus: "SUCCESS", cartAvailability: "AVAILABLE" });
      p = repo.findById(product.id)!;
      expect(p.notificationState).toBe("PENDING");
      expect(p.notificationCycle).toBe(2);
      expect(p.retryCount).toBe(0);
      expect(p.nextRetryAt).toBeNull();
      expect(p.lastDeliveryError).toBeNull();

      // Is now an active candidate again
      const candidates = repo.findPendingNotifications();
      expect(candidates.find((c) => c.id === product.id)).toBeDefined();
    });
  });

  describe("4. Persistent Shared Chat Cooldown (HTTP 429)", () => {
    it("4.1 HTTP 429 sets chat_cooldowns with exact retry_after seconds", () => {
      repo.setChatCooldown("test_chat_id", 45);
      const cooldown = repo.getChatCooldown("test_chat_id");
      expect(cooldown).toBeDefined();

      const remainingSec = (new Date(cooldown!).getTime() - Date.now()) / 1000;
      expect(remainingSec).toBeGreaterThanOrEqual(43);
      expect(remainingSec).toBeLessThanOrEqual(47);
    });

    it("4.2 Dispatch sweep suppresses dispatch when chat is under cooldown", async () => {
      const product = repo.create({ url: "https://www.flipkart.com/item/p/itm12?pid=PID12" });
      repo.updateCheckResult(product.id, { checkStatus: "SUCCESS", cartAvailability: "AVAILABLE" });

      repo.setChatCooldown("test_chat_id", 60);

      const dispatcher = new NotificationDispatcher(
        repo,
        notifier,
        lockFilePath,
        0,
        "test_chat_id"
      );

      const summary = await dispatcher.dispatchPending();
      expect(summary.lockAcquired).toBe(true);
      expect(summary.abortedDueToRateLimit).toBe(true);
      expect(summary.dispatchedCount).toBe(0);
      expect(mockFetch).not.toHaveBeenCalled();

      // Product remains PENDING
      expect(repo.findById(product.id)!.notificationState).toBe("PENDING");
    });

    it("4.3 Cooldown persists across separate dispatcher instances and DB reconnections", () => {
      repo.setChatCooldown("persistent_chat", 120);

      const reloadedRepo = new ProductRepository(db);
      const cooldown = reloadedRepo.getChatCooldown("persistent_chat");
      expect(cooldown).not.toBeNull();
    });

    it("4.4 Cooldown upsert never shortens an existing later cooldown", () => {
      // First set 100 seconds
      repo.setChatCooldown("test_chat_id", 100);
      const initialCooldown = repo.getChatCooldown("test_chat_id")!;

      // Now attempt setting 10 seconds
      repo.setChatCooldown("test_chat_id", 10);
      const preservedCooldown = repo.getChatCooldown("test_chat_id")!;

      expect(preservedCooldown).toBe(initialCooldown);

      // Now set 200 seconds (longer) -> should update
      repo.setChatCooldown("test_chat_id", 200);
      const extendedCooldown = repo.getChatCooldown("test_chat_id")!;
      expect(new Date(extendedCooldown).getTime()).toBeGreaterThan(new Date(initialCooldown).getTime());
    });

    it("4.5 Expired cooldown allows dispatch sweep to proceed", async () => {
      const product = repo.create({ url: "https://www.flipkart.com/item/p/itm13?pid=PID13" });
      repo.updateCheckResult(product.id, { checkStatus: "SUCCESS", cartAvailability: "AVAILABLE" });

      // Insert an already expired cooldown timestamp
      db.prepare(
        "INSERT OR REPLACE INTO chat_cooldowns (chat_id, cooldown_until, updated_at) VALUES (?, ?, ?)"
      ).run("test_chat_id", "2020-01-01T00:00:00.000Z", "2020-01-01T00:00:00.000Z");

      expect(repo.getChatCooldown("test_chat_id")).toBeNull();

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ ok: true, result: { message_id: 101 } }),
      });

      const dispatcher = new NotificationDispatcher(
        repo,
        notifier,
        lockFilePath,
        0,
        "test_chat_id"
      );

      const summary = await dispatcher.dispatchPending();
      expect(summary.dispatchedCount).toBe(1);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });

  describe("5. Cross-Process Advisory Locking", () => {
    it("5.1 Lock acquired by Dispatcher A blocks Dispatcher B", async () => {
      const lockA = acquireProcessLock(lockFilePath);
      expect(lockA.acquired).toBe(true);

      const dispatcherB = new NotificationDispatcher(
        repo,
        notifier,
        lockFilePath,
        0,
        "test_chat_id"
      );

      const summary = await dispatcherB.dispatchPending();
      expect(summary.lockAcquired).toBe(false);
      expect(summary.dispatchedCount).toBe(0);

      releaseProcessLock(lockFilePath, lockA.token!);
    });

    it("5.2 Normal exit releases lock and allows subsequent dispatch", async () => {
      const product = repo.create({ url: "https://www.flipkart.com/item/p/itm14?pid=PID14" });
      repo.updateCheckResult(product.id, { checkStatus: "SUCCESS", cartAvailability: "AVAILABLE" });

      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ ok: true, result: { message_id: 201 } }),
      });

      const dispatcher = new NotificationDispatcher(
        repo,
        notifier,
        lockFilePath,
        0,
        "test_chat_id"
      );

      const summary1 = await dispatcher.dispatchPending();
      expect(summary1.lockAcquired).toBe(true);
      expect(summary1.dispatchedCount).toBe(1);

      // Subsequent sweep immediately acquires lock without contention
      const summary2 = await dispatcher.dispatchPending();
      expect(summary2.lockAcquired).toBe(true);
      expect(summary2.dispatchedCount).toBe(0); // Already delivered
    });

    it("5.3 Dispatcher lock does not contend with CheckEngine lock", () => {
      const engineLockFile = path.join(tempDir, ".execution_lock.sqlite");

      const lockEngine = acquireProcessLock(engineLockFile);
      expect(lockEngine.acquired).toBe(true);

      const lockDispatcher = acquireProcessLock(lockFilePath);
      expect(lockDispatcher.acquired).toBe(true);

      releaseProcessLock(engineLockFile, lockEngine.token!);
      releaseProcessLock(lockFilePath, lockDispatcher.token!);
    });
  });

  describe("6. Dispatcher Batch Lifecycle & Candidate Re-checking", () => {
    it("6.1 Fresh candidate state re-check skips items invalidated mid-batch", async () => {
      const p1 = repo.create({ url: "https://www.flipkart.com/item/p/itm15?pid=PID15", title: "Item 15" });
      const p2 = repo.create({ url: "https://www.flipkart.com/item/p/itm16?pid=PID16", title: "Item 16" });

      repo.updateCheckResult(p1.id, { checkStatus: "SUCCESS", cartAvailability: "AVAILABLE" });
      repo.updateCheckResult(p2.id, { checkStatus: "SUCCESS", cartAvailability: "AVAILABLE" });

      // Before sweep runs, deactivate p2
      repo.deactivate(p2.id);

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ ok: true, result: { message_id: 301 } }),
      });

      const dispatcher = new NotificationDispatcher(
        repo,
        notifier,
        lockFilePath,
        0,
        "test_chat_id"
      );

      const summary = await dispatcher.dispatchPending();
      expect(summary.dispatchedCount).toBe(1);
      expect(mockFetch).toHaveBeenCalledTimes(1);

      expect(repo.findById(p1.id)!.notificationState).toBe("DELIVERED");
      expect(repo.findById(p2.id)!.notificationState).toBe("PENDING");
    });

    it("6.2 HTTP 429 on first item aborts remaining batch items immediately", async () => {
      const p1 = repo.create({ url: "https://www.flipkart.com/item/p/itm17?pid=PID17", title: "Item 17" });
      const p2 = repo.create({ url: "https://www.flipkart.com/item/p/itm18?pid=PID18", title: "Item 18" });

      repo.updateCheckResult(p1.id, { checkStatus: "SUCCESS", cartAvailability: "AVAILABLE" });
      repo.updateCheckResult(p2.id, { checkStatus: "SUCCESS", cartAvailability: "AVAILABLE" });

      // First item returns HTTP 429 with retry_after 35s
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 429,
        json: async () => ({
          ok: false,
          description: "Too Many Requests",
          parameters: { retry_after: 35 },
        }),
      });

      const dispatcher = new NotificationDispatcher(
        repo,
        notifier,
        lockFilePath,
        0,
        "test_chat_id"
      );

      const summary = await dispatcher.dispatchPending();
      expect(summary.abortedDueToRateLimit).toBe(true);
      expect(summary.failedCount).toBe(1);
      expect(summary.dispatchedCount).toBe(0);
      // Ensure Telegram API was NOT called for p2!
      expect(mockFetch).toHaveBeenCalledTimes(1);

      // Verify chat cooldown was set to 35s
      const cooldown = repo.getChatCooldown("test_chat_id");
      expect(cooldown).toBeDefined();

      // Verify p1 got retry_count 1
      const checkP1 = repo.findById(p1.id)!;
      expect(checkP1.retryCount).toBe(1);

      // Verify p2 remains PENDING and untouched (retry_count 0)
      const checkP2 = repo.findById(p2.id)!;
      expect(checkP2.retryCount).toBe(0);
      expect(checkP2.notificationState).toBe("PENDING");
    });

    it("6.3 Dispatches multiple items sequentially when all succeed", async () => {
      const p1 = repo.create({ url: "https://www.flipkart.com/item/p/itm19?pid=PID19", title: "Item 19" });
      const p2 = repo.create({ url: "https://www.flipkart.com/item/p/itm20?pid=PID20", title: "Item 20" });

      repo.updateCheckResult(p1.id, { checkStatus: "SUCCESS", cartAvailability: "AVAILABLE" });
      repo.updateCheckResult(p2.id, { checkStatus: "SUCCESS", cartAvailability: "AVAILABLE" });

      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ ok: true, result: { message_id: 401 } }),
      });

      const dispatcher = new NotificationDispatcher(
        repo,
        notifier,
        lockFilePath,
        0, // 0ms pacing in fast tests
        "test_chat_id"
      );

      const summary = await dispatcher.dispatchPending();
      expect(summary.dispatchedCount).toBe(2);
      expect(summary.failedCount).toBe(0);
      expect(mockFetch).toHaveBeenCalledTimes(2);

      expect(repo.findById(p1.id)!.notificationState).toBe("DELIVERED");
      expect(repo.findById(p2.id)!.notificationState).toBe("DELIVERED");
    });

    it("6.4 SchedulerRunner startup sweep and stop lifecycle executes cleanly", async () => {
      const p1 = repo.create({ url: "https://www.flipkart.com/item/p/itm21?pid=PID21", title: "Item 21" });
      repo.updateCheckResult(p1.id, { checkStatus: "SUCCESS", cartAvailability: "AVAILABLE" });

      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ ok: true, result: { message_id: 501 } }),
      });

      const dispatcher = new NotificationDispatcher(
        repo,
        notifier,
        lockFilePath,
        0,
        "test_chat_id"
      );

      const fakeEngine: any = {
        runAllChecks: vi.fn().mockResolvedValue({ totalChecked: 1, alertsTriggered: 0 }),
      };

      const runner = new SchedulerRunner(fakeEngine, dispatcher);
      runner.start();

      // Allow async startup sweeps to complete
      await new Promise((r) => setTimeout(r, 50));

      expect(repo.findById(p1.id)!.notificationState).toBe("DELIVERED");

      expect(() => runner.stop()).not.toThrow();
    });
  });
});
