import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database, { type Database as DatabaseInstance } from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { runMigrations } from "../../src/db/migrations.js";
import { ProductRepository } from "../../src/db/repositories/product.repository.js";
import { CheckEngine } from "../../src/modules/checker/check-engine.js";
import type { IScraper, CartCheckResult, ScrapedProductData } from "../../src/modules/scraper/types.js";
import { AppError, DatabaseError } from "../../src/shared/errors.js";
import * as processLockModule from "../../src/modules/checker/process-lock.js";

/**
 * Deterministic Mock Scraper for CheckEngine integration testing.
 */
class MockScraper implements IScraper {
  public mockResults: Map<string, CartCheckResult> = new Map();
  public defaultResult?: CartCheckResult;
  public checkCallLog: string[] = [];
  public delayMs: number = 0;
  public shouldRejectWithError?: Error;

  async checkCartAvailability(url: string, expectedProductId?: string | null): Promise<CartCheckResult> {
    this.checkCallLog.push(url);

    if (this.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    }

    if (this.shouldRejectWithError) {
      throw this.shouldRejectWithError;
    }

    const res = this.mockResults.get(url) || this.defaultResult;
    if (res) {
      return res;
    }

    // Default mock response: SUCCESS + AVAILABLE
    return {
      checkStatus: "SUCCESS",
      cartAvailability: "AVAILABLE",
      url,
      productId: expectedProductId || "itm123",
      productTitle: "Sample Product",
      reason: "VERIFIED_NEW_ADD_TO_CART",
      evidence: {
        buttonFound: true,
        buttonText: "ADD TO CART",
        buttonState: "ENABLED",
        cartNavigated: true,
        cartUrl: "https://www.flipkart.com/viewcart",
        matchedBy: "PRODUCT_ID",
        matchedItemId: expectedProductId || "itm123",
        matchedItemTitle: "Sample Product",
        staleCartDetected: false,
        preExistingCartCheckPerformed: false,
      },
      checkedAt: new Date().toISOString(),
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async scrapeProduct(url: string): Promise<ScrapedProductData> {
    return {
      url,
      title: "Sample Product",
      price: 1999,
      inStock: true,
    };
  }

  async close(): Promise<void> {}
}

describe("CheckEngine Integration & SQLite State Management", () => {
  let db: DatabaseInstance;
  let productRepo: ProductRepository;
  let mockScraper: MockScraper;
  let checkEngine: CheckEngine;
  let tempLockFile: string;

  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db);
    productRepo = new ProductRepository(db);
    mockScraper = new MockScraper();

    tempLockFile = path.join(
      os.tmpdir(),
      `test_lock_${Date.now()}_${Math.random().toString(36).slice(2)}.sqlite`
    );

    checkEngine = new CheckEngine(productRepo, mockScraper, undefined, tempLockFile);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    processLockModule._resetActiveLockConnectionsForTesting();
    if (db && db.open) {
      db.close();
    }
    if (fs.existsSync(tempLockFile)) {
      try {
        fs.unlinkSync(tempLockFile);
      } catch {}
    }
  });

  describe("Scenario 1: Successful New Cart Addition", () => {
    it("should update SQLite to AVAILABLE, SUCCESS, and transition notification to PENDING", async () => {
      const product = productRepo.create({
        url: "https://www.flipkart.com/p/itm_test1",
        title: "Gadget One",
      });

      mockScraper.defaultResult = {
        checkStatus: "SUCCESS",
        cartAvailability: "AVAILABLE",
        url: product.url,
        productId: product.productId,
        productTitle: product.title,
        reason: "VERIFIED_NEW_ADD_TO_CART",
        evidence: {
          buttonFound: true,
          buttonText: "ADD TO CART",
          buttonState: "ENABLED",
          cartNavigated: true,
          cartUrl: "https://www.flipkart.com/viewcart",
          matchedBy: "PRODUCT_ID",
          matchedItemId: "itm_test1",
          matchedItemTitle: "Gadget One",
          staleCartDetected: false,
          preExistingCartCheckPerformed: false,
        },
        checkedAt: new Date().toISOString(),
      };

      const result = await checkEngine.runSingleCheck(product.id);

      expect(result.checkStatus).toBe("SUCCESS");
      expect(result.cartAvailability).toBe("AVAILABLE");
      expect(result.alertTriggered).toBe(true);
      expect(result.notificationQueued).toBe(true);
      expect(result.reason).toBe("VERIFIED_NEW_ADD_TO_CART");

      // Verify authoritative SQLite state
      const updated = productRepo.findById(product.id)!;
      expect(updated.cartAvailability).toBe("AVAILABLE");
      expect(updated.lastCheckStatus).toBe("SUCCESS");
      expect(updated.lastErrorMessage).toBeNull();
      expect(updated.notificationState).toBe("PENDING");
      expect(updated.lastCheckedAt).not.toBeNull();
    });
  });

  describe("Scenario 2: Product Already in Cart", () => {
    it("should qualify as verified availability, queue notification, and preserve ALREADY_IN_CART reason", async () => {
      const product = productRepo.create({
        url: "https://www.flipkart.com/p/itm_test2",
        title: "Gadget Two",
      });

      mockScraper.defaultResult = {
        checkStatus: "SUCCESS",
        cartAvailability: "AVAILABLE",
        url: product.url,
        productId: product.productId,
        productTitle: product.title,
        reason: "ALREADY_IN_CART",
        evidence: {
          buttonFound: true,
          buttonText: "GO TO CART",
          buttonState: "ENABLED",
          cartNavigated: true,
          cartUrl: "https://www.flipkart.com/viewcart",
          matchedBy: "PRODUCT_ID",
          matchedItemId: "itm_test2",
          matchedItemTitle: "Gadget Two",
          staleCartDetected: false,
          preExistingCartCheckPerformed: false,
        },
        checkedAt: new Date().toISOString(),
      };

      const result = await checkEngine.runSingleCheck(product);

      expect(result.checkStatus).toBe("SUCCESS");
      expect(result.cartAvailability).toBe("AVAILABLE");
      expect(result.alertTriggered).toBe(true);
      expect(result.notificationQueued).toBe(true);
      expect(result.reason).toBe("ALREADY_IN_CART");

      const updated = productRepo.findById(product.id)!;
      expect(updated.cartAvailability).toBe("AVAILABLE");
      expect(updated.notificationState).toBe("PENDING");
    });
  });

  describe("Scenario 3: Confirmed Out of Stock", () => {
    it("should update SQLite to OUT_OF_STOCK and reset notification state to IDLE", async () => {
      const product = productRepo.create({
        url: "https://www.flipkart.com/p/itm_test3",
        title: "Gadget Three",
      });

      // Set product as previously DELIVERED
      productRepo.updateCheckResult(product.id, {
        checkStatus: "SUCCESS",
        cartAvailability: "AVAILABLE",
      });
      productRepo.updateNotificationState(product.id, "DELIVERED");

      mockScraper.defaultResult = {
        checkStatus: "SUCCESS",
        cartAvailability: "OUT_OF_STOCK",
        url: product.url,
        productId: product.productId,
        productTitle: product.title,
        reason: "EXPLICIT_OUT_OF_STOCK_BANNER",
        evidence: {
          buttonFound: false,
          buttonText: null,
          buttonState: "NOT_FOUND",
          cartNavigated: false,
          cartUrl: null,
          matchedBy: "NONE",
          matchedItemId: null,
          matchedItemTitle: null,
          staleCartDetected: false,
          preExistingCartCheckPerformed: false,
        },
        checkedAt: new Date().toISOString(),
      };

      const result = await checkEngine.runSingleCheck(product.id);

      expect(result.checkStatus).toBe("SUCCESS");
      expect(result.cartAvailability).toBe("OUT_OF_STOCK");
      expect(result.alertTriggered).toBe(false);
      expect(result.notificationQueued).toBe(false);

      const updated = productRepo.findById(product.id)!;
      expect(updated.cartAvailability).toBe("OUT_OF_STOCK");
      expect(updated.notificationState).toBe("IDLE"); // Re-armed for future stock
    });
  });

  describe("Scenario 4: Technical Error Preserving AVAILABLE", () => {
    it("should preserve existing AVAILABLE and notificationState when scraper returns an error", async () => {
      const product = productRepo.create({
        url: "https://www.flipkart.com/p/itm_test4",
        title: "Gadget Four",
      });

      // Establish initial AVAILABLE and DELIVERED state
      productRepo.updateCheckResult(product.id, {
        checkStatus: "SUCCESS",
        cartAvailability: "AVAILABLE",
      });
      productRepo.updateNotificationState(product.id, "DELIVERED");

      mockScraper.defaultResult = {
        checkStatus: "ERROR",
        cartAvailability: "UNKNOWN",
        url: product.url,
        productId: product.productId,
        productTitle: product.title,
        errorReason: "LOGIN_REQUIRED",
        errorMessage: "Redirected to Flipkart account login page",
        evidence: {
          buttonFound: false,
          buttonText: null,
          buttonState: "NOT_FOUND",
          cartNavigated: false,
          cartUrl: null,
          matchedBy: "NONE",
          matchedItemId: null,
          matchedItemTitle: null,
          staleCartDetected: false,
          preExistingCartCheckPerformed: false,
        },
        checkedAt: new Date().toISOString(),
      };

      const result = await checkEngine.runSingleCheck(product.id);

      expect(result.checkStatus).toBe("ERROR");
      expect(result.cartAvailability).toBe("AVAILABLE"); // Preserved in CheckResult
      expect(result.alertTriggered).toBe(false);
      expect(result.notificationQueued).toBe(false);
      expect(result.error).toContain("login");

      const updated = productRepo.findById(product.id)!;
      expect(updated.cartAvailability).toBe("AVAILABLE"); // Preserved in SQLite
      expect(updated.lastCheckStatus).toBe("ERROR");
      expect(updated.notificationState).toBe("DELIVERED"); // Preserved
      expect(updated.lastErrorMessage).toContain("login");
    });
  });

  describe("Scenario 5: Repeated AVAILABLE Check Preserves PENDING & DELIVERED", () => {
    it("should preserve PENDING state without duplicate alerts on repeated AVAILABLE checks", async () => {
      const product = productRepo.create({
        url: "https://www.flipkart.com/p/itm_test5",
        title: "Gadget Five",
      });

      // First check: transitions to PENDING
      const firstResult = await checkEngine.runSingleCheck(product.id);
      expect(firstResult.notificationQueued).toBe(true);

      const firstDb = productRepo.findById(product.id)!;
      expect(firstDb.notificationState).toBe("PENDING");

      // Second check: already PENDING -> should not duplicate notification
      const secondResult = await checkEngine.runSingleCheck(product.id);
      expect(secondResult.notificationQueued).toBe(false);
      expect(secondResult.alertTriggered).toBe(false);

      const secondDb = productRepo.findById(product.id)!;
      expect(secondDb.notificationState).toBe("PENDING");
    });

    it("should preserve DELIVERED state without duplicate alerts on repeated AVAILABLE checks", async () => {
      const product = productRepo.create({
        url: "https://www.flipkart.com/p/itm_test5b",
        title: "Gadget Five B",
      });

      productRepo.updateCheckResult(product.id, {
        checkStatus: "SUCCESS",
        cartAvailability: "AVAILABLE",
      });
      productRepo.updateNotificationState(product.id, "DELIVERED");

      const result = await checkEngine.runSingleCheck(product.id);
      expect(result.notificationQueued).toBe(false);
      expect(result.alertTriggered).toBe(false);

      const dbRow = productRepo.findById(product.id)!;
      expect(dbRow.notificationState).toBe("DELIVERED");
    });
  });

  describe("Scenario 6: OUT_OF_STOCK -> AVAILABLE Restock Transition", () => {
    it("should re-arm and trigger PENDING notification when an out-of-stock product restocks", async () => {
      const product = productRepo.create({
        url: "https://www.flipkart.com/p/itm_test6",
        title: "Gadget Six",
      });

      // Initially OUT_OF_STOCK and IDLE
      productRepo.updateCheckResult(product.id, {
        checkStatus: "SUCCESS",
        cartAvailability: "OUT_OF_STOCK",
      });

      const dbOos = productRepo.findById(product.id)!;
      expect(dbOos.notificationState).toBe("IDLE");

      // Product restocks!
      const restockResult = await checkEngine.runSingleCheck(product.id);
      expect(restockResult.cartAvailability).toBe("AVAILABLE");
      expect(restockResult.notificationQueued).toBe(true);
      expect(restockResult.alertTriggered).toBe(true);

      const dbRestocked = productRepo.findById(product.id)!;
      expect(dbRestocked.notificationState).toBe("PENDING");
    });
  });

  describe("Scenario 7: Stale Product Object Reloading", () => {
    it("should discard stale caller-provided properties and reload authoritative row from SQLite", async () => {
      const product = productRepo.create({
        url: "https://www.flipkart.com/p/itm_test7",
        title: "Gadget Seven",
      });

      // Deactivate product in SQLite directly
      productRepo.deactivate(product.id);

      // Pass the stale product object that still has isActive: true
      const staleProduct = { ...product, isActive: true };

      await expect(checkEngine.runSingleCheck(staleProduct)).rejects.toThrow(
        "Product with ID " + product.id + " is inactive"
      );
    });
  });

  describe("Scenario 8: Missing and Inactive Products", () => {
    it("should reject non-existent product ID with PRODUCT_NOT_FOUND", async () => {
      await expect(checkEngine.runSingleCheck(99999)).rejects.toThrow(
        /Product with ID 99999 not found/
      );
    });

    it("should reject invalid product ID with INVALID_PRODUCT_ID", async () => {
      await expect(checkEngine.runSingleCheck(NaN)).rejects.toThrow(
        /Invalid product ID/
      );
    });
  });

  describe("Scenario 9: Sequential runAllChecks()", () => {
    it("should execute checks sequentially for active products and skip inactive products", async () => {
      const p1 = productRepo.create({ url: "https://www.flipkart.com/p/itm_seq1", title: "Product 1" });
      const p2 = productRepo.create({ url: "https://www.flipkart.com/p/itm_seq2", title: "Product 2" });
      const p3 = productRepo.create({ url: "https://www.flipkart.com/p/itm_seq3", title: "Product 3" });

      // Deactivate p2
      productRepo.deactivate(p2.id);

      const summary = await checkEngine.runAllChecks();

      expect(summary.totalChecked).toBe(2);
      expect(summary.alertsTriggered).toBe(2);
      expect(mockScraper.checkCallLog).toEqual([p1.url, p3.url]);
      expect(mockScraper.checkCallLog).not.toContain(p2.url);
    });
  });

  describe("Scenario 10: Same-Product Concurrency Lock", () => {
    it("should reject simultaneous checks on the same product with CONCURRENT_CHECK_CONFLICT", async () => {
      const product = productRepo.create({
        url: "https://www.flipkart.com/p/itm_test10",
        title: "Gadget Ten",
      });

      mockScraper.delayMs = 100;

      // Start first check asynchronously
      const promise1 = checkEngine.runSingleCheck(product.id);

      // Attempt second check while first is still active
      await expect(checkEngine.runSingleCheck(product.id)).rejects.toThrow(
        "Check for product ID " + product.id + " is already in progress"
      );

      await promise1;
    });
  });

  describe("Scenario 11: Full-Cycle Overlap Prevention & Nested Lock Ownership", () => {
    it("should reject overlapping runAllChecks() calls with CONCURRENT_CYCLE_CONFLICT", async () => {
      productRepo.create({ url: "https://www.flipkart.com/p/itm_test11", title: "Gadget Eleven" });
      mockScraper.delayMs = 100;

      const cycle1 = checkEngine.runAllChecks();

      await expect(checkEngine.runAllChecks()).rejects.toThrow(
        "A check cycle is already currently running"
      );

      await cycle1;
    });

    it("should not deadlock runAllChecks() against its own internal runSingleCheck() calls", async () => {
      productRepo.create({ url: "https://www.flipkart.com/p/itm_test11b", title: "Gadget Eleven B" });

      // If runAllChecks deadlocked with runSingleCheck, this would hang/throw
      const summary = await checkEngine.runAllChecks();
      expect(summary.totalChecked).toBe(1);
    });
  });

  describe("Scenario 12: Cross-Process Lock Contention", () => {
    it("should detect lock held by living process and reject with CONCURRENT_CYCLE_CONFLICT", async () => {
      productRepo.create({ url: "https://www.flipkart.com/p/itm_test12", title: "Gadget Twelve" });

      // Acquire OS lock simulating an active concurrent process
      const externalAcq = processLockModule.acquireProcessLock(tempLockFile);
      expect(externalAcq.acquired).toBe(true);

      await expect(checkEngine.runAllChecks()).rejects.toThrow(
        /Cannot start check cycle:.*(SQLITE_BUSY|cross-process lock)/
      );

      // Release external lock
      if (externalAcq.token) {
        processLockModule.releaseProcessLock(tempLockFile, externalAcq.token);
      }
    });
  });

  describe("Scenario 13: Stale-Lock Recovery", () => {
    it("should safely acquire lock immediately once previous holder releases without unlinking", async () => {
      productRepo.create({ url: "https://www.flipkart.com/p/itm_test13", title: "Gadget Thirteen" });

      // First holder acquires and releases
      const acq1 = processLockModule.acquireProcessLock(tempLockFile);
      expect(acq1.acquired).toBe(true);
      processLockModule.releaseProcessLock(tempLockFile, acq1.token!);

      // Next execution succeeds without any manual unlinking
      const summary = await checkEngine.runAllChecks();
      expect(summary.totalChecked).toBe(1);
    });
  });

  describe("Scenario 14: Lock Release After Failures", () => {
    it("should guarantee release of product lock when scraper throws an unexpected exception", async () => {
      const product = productRepo.create({
        url: "https://www.flipkart.com/p/itm_test14",
        title: "Gadget Fourteen",
      });

      mockScraper.shouldRejectWithError = new Error("Scraper crashed unexpectedly");

      const result = await checkEngine.runSingleCheck(product.id);
      expect(result.checkStatus).toBe("ERROR");
      expect(result.error).toContain("Scraper crashed");

      // Verify lock was released: subsequent check succeeds without CONCURRENT_CHECK_CONFLICT
      mockScraper.shouldRejectWithError = undefined;
      const secondCheck = await checkEngine.runSingleCheck(product.id);
      expect(secondCheck.checkStatus).toBe("SUCCESS");
    });

    it("should guarantee release of product lock when database update fails", async () => {
      const product = productRepo.create({
        url: "https://www.flipkart.com/p/itm_test14b",
        title: "Gadget Fourteen B",
      });

      vi.spyOn(productRepo, "updateCheckResult").mockImplementationOnce(() => {
        throw new DatabaseError("Simulated disk write failure");
      });

      await expect(checkEngine.runSingleCheck(product.id)).rejects.toThrow(
        "Simulated disk write failure"
      );

      // Verify lock was released: subsequent check does not fail with conflict
      const result = await checkEngine.runSingleCheck(product.id);
      expect(result.checkStatus).toBe("SUCCESS");
    });
  });

  describe("Scenario 15: Database Failure Propagation", () => {
    it("should directly propagate DatabaseError without swallowing as scraper error", async () => {
      const product = productRepo.create({
        url: "https://www.flipkart.com/p/itm_test15",
        title: "Gadget Fifteen",
      });

      vi.spyOn(productRepo, "updateCheckResult").mockImplementationOnce(() => {
        throw new DatabaseError("Fatal SQLite error: disk I/O error");
      });

      await expect(checkEngine.runSingleCheck(product.id)).rejects.toThrow(
        DatabaseError
      );
    });
  });

  describe("Scenario 16: Error Message Sanitization", () => {
    it("should redact sensitive cookies, tokens, and session paths from error messages", async () => {
      const product = productRepo.create({
        url: "https://www.flipkart.com/p/itm_test16",
        title: "Gadget Sixteen",
      });

      mockScraper.defaultResult = {
        checkStatus: "ERROR",
        cartAvailability: "UNKNOWN",
        url: product.url,
        productId: product.productId,
        productTitle: product.title,
        errorReason: "BROWSER_ERROR",
        errorMessage:
          "Crash occurred while reading auth_token: secret_token_xyz123 and cookie: session_id=abc456 from /home/user/data/flipkart_session.json",
        evidence: {
          buttonFound: false,
          buttonText: null,
          buttonState: "NOT_FOUND",
          cartNavigated: false,
          cartUrl: null,
          matchedBy: "NONE",
          matchedItemId: null,
          matchedItemTitle: null,
          staleCartDetected: false,
          preExistingCartCheckPerformed: false,
        },
        checkedAt: new Date().toISOString(),
      };

      const result = await checkEngine.runSingleCheck(product.id);

      expect(result.error).not.toContain("secret_token_xyz123");
      expect(result.error).not.toContain("abc456");
      expect(result.error).not.toContain("/home/user/data/flipkart_session.json");
      expect(result.error).toContain("[REDACTED]");
      expect(result.error).toContain("[SESSION_STORAGE_PATH]");

      const dbRow = productRepo.findById(product.id)!;
      expect(dbRow.lastErrorMessage).toContain("[REDACTED]");
    });
  });

  describe("Scenario 17: Process Restart & SQLite Persistence (File-backed DB)", () => {
    let tempDbFile: string;

    beforeEach(() => {
      tempDbFile = path.join(
        os.tmpdir(),
        `test_file_db_${Date.now()}_${Math.random().toString(36).slice(2)}.db`
      );
    });

    afterEach(() => {
      for (const ext of ["", "-wal", "-shm"]) {
        const file = `${tempDbFile}${ext}`;
        if (fs.existsSync(file)) {
          try {
            fs.unlinkSync(file);
          } catch {}
        }
      }
    });

    it("should verify cart availability, check status, and notification state survive connection close and reopen", async () => {
      // 1. Initial process session
      const diskDb1 = new Database(tempDbFile);
      runMigrations(diskDb1);
      const repo1 = new ProductRepository(diskDb1);
      const scraper1 = new MockScraper();
      const engine1 = new CheckEngine(repo1, scraper1, undefined, ":memory:");

      const product = repo1.create({
        url: "https://www.flipkart.com/p/itm_persist1",
        title: "Persistent Product",
      });

      const check1 = await engine1.runSingleCheck(product.id);
      expect(check1.cartAvailability).toBe("AVAILABLE");
      expect(check1.notificationQueued).toBe(true);

      diskDb1.close(); // Simulate process termination

      // 2. Restarted process session: open brand new connection to the same file
      const diskDb2 = new Database(tempDbFile);
      const repo2 = new ProductRepository(diskDb2);
      const scraper2 = new MockScraper();
      const engine2 = new CheckEngine(repo2, scraper2, undefined, ":memory:");

      const reloaded = repo2.findById(product.id)!;
      expect(reloaded.cartAvailability).toBe("AVAILABLE");
      expect(reloaded.lastCheckStatus).toBe("SUCCESS");
      expect(reloaded.notificationState).toBe("PENDING");
      expect(reloaded.lastErrorMessage).toBeNull();

      // Second check in restarted process: should maintain PENDING without duplicate alert
      const check2 = await engine2.runSingleCheck(product.id);
      expect(check2.cartAvailability).toBe("AVAILABLE");
      expect(check2.notificationQueued).toBe(false);

      diskDb2.close();
    });
  });

  describe("Scenario 18: Recovery After Technical Error", () => {
    it("should clear previous error messages and restore SUCCESS when check recovers", async () => {
      const product = productRepo.create({
        url: "https://www.flipkart.com/p/itm_test18",
        title: "Gadget Eighteen",
      });

      // 1. First check fails with timeout
      mockScraper.defaultResult = {
        checkStatus: "ERROR",
        cartAvailability: "UNKNOWN",
        url: product.url,
        productId: product.productId,
        productTitle: product.title,
        errorReason: "NAVIGATION_TIMEOUT",
        errorMessage: "Navigation timed out after 30000ms",
        evidence: {
          buttonFound: false,
          buttonText: null,
          buttonState: "NOT_FOUND",
          cartNavigated: false,
          cartUrl: null,
          matchedBy: "NONE",
          matchedItemId: null,
          matchedItemTitle: null,
          staleCartDetected: false,
          preExistingCartCheckPerformed: false,
        },
        checkedAt: new Date().toISOString(),
      };

      const errResult = await checkEngine.runSingleCheck(product.id);
      expect(errResult.checkStatus).toBe("ERROR");

      const dbErr = productRepo.findById(product.id)!;
      expect(dbErr.lastCheckStatus).toBe("ERROR");
      expect(dbErr.lastErrorMessage).toContain("Navigation timed out");

      // 2. Subsequent check recovers
      mockScraper.defaultResult = {
        checkStatus: "SUCCESS",
        cartAvailability: "AVAILABLE",
        url: product.url,
        productId: product.productId,
        productTitle: product.title,
        reason: "VERIFIED_NEW_ADD_TO_CART",
        evidence: {
          buttonFound: true,
          buttonText: "ADD TO CART",
          buttonState: "ENABLED",
          cartNavigated: true,
          cartUrl: "https://www.flipkart.com/viewcart",
          matchedBy: "PRODUCT_ID",
          matchedItemId: "itm_test18",
          matchedItemTitle: "Gadget Eighteen",
          staleCartDetected: false,
          preExistingCartCheckPerformed: false,
        },
        checkedAt: new Date().toISOString(),
      };

      const recoveredResult = await checkEngine.runSingleCheck(product.id);
      expect(recoveredResult.checkStatus).toBe("SUCCESS");
      expect(recoveredResult.cartAvailability).toBe("AVAILABLE");

      const dbRecovered = productRepo.findById(product.id)!;
      expect(dbRecovered.lastCheckStatus).toBe("SUCCESS");
      expect(dbRecovered.lastErrorMessage).toBeNull(); // Cleared!
    });
  });
});
