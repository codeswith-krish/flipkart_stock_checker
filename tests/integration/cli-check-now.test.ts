import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database, { type Database as DatabaseInstance } from "better-sqlite3";
import { runMigrations } from "../../src/db/migrations.js";
import { ProductRepository } from "../../src/db/repositories/product.repository.js";
import { checkNowCommand } from "../../src/cli/commands/check-now.js";
import { listCommand } from "../../src/cli/commands/list.js";
import * as browserModule from "../../src/modules/scraper/browser.js";
import { checkEngine } from "../../src/modules/checker/check-engine.js";
import { notificationDispatcher } from "../../src/modules/notifier/dispatcher.js";

// Hoist database state to avoid temporal dead zone (TDZ) reference errors during vi.mock() hoisting
const dbState = vi.hoisted(() => ({
  instance: null as DatabaseInstance | null,
}));

vi.mock("../../src/db/client.js", () => {
  return {
    getDb: () => {
      if (!dbState.instance) {
        dbState.instance = new Database(":memory:");
        runMigrations(dbState.instance);
      }
      return dbState.instance;
    },
    closeDb: () => {
      if (dbState.instance && dbState.instance.open) {
        dbState.instance.close();
      }
      dbState.instance = null;
    },
  };
});

describe("CLI check-now & list Integration Testing", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let tableSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let closeBrowserSpy: ReturnType<typeof vi.spyOn>;
  let repo: ProductRepository;
  let executionOrder: string[];

  beforeEach(() => {
    if (dbState.instance && dbState.instance.open) {
      dbState.instance.close();
    }
    dbState.instance = new Database(":memory:");
    runMigrations(dbState.instance);
    repo = new ProductRepository(dbState.instance);

    executionOrder = [];

    logSpy = vi.spyOn(console, "log").mockImplementation((...args) => {
      executionOrder.push(`log:${args[0]}`);
    });
    errorSpy = vi.spyOn(console, "error").mockImplementation((...args) => {
      executionOrder.push(`error:${args[0]}`);
    });
    tableSpy = vi.spyOn(console, "table").mockImplementation(() => {});
    exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {}) as unknown as (code?: string | number | null | undefined) => never);

    closeBrowserSpy = vi.spyOn(browserModule, "closeBrowser").mockImplementation(async () => {
      executionOrder.push("closeBrowser");
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (dbState.instance && dbState.instance.open) {
      dbState.instance.close();
    }
    dbState.instance = null;
  });

  describe("1. stock check-now Single Product Execution", () => {
    it("should verify cart availability, close browser in finally, and dispatch alert", async () => {
      const p = repo.create({ url: "https://www.flipkart.com/item/p/itm1?pid=PID1", title: "Item 1" });

      // Mock checkEngine.runSingleCheck
      const runSingleCheckSpy = vi.spyOn(checkEngine, "runSingleCheck").mockImplementation(async () => {
        executionOrder.push("runSingleCheck");
        repo.updateCheckResult(p.id, { checkStatus: "SUCCESS", cartAvailability: "AVAILABLE" });
        return {
          productId: p.id,
          url: p.url,
          checkStatus: "SUCCESS",
          cartAvailability: "AVAILABLE",
          alertTriggered: true,
          notificationQueued: true,
        };
      });

      // Mock dispatcher.dispatchPending
      const dispatchSpy = vi.spyOn(notificationDispatcher, "dispatchPending").mockImplementation(async () => {
        executionOrder.push("dispatchPending");
        repo.markNotificationDelivered(p.id, 1, new Date().toISOString());
        return {
          totalPending: 1,
          dispatchedCount: 1,
          failedCount: 0,
          skippedCount: 0,
          lockAcquired: true,
        };
      });

      await checkNowCommand({ id: String(p.id) });

      expect(runSingleCheckSpy).toHaveBeenCalledTimes(1);
      expect(closeBrowserSpy).toHaveBeenCalledTimes(1);
      expect(dispatchSpy).toHaveBeenCalledTimes(1);

      // Verify strict execution ordering: closeBrowser happens BEFORE dispatchPending!
      const closeBrowserIdx = executionOrder.indexOf("closeBrowser");
      const dispatchIdx = executionOrder.indexOf("dispatchPending");
      expect(closeBrowserIdx).toBeGreaterThanOrEqual(0);
      expect(dispatchIdx).toBeGreaterThan(closeBrowserIdx);

      // Verify console outputs
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Cart Availability: AVAILABLE"));
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Notification Queued: Yes"));
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Dispatched 1 Telegram alert(s)"));
      expect(exitSpy).not.toHaveBeenCalled();

      // Verify persisted state
      const finalRow = repo.findById(p.id)!;
      expect(finalRow.notificationState).toBe("DELIVERED");
    });

    it("should exit with code 1 if product ID does not exist", async () => {
      await checkNowCommand({ id: "9999" });

      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Product ID 9999 not found"));
      expect(exitSpy).toHaveBeenCalledWith(1);
    });
  });

  describe("2. stock check-now Full Cycle Execution", () => {
    it("should run all active checks, close browser, and trigger batch dispatch sweep", async () => {
      const p1 = repo.create({ url: "https://www.flipkart.com/item-a/p/itm_a?pid=PIDA", title: "Item A" });
      const p2 = repo.create({ url: "https://www.flipkart.com/item-b/p/itm_b?pid=PIDB", title: "Item B" });

      const runAllChecksSpy = vi.spyOn(checkEngine, "runAllChecks").mockImplementation(async () => {
        executionOrder.push("runAllChecks");
        repo.updateCheckResult(p1.id, { checkStatus: "SUCCESS", cartAvailability: "AVAILABLE" });
        repo.updateCheckResult(p2.id, { checkStatus: "SUCCESS", cartAvailability: "AVAILABLE" });
        return {
          totalChecked: 2,
          successfulChecks: 2,
          failedChecks: 0,
          alertsTriggered: 2,
          results: [],
        };
      });

      const dispatchSpy = vi.spyOn(notificationDispatcher, "dispatchPending").mockImplementation(async () => {
        executionOrder.push("dispatchPending");
        repo.markNotificationDelivered(p1.id, 1);
        repo.markNotificationDelivered(p2.id, 1);
        return {
          totalPending: 2,
          dispatchedCount: 2,
          failedCount: 0,
          skippedCount: 0,
          lockAcquired: true,
        };
      });

      await checkNowCommand({});

      expect(runAllChecksSpy).toHaveBeenCalledTimes(1);
      expect(closeBrowserSpy).toHaveBeenCalledTimes(1);
      expect(dispatchSpy).toHaveBeenCalledTimes(1);

      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Total Checked:    2"));
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Notifications Queued: 2"));
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Dispatched 2 Telegram alert(s)"));
    });
  });

  describe("3. Delivery Failures Isolated from Check Results", () => {
    it("should report successful check even when Telegram dispatch throws or fails", async () => {
      const p = repo.create({ url: "https://www.flipkart.com/item-c/p/itm_c?pid=PIDC", title: "Item C" });

      vi.spyOn(checkEngine, "runSingleCheck").mockImplementation(async () => {
        repo.updateCheckResult(p.id, { checkStatus: "SUCCESS", cartAvailability: "AVAILABLE" });
        return {
          productId: p.id,
          url: p.url,
          checkStatus: "SUCCESS",
          cartAvailability: "AVAILABLE",
          alertTriggered: true,
          notificationQueued: true,
        };
      });

      // Dispatcher returns 0 dispatched due to error
      vi.spyOn(notificationDispatcher, "dispatchPending").mockImplementation(async () => {
        repo.recordNotificationFailure(p.id, 1, { error: "HTTP 500 error" });
        return {
          totalPending: 1,
          dispatchedCount: 0,
          failedCount: 1,
          skippedCount: 0,
          lockAcquired: true,
        };
      });

      await checkNowCommand({ id: String(p.id) });

      // Check result was displayed as SUCCESS
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Cart Availability: AVAILABLE"));
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Check Status:      SUCCESS"));

      // Cart check record in database is NOT corrupted
      const row = repo.findById(p.id)!;
      expect(row.lastCheckStatus).toBe("SUCCESS");
      expect(row.cartAvailability).toBe("AVAILABLE");
      expect(row.notificationState).toBe("PENDING");
      expect(row.retryCount).toBe(1);
    });
  });

  describe("4. stock list Suspension Display", () => {
    it("should display Alert State: SUSPENDED when retryCount >= 5", () => {
      const p1 = repo.create({ url: "https://www.flipkart.com/item-1/p/itm1?pid=PID1", title: "Active Normal" });
      const p2 = repo.create({ url: "https://www.flipkart.com/item-2/p/itm2?pid=PID2", title: "Suspended Item" });

      // p1 is normal PENDING
      repo.updateCheckResult(p1.id, { checkStatus: "SUCCESS", cartAvailability: "AVAILABLE" });

      // p2 reached 5 failures (suspended)
      repo.updateCheckResult(p2.id, { checkStatus: "SUCCESS", cartAvailability: "AVAILABLE" });
      repo.recordNotificationFailure(p2.id, 1, { error: "Permanent fail", isPermanent: true });

      listCommand({});

      expect(tableSpy).toHaveBeenCalled();
      const rows = tableSpy.mock.calls[0][0] as Record<string, unknown>[];
      expect(rows.length).toBe(2);

      const rowP1 = rows.find((r) => r.ID === p1.id);
      expect(rowP1?.["Alert State"]).toBe("PENDING");

      const rowP2 = rows.find((r) => r.ID === p2.id);
      expect(rowP2?.["Alert State"]).toBe("SUSPENDED");
    });
  });

  describe("5. Security & Redaction Audit", () => {
    it("should verify no raw bot tokens or sensitive secrets are logged", async () => {
      const p = repo.create({ url: "https://www.flipkart.com/item-s/p/itm_s?pid=PIDS", title: "Security Item" });

      vi.spyOn(checkEngine, "runSingleCheck").mockResolvedValue({
        productId: p.id,
        url: p.url,
        checkStatus: "SUCCESS",
        cartAvailability: "AVAILABLE",
        alertTriggered: true,
        notificationQueued: true,
      });

      await checkNowCommand({ id: String(p.id) });

      const allOutput = executionOrder.join(" ");
      expect(allOutput).not.toContain("bot_token");
      expect(allOutput).not.toContain("password");
      expect(allOutput).not.toContain("cookie");
    });
  });
});
