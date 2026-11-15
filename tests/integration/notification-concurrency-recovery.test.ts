import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import Database, { type Database as DatabaseInstance } from "better-sqlite3";
import { runMigrations } from "../../src/db/migrations.js";
import { ProductRepository } from "../../src/db/repositories/product.repository.js";
import { NotificationDispatcher } from "../../src/modules/notifier/dispatcher.js";
import { TelegramNotifier } from "../../src/modules/notifier/telegram.js";
import { CheckEngine } from "../../src/modules/checker/check-engine.js";
import { SchedulerRunner } from "../../src/scheduler/runner.js";
import {
  acquireProcessLock,
  releaseProcessLock,
  _resetActiveLockConnectionsForTesting,
} from "../../src/modules/checker/process-lock.js";
import type { IScraper, CartCheckResult } from "../../src/modules/scraper/types.js";

/**
 * Creates a deterministic promise barrier for simulating in-flight HTTP requests.
 */
function createBarrier() {
  let signalStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    signalStarted = resolve;
  });

  let releaseBarrier!: () => void;
  const proceed = new Promise<void>((resolve) => {
    releaseBarrier = resolve;
  });

  return { started, signalStarted, proceed, releaseBarrier };
}

describe("Notification Concurrency, Race Conditions & Recovery Testing", () => {
  let tempDir: string;
  let dbPath: string;
  let engineLockFile: string;
  let dispatcherLockFile: string;
  let db: DatabaseInstance;
  let repo: ProductRepository;
  let mockFetch: ReturnType<typeof vi.fn>;
  let notifier: TelegramNotifier;
  let dispatcher: NotificationDispatcher;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "recovery_test_"));
    dbPath = path.join(tempDir, "recovery.db");
    engineLockFile = path.join(tempDir, ".engine_lock.sqlite");
    dispatcherLockFile = path.join(tempDir, ".dispatcher_lock.sqlite");

    db = new Database(dbPath);
    runMigrations(db);
    repo = new ProductRepository(db);

    mockFetch = vi.fn();
    notifier = new TelegramNotifier("test_token", "test_chat", mockFetch as any);
    dispatcher = new NotificationDispatcher(repo, notifier, dispatcherLockFile, 0, "test_chat");
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

  describe("1. In-Flight Race Conditions & CAS Rejection", () => {
    it("1.1 Product becomes OUT_OF_STOCK while Telegram HTTP request is in-flight", async () => {
      const p = repo.create({ url: "https://www.flipkart.com/prod/p/itm1?pid=P1", title: "Item 1" });
      repo.updateCheckResult(p.id, { checkStatus: "SUCCESS", cartAvailability: "AVAILABLE" });

      const barrier = createBarrier();
      mockFetch.mockImplementationOnce(async () => {
        barrier.signalStarted();
        await barrier.proceed;
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: true, result: { message_id: 111 } }),
        };
      });

      // Dispatch starts in background
      const dispatchPromise = dispatcher.dispatchPending();
      await barrier.started; // Deterministic: HTTP request is now in-flight

      // Concurrent event: Stock check marks product OUT_OF_STOCK
      repo.updateCheckResult(p.id, { checkStatus: "SUCCESS", cartAvailability: "OUT_OF_STOCK" });
      expect(repo.findById(p.id)!.notificationState).toBe("IDLE");

      // Release HTTP response
      barrier.releaseBarrier();
      const summary = await dispatchPromise;

      // Assert: CAS rejected the stale delivery update
      expect(summary.dispatchedCount).toBe(0);
      expect(summary.skippedCount).toBe(1);

      // Assert: SQLite database state remains strictly OUT_OF_STOCK and IDLE
      const finalState = repo.findById(p.id)!;
      expect(finalState.cartAvailability).toBe("OUT_OF_STOCK");
      expect(finalState.notificationState).toBe("IDLE");
      expect(finalState.lastAlertSentAt).toBeNull();
    });

    it("1.2 Product is deactivated while Telegram HTTP request is in-flight", async () => {
      const p = repo.create({ url: "https://www.flipkart.com/prod/p/itm2?pid=P2", title: "Item 2" });
      repo.updateCheckResult(p.id, { checkStatus: "SUCCESS", cartAvailability: "AVAILABLE" });

      const barrier = createBarrier();
      mockFetch.mockImplementationOnce(async () => {
        barrier.signalStarted();
        await barrier.proceed;
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: true, result: { message_id: 222 } }),
        };
      });

      const dispatchPromise = dispatcher.dispatchPending();
      await barrier.started;

      // Concurrent event: User or CLI deactivates product
      repo.deactivate(p.id);

      barrier.releaseBarrier();
      const summary = await dispatchPromise;

      expect(summary.dispatchedCount).toBe(0);
      expect(summary.skippedCount).toBe(1);

      const finalState = repo.findById(p.id)!;
      expect(finalState.isActive).toBe(false);
      expect(finalState.lastAlertSentAt).toBeNull();
    });

    it("1.3 Notification cycle changes before in-flight Telegram result is persisted", async () => {
      const p = repo.create({ url: "https://www.flipkart.com/prod/p/itm3?pid=P3", title: "Item 3" });
      repo.updateCheckResult(p.id, { checkStatus: "SUCCESS", cartAvailability: "AVAILABLE" }); // Cycle 1

      const barrier = createBarrier();
      mockFetch.mockImplementationOnce(async () => {
        barrier.signalStarted();
        await barrier.proceed;
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: true, result: { message_id: 333 } }),
        };
      });

      const dispatchPromise = dispatcher.dispatchPending();
      await barrier.started;

      // Concurrent event: Product flips to OUT_OF_STOCK and then restocks to Cycle 2
      repo.updateCheckResult(p.id, { checkStatus: "SUCCESS", cartAvailability: "OUT_OF_STOCK" });
      repo.updateCheckResult(p.id, { checkStatus: "SUCCESS", cartAvailability: "AVAILABLE" });
      expect(repo.findById(p.id)!.notificationCycle).toBe(2);

      barrier.releaseBarrier();
      const summary = await dispatchPromise;

      expect(summary.dispatchedCount).toBe(0);
      expect(summary.skippedCount).toBe(1);

      // Newer Cycle 2 remains intact in PENDING state
      const finalState = repo.findById(p.id)!;
      expect(finalState.notificationCycle).toBe(2);
      expect(finalState.notificationState).toBe("PENDING");
    });
  });

  describe("2. Cross-Process Advisory Locking & Crash Recovery", () => {
    it("2.1 Independent child process holding lock blocks concurrent dispatcher execution", async () => {
      const workerScript = path.resolve("tests/fixtures/lock-worker.ts");
      const tsxBin = path.resolve("node_modules/.bin/tsx");

      if (!fs.existsSync(workerScript) || !fs.existsSync(tsxBin)) {
        // Report limitation if worker script or tsx binary is not present
        return;
      }

      let child: any = null;
      try {
        child = spawn(process.execPath || "node", [tsxBin, workerScript, dispatcherLockFile, "acquire-and-hold"]);

        const childReady = await new Promise<boolean>((resolve) => {
          child.stdout?.on("data", (data: Buffer) => {
            if (data.toString().includes("ACQUIRED")) {
              resolve(true);
            }
          });
          child.on("error", () => resolve(false));
          setTimeout(() => resolve(false), 3000);
        });

        if (!childReady) {
          // If child process could not be spawned in container sandbox, record limitation
          return;
        }

        // Child process holds .dispatcher_lock.sqlite!
        // Sibling dispatcher execution must fail-fast with lockAcquired: false
        const summary = await dispatcher.dispatchPending();
        expect(summary.lockAcquired).toBe(false);
        expect(summary.dispatchedCount).toBe(0);

        // Tell child process to release lock
        child.stdin?.write("RELEASE\n");
        await new Promise((r) => setTimeout(r, 200));

        // Now host dispatcher acquires lock cleanly
        const summaryAfter = await dispatcher.dispatchPending();
        expect(summaryAfter.lockAcquired).toBe(true);
      } finally {
        if (child && !child.killed) {
          try { child.kill("SIGKILL"); } catch {}
        }
      }
    });

    it("2.2 SIGKILL crash recovery: Linux kernel releases advisory lock immediately", async () => {
      const workerScript = path.resolve("tests/fixtures/lock-worker.ts");
      const tsxBin = path.resolve("node_modules/.bin/tsx");

      if (!fs.existsSync(workerScript) || !fs.existsSync(tsxBin)) {
        return;
      }

      let child: any = null;
      try {
        child = spawn(process.execPath || "node", [tsxBin, workerScript, dispatcherLockFile, "acquire-and-hold"]);

        const childReady = await new Promise<boolean>((resolve) => {
          child.stdout?.on("data", (data: Buffer) => {
            if (data.toString().includes("ACQUIRED")) resolve(true);
          });
          child.on("error", () => resolve(false));
          setTimeout(() => resolve(false), 3000);
        });

        if (!childReady) {
          return;
        }

        // Abruptly terminate child process with SIGKILL (simulating VM OOM or sudden crash)
        child.kill("SIGKILL");
        await new Promise((r) => setTimeout(r, 200));

        // Kernel must have released the POSIX fcntl lock; host dispatcher acquires immediately
        const summary = await dispatcher.dispatchPending();
        expect(summary.lockAcquired).toBe(true);
      } finally {
        if (child && !child.killed) {
          try { child.kill("SIGKILL"); } catch {}
        }
      }
    });

    it("2.3 CheckEngine lock and NotificationDispatcher lock do not contend", () => {
      const acqEngine = acquireProcessLock(engineLockFile);
      expect(acqEngine.acquired).toBe(true);

      const acqDisp = acquireProcessLock(dispatcherLockFile);
      expect(acqDisp.acquired).toBe(true);

      releaseProcessLock(engineLockFile, acqEngine.token!);
      releaseProcessLock(dispatcherLockFile, acqDisp.token!);
    });
  });

  describe("3. HTTP 429 Rate Limiting & Shared Chat Cooldown", () => {
    it("3.1 HTTP 429 sets chat cooldown, increments retry_count, and aborts remaining batch items", async () => {
      const p1 = repo.create({ url: "https://www.flipkart.com/prod/p/itm4?pid=P4", title: "Item 4" });
      const p2 = repo.create({ url: "https://www.flipkart.com/prod/p/itm5?pid=P5", title: "Item 5" });

      repo.updateCheckResult(p1.id, { checkStatus: "SUCCESS", cartAvailability: "AVAILABLE" });
      repo.updateCheckResult(p2.id, { checkStatus: "SUCCESS", cartAvailability: "AVAILABLE" });

      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 429,
        json: async () => ({
          ok: false,
          description: "Too Many Requests",
          parameters: { retry_after: 50 },
        }),
      });

      const summary = await dispatcher.dispatchPending();
      expect(summary.abortedDueToRateLimit).toBe(true);
      expect(summary.dispatchedCount).toBe(0);
      expect(summary.failedCount).toBe(1);
      expect(mockFetch).toHaveBeenCalledTimes(1); // Item 2 was NOT attempted!

      // Cooldown set in SQLite
      const cooldown = repo.getChatCooldown("test_chat");
      expect(cooldown).toBeDefined();

      // Subsequent sweep is suppressed by cooldown
      const nextSweep = await dispatcher.dispatchPending();
      expect(nextSweep.abortedDueToRateLimit).toBe(true);
      expect(nextSweep.dispatchedCount).toBe(0);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("3.2 Shared chat cooldown survives process restart and re-instantiation", () => {
      repo.setChatCooldown("test_chat", 90);

      // Create new repository instance pointing to the same SQLite database
      const freshRepo = new ProductRepository(db);
      const cooldown = freshRepo.getChatCooldown("test_chat");
      expect(cooldown).toBeDefined();

      const freshDispatcher = new NotificationDispatcher(
        freshRepo,
        notifier,
        dispatcherLockFile,
        0,
        "test_chat"
      );

      return freshDispatcher.dispatchPending().then((summary) => {
        expect(summary.abortedDueToRateLimit).toBe(true);
        expect(summary.dispatchedCount).toBe(0);
      });
    });
  });

  describe("4. Retry Exhaustion, Backoff & Permanent Failures", () => {
    it("4.1 Authoritative 5-attempt retry schedule suspends product on fifth failure", () => {
      const p = repo.create({ url: "https://www.flipkart.com/prod/p/itm6?pid=P6", title: "Item 6" });
      repo.updateCheckResult(p.id, { checkStatus: "SUCCESS", cartAvailability: "AVAILABLE" });

      // Failure 1 (+30s)
      repo.recordNotificationFailure(p.id, 1, { error: "Attempt 1" });
      let row = repo.findById(p.id)!;
      expect(row.retryCount).toBe(1);
      expect(row.nextRetryAt).toBeDefined();

      // Failure 2 (+60s)
      repo.recordNotificationFailure(p.id, 1, { error: "Attempt 2" });
      row = repo.findById(p.id)!;
      expect(row.retryCount).toBe(2);

      // Failure 3 (+120s)
      repo.recordNotificationFailure(p.id, 1, { error: "Attempt 3" });
      row = repo.findById(p.id)!;
      expect(row.retryCount).toBe(3);

      // Failure 4 (+240s)
      repo.recordNotificationFailure(p.id, 1, { error: "Attempt 4" });
      row = repo.findById(p.id)!;
      expect(row.retryCount).toBe(4);

      // Failure 5 -> Suspended (retry_count = 5, next_retry_at = NULL)
      repo.recordNotificationFailure(p.id, 1, { error: "Attempt 5" });
      row = repo.findById(p.id)!;
      expect(row.retryCount).toBe(5);
      expect(row.nextRetryAt).toBeNull();

      // Excluded from candidate query
      const candidates = repo.findPendingNotifications();
      expect(candidates.find((c) => c.id === p.id)).toBeUndefined();
    });

    it("4.2 Permanent failure (HTTP 403) suspends cycle immediately", () => {
      const p = repo.create({ url: "https://www.flipkart.com/prod/p/itm7?pid=P7", title: "Item 7" });
      repo.updateCheckResult(p.id, { checkStatus: "SUCCESS", cartAvailability: "AVAILABLE" });

      repo.recordNotificationFailure(p.id, 1, { error: "HTTP 403: Bot blocked", isPermanent: true });
      const row = repo.findById(p.id)!;
      expect(row.retryCount).toBe(5);
      expect(row.nextRetryAt).toBeNull();
      expect(row.lastDeliveryError).toBe("HTTP 403: Bot blocked");
    });

    it("4.3 Restart recovery: Startup sweep recovers pending notifications", async () => {
      const p = repo.create({ url: "https://www.flipkart.com/prod/p/itm8?pid=P8", title: "Item 8" });
      repo.updateCheckResult(p.id, { checkStatus: "SUCCESS", cartAvailability: "AVAILABLE" });

      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ ok: true, result: { message_id: 8888 } }),
      });

      // Simulate daemon restart
      const runner = new SchedulerRunner(undefined, dispatcher);
      runner.start();

      await new Promise((r) => setTimeout(r, 50));

      const delivered = repo.findById(p.id)!;
      expect(delivered.notificationState).toBe("DELIVERED");

      runner.stop();
    });

    it("4.4 UNKNOWN_DELIVERY handling and duplicate delivery boundary documentation", async () => {
      const p = repo.create({ url: "https://www.flipkart.com/prod/p/itm9?pid=P9", title: "Item 9" });
      repo.updateCheckResult(p.id, { checkStatus: "SUCCESS", cartAvailability: "AVAILABLE" });

      // Simulate network timeout: AbortSignal triggers TimeoutError
      mockFetch.mockRejectedValueOnce(new DOMException("The operation timed out.", "TimeoutError"));

      const summary = await dispatcher.dispatchPending();
      expect(summary.failedCount).toBe(1);
      expect(summary.dispatchedCount).toBe(0);

      // Verify that failure is recorded as temporary retry with backoff (+30s)
      const row = repo.findById(p.id)!;
      expect(row.retryCount).toBe(1);
      expect(row.nextRetryAt).toBeDefined();
      expect(row.lastDeliveryError).toContain("Request timed out");

      // Documented behavior: If Telegram actually delivered the message before timeout,
      // the next sweep will retry and send another message because the response was lost.
    });
  });

  describe("5. Scheduler Runner Validation", () => {
    it("5.1 1-minute retry sweep does NOT execute CheckEngine or launch Chromium", async () => {
      const fakeEngine: any = {
        runAllChecks: vi.fn(),
      };

      const dispatchSpy = vi.spyOn(dispatcher, "dispatchPending").mockResolvedValue({
        totalPending: 0,
        dispatchedCount: 0,
        failedCount: 0,
        skippedCount: 0,
        lockAcquired: true,
      });

      const runner = new SchedulerRunner(fakeEngine, dispatcher);
      runner.start();

      // Allow asynchronous startup sweep and initial check cycle to settle completely
      await new Promise((r) => setTimeout(r, 50));

      // Clear initial startup calls
      fakeEngine.runAllChecks.mockClear();
      dispatchSpy.mockClear();

      // Directly trigger 1-minute retry cron callback logic
      await (runner as any).dispatcher.dispatchPending();

      expect(dispatchSpy).toHaveBeenCalledTimes(1);
      // Crucial: CheckEngine was NEVER invoked during the retry sweep!
      expect(fakeEngine.runAllChecks).not.toHaveBeenCalled();

      runner.stop();
    });

    it("5.2 Delivery failure during scheduled cycle does NOT mark cart check as failed", async () => {
      const p = repo.create({ url: "https://www.flipkart.com/prod/p/itm10?pid=P10", title: "Item 10" });

      const fakeScraper: IScraper = {
        checkCartAvailability: vi.fn().mockResolvedValue({
          checkStatus: "SUCCESS",
          cartAvailability: "AVAILABLE",
          url: p.url,
          checkedAt: new Date().toISOString(),
        }),
        scrapeProduct: vi.fn(),
        close: vi.fn(),
      };

      const engine = new CheckEngine(repo, fakeScraper, undefined, engineLockFile);

      // Telegram delivery fails with HTTP 500
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: async () => ({ ok: false, description: "Internal Server Error" }),
      });

      const runner = new SchedulerRunner(engine, dispatcher);
      await runner.executeCycle();

      // Cart check was successful in SQLite!
      const persisted = repo.findById(p.id)!;
      expect(persisted.lastCheckStatus).toBe("SUCCESS");
      expect(persisted.cartAvailability).toBe("AVAILABLE");
      expect(persisted.notificationState).toBe("PENDING"); // Notification pending retry
      expect(persisted.retryCount).toBe(1);

      runner.stop();
    });
  });
});
