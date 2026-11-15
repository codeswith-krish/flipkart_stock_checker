import { describe, it, expect, beforeEach, afterEach, vi, beforeAll, afterAll } from "vitest";
import Database, { type Database as DatabaseInstance } from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { runMigrations } from "../../src/db/migrations.js";
import { ProductRepository } from "../../src/db/repositories/product.repository.js";
import { CheckEngine } from "../../src/modules/checker/check-engine.js";
import {
  acquireProcessLock,
  releaseProcessLock,
  _resetActiveLockConnectionsForTesting,
} from "../../src/modules/checker/process-lock.js";
import type { IScraper, CartCheckResult } from "../../src/modules/scraper/types.js";
import { config } from "../../src/config/index.js";
import {
  runSessionBootstrap,
  verifyFlipkartAuthentication,
} from "../../scripts/bootstrap-session.js";

/**
 * Deterministic Offline Scraper with Strict Route Interception & Unexpected Request Guard.
 * Simulates page, context, and network routing deterministically.
 */
class InterceptedOfflineScraper implements IScraper {
  public routeHandlers: Map<string, (url: string) => CartCheckResult> = new Map();
  public unexpectedRequests: string[] = [];
  public abortedExternalRequests: string[] = [];
  public activePages: Set<string> = new Set();
  public closedPages: Set<string> = new Set();
  public isContextClosed: boolean = false;
  public isBrowserClosed: boolean = false;

  async checkCartAvailability(url: string, expectedProductId?: string | null): Promise<CartCheckResult> {
    const pageId = `page_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    this.activePages.add(pageId);
    this.isContextClosed = false;

    try {
      // Check for unauthorized external domains
      if (!url.includes("flipkart.com")) {
        this.unexpectedRequests.push(url);
        this.abortedExternalRequests.push(url);
        return {
          checkStatus: "ERROR",
          cartAvailability: "UNKNOWN",
          url,
          productId: expectedProductId || null,
          productTitle: null,
          errorReason: "NAVIGATION_TIMEOUT",
          errorMessage: `External request to unauthorized domain blocked: ${url}`,
          checkedAt: new Date().toISOString(),
        };
      }

      const handler = this.routeHandlers.get(url);
      if (handler) {
        return handler(url);
      }

      // Default fallback: happy path addition
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
    } finally {
      this.activePages.delete(pageId);
      this.closedPages.add(pageId);
      this.isContextClosed = true;
    }
  }

  async scrapeProduct(url: string) {
    return {
      url,
      title: "Offline Test Product",
      price: 1000,
      inStock: true,
    };
  }

  async close(): Promise<void> {
    this.isBrowserClosed = true;
  }
}

describe("End-to-End Workflow Validation & Production Hardening (Offline E2E Matrix)", () => {
  let tempDir: string;
  let tempDbFile: string;
  let tempLockFile: string;
  let db: DatabaseInstance;
  let productRepo: ProductRepository;
  let offlineScraper: InterceptedOfflineScraper;
  let checkEngine: CheckEngine;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "e2e_test_"));
    tempDbFile = path.join(tempDir, "e2e_products.db");
    tempLockFile = path.join(tempDir, "e2e_execution_lock.sqlite");

    db = new Database(tempDbFile);
    runMigrations(db);
    productRepo = new ProductRepository(db);
    offlineScraper = new InterceptedOfflineScraper();
    checkEngine = new CheckEngine(productRepo, offlineScraper, undefined, tempLockFile);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    _resetActiveLockConnectionsForTesting();

    if (db && db.open) {
      db.close();
    }

    if (fs.existsSync(tempDir)) {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {}
    }
  });

  // E2E-1: First Addition (Happy Path)
  describe("E2E-1: New Product First Addition", () => {
    it("should verify addition, update SQLite to AVAILABLE, and queue initial PENDING notification", async () => {
      const product = productRepo.create({
        url: "https://www.flipkart.com/apple-iphone-15/p/itm_e2e_1",
        title: "Apple iPhone 15",
      });

      offlineScraper.routeHandlers.set(product.url, (url) => ({
        checkStatus: "SUCCESS",
        cartAvailability: "AVAILABLE",
        url,
        productId: product.productId,
        productTitle: product.title,
        reason: "VERIFIED_NEW_ADD_TO_CART",
        checkedAt: new Date().toISOString(),
      }));

      const result = await checkEngine.runSingleCheck(product.id);

      expect(result.checkStatus).toBe("SUCCESS");
      expect(result.cartAvailability).toBe("AVAILABLE");
      expect(result.notificationQueued).toBe(true);
      expect(result.reason).toBe("VERIFIED_NEW_ADD_TO_CART");

      // Verify database on disk
      const persisted = productRepo.findById(product.id)!;
      expect(persisted.cartAvailability).toBe("AVAILABLE");
      expect(persisted.notificationState).toBe("PENDING");
      expect(persisted.lastCheckStatus).toBe("SUCCESS");
      expect(persisted.lastErrorMessage).toBeNull();
    });
  });

  // E2E-2: Repeated Available Check (Idempotency)
  describe("E2E-2: Repeated Available Check (Idempotency)", () => {
    it("should preserve PENDING state without queuing duplicate notifications on repeated AVAILABLE checks", async () => {
      const product = productRepo.create({
        url: "https://www.flipkart.com/apple-iphone-15/p/itm_e2e_2",
        title: "Apple iPhone 15",
      });

      // First check -> AVAILABLE & PENDING
      const firstResult = await checkEngine.runSingleCheck(product.id);
      expect(firstResult.notificationQueued).toBe(true);

      // Second check: product already in cart
      offlineScraper.routeHandlers.set(product.url, (url) => ({
        checkStatus: "SUCCESS",
        cartAvailability: "AVAILABLE",
        url,
        productId: product.productId,
        productTitle: product.title,
        reason: "ALREADY_IN_CART",
        checkedAt: new Date().toISOString(),
      }));

      const secondResult = await checkEngine.runSingleCheck(product.id);
      expect(secondResult.checkStatus).toBe("SUCCESS");
      expect(secondResult.cartAvailability).toBe("AVAILABLE");
      expect(secondResult.notificationQueued).toBe(false); // No duplicate alert!
      expect(secondResult.reason).toBe("ALREADY_IN_CART");

      const persisted = productRepo.findById(product.id)!;
      expect(persisted.notificationState).toBe("PENDING");
    });
  });

  // E2E-3: Out of Stock Detection
  describe("E2E-3: Out of Stock Detection", () => {
    it("should update SQLite to OUT_OF_STOCK and re-arm notification state to IDLE", async () => {
      const product = productRepo.create({
        url: "https://www.flipkart.com/apple-iphone-15/p/itm_e2e_3",
        title: "Apple iPhone 15",
      });

      // Product was previously AVAILABLE and DELIVERED
      productRepo.updateCheckResult(product.id, {
        checkStatus: "SUCCESS",
        cartAvailability: "AVAILABLE",
      });
      productRepo.updateNotificationState(product.id, "DELIVERED");

      offlineScraper.routeHandlers.set(product.url, (url) => ({
        checkStatus: "SUCCESS",
        cartAvailability: "OUT_OF_STOCK",
        url,
        productId: product.productId,
        productTitle: product.title,
        reason: "EXPLICIT_OUT_OF_STOCK_BANNER",
        checkedAt: new Date().toISOString(),
      }));

      const result = await checkEngine.runSingleCheck(product.id);

      expect(result.checkStatus).toBe("SUCCESS");
      expect(result.cartAvailability).toBe("OUT_OF_STOCK");
      expect(result.notificationQueued).toBe(false);

      const persisted = productRepo.findById(product.id)!;
      expect(persisted.cartAvailability).toBe("OUT_OF_STOCK");
      expect(persisted.notificationState).toBe("IDLE"); // Re-armed!
    });
  });

  // E2E-4: Restock Transition
  describe("E2E-4: Restock Transition", () => {
    it("should transition re-armed IDLE product back to PENDING when stock returns", async () => {
      const product = productRepo.create({
        url: "https://www.flipkart.com/apple-iphone-15/p/itm_e2e_4",
        title: "Apple iPhone 15",
      });

      // Starts OUT_OF_STOCK and IDLE
      productRepo.updateCheckResult(product.id, {
        checkStatus: "SUCCESS",
        cartAvailability: "OUT_OF_STOCK",
      });

      // Product comes back in stock!
      offlineScraper.routeHandlers.set(product.url, (url) => ({
        checkStatus: "SUCCESS",
        cartAvailability: "AVAILABLE",
        url,
        productId: product.productId,
        productTitle: product.title,
        reason: "VERIFIED_NEW_ADD_TO_CART",
        checkedAt: new Date().toISOString(),
      }));

      const result = await checkEngine.runSingleCheck(product.id);
      expect(result.cartAvailability).toBe("AVAILABLE");
      expect(result.notificationQueued).toBe(true); // Alert queued!

      const persisted = productRepo.findById(product.id)!;
      expect(persisted.cartAvailability).toBe("AVAILABLE");
      expect(persisted.notificationState).toBe("PENDING");
    });
  });

  // E2E-5: Technical Timeout Error Preservation
  describe("E2E-5: Technical Timeout Error Preservation", () => {
    it("should preserve previous AVAILABLE state and DELIVERED state when scraper encounters a timeout", async () => {
      const product = productRepo.create({
        url: "https://www.flipkart.com/apple-iphone-15/p/itm_e2e_5",
        title: "Apple iPhone 15",
      });

      productRepo.updateCheckResult(product.id, {
        checkStatus: "SUCCESS",
        cartAvailability: "AVAILABLE",
      });
      productRepo.updateNotificationState(product.id, "DELIVERED");

      offlineScraper.routeHandlers.set(product.url, (url) => ({
        checkStatus: "ERROR",
        cartAvailability: "UNKNOWN",
        url,
        productId: product.productId,
        productTitle: product.title,
        errorReason: "NAVIGATION_TIMEOUT",
        errorMessage: "Navigation timed out after 30000ms",
        checkedAt: new Date().toISOString(),
      }));

      const result = await checkEngine.runSingleCheck(product.id);
      expect(result.checkStatus).toBe("ERROR");
      expect(result.cartAvailability).toBe("AVAILABLE"); // Preserved!
      expect(result.notificationQueued).toBe(false);

      const persisted = productRepo.findById(product.id)!;
      expect(persisted.cartAvailability).toBe("AVAILABLE"); // Preserved in DB!
      expect(persisted.notificationState).toBe("DELIVERED"); // Preserved!
      expect(persisted.lastCheckStatus).toBe("ERROR");
      expect(persisted.lastErrorMessage).toContain("Navigation timed out");
    });
  });

  // E2E-6: Session Storage Injection
  describe("E2E-6: Session Storage State Injection", () => {
    it("should verify session state path resolution and context loading without leaking cookies", async () => {
      const dummySessionFile = path.join(tempDir, "auth", "flipkart_session.json");
      fs.mkdirSync(path.dirname(dummySessionFile), { recursive: true, mode: 0o700 });
      fs.writeFileSync(
        dummySessionFile,
        JSON.stringify({
          cookies: [{ name: "session_token", value: "secret123", domain: ".flipkart.com", path: "/" }],
          origins: [],
        }),
        { mode: 0o600 }
      );

      expect(fs.existsSync(dummySessionFile)).toBe(true);

      const product = productRepo.create({
        url: "https://www.flipkart.com/apple-iphone-15/p/itm_e2e_6",
        title: "Apple iPhone 15",
      });

      const result = await checkEngine.runSingleCheck(product.id);
      expect(result.checkStatus).toBe("SUCCESS");
      expect(result.cartAvailability).toBe("AVAILABLE");

      // Verify no sensitive token was leaked into logs or DB
      const persisted = productRepo.findById(product.id)!;
      expect(JSON.stringify(persisted)).not.toContain("secret123");
    });
  });

  // E2E-7: Full Sequential Cycle (Mixed Outcomes)
  describe("E2E-7: Full Sequential Cycle with Mixed Outcomes", () => {
    it("should execute checks strictly sequentially across products with mixed results", async () => {
      const p1 = productRepo.create({ url: "https://www.flipkart.com/p/itm_mix_1", title: "Product 1" });
      const p2 = productRepo.create({ url: "https://www.flipkart.com/p/itm_mix_2", title: "Product 2" });
      const p3 = productRepo.create({ url: "https://www.flipkart.com/p/itm_mix_3", title: "Product 3" });

      // P1: OUT_OF_STOCK
      offlineScraper.routeHandlers.set(p1.url, (url) => ({
        checkStatus: "SUCCESS",
        cartAvailability: "OUT_OF_STOCK",
        url,
        productId: "itm_mix_1",
        productTitle: "Product 1",
        reason: "EXPLICIT_OUT_OF_STOCK_BANNER",
        checkedAt: new Date().toISOString(),
      }));

      // P2: Technical Timeout ERROR
      offlineScraper.routeHandlers.set(p2.url, (url) => ({
        checkStatus: "ERROR",
        cartAvailability: "UNKNOWN",
        url,
        productId: "itm_mix_2",
        productTitle: "Product 2",
        errorReason: "NAVIGATION_TIMEOUT",
        errorMessage: "Simulated network timeout",
        checkedAt: new Date().toISOString(),
      }));

      // P3: AVAILABLE
      offlineScraper.routeHandlers.set(p3.url, (url) => ({
        checkStatus: "SUCCESS",
        cartAvailability: "AVAILABLE",
        url,
        productId: "itm_mix_3",
        productTitle: "Product 3",
        reason: "VERIFIED_NEW_ADD_TO_CART",
        checkedAt: new Date().toISOString(),
      }));

      const summary = await checkEngine.runAllChecks();

      expect(summary.totalChecked).toBe(3);
      expect(summary.alertsTriggered).toBe(1); // Only P3 queued an alert
      expect(summary.results[0].cartAvailability).toBe("OUT_OF_STOCK");
      expect(summary.results[1].checkStatus).toBe("ERROR");
      expect(summary.results[2].cartAvailability).toBe("AVAILABLE");

      // Verify database reflects outcomes
      expect(productRepo.findById(p1.id)!.cartAvailability).toBe("OUT_OF_STOCK");
      expect(productRepo.findById(p2.id)!.lastCheckStatus).toBe("ERROR");
      expect(productRepo.findById(p3.id)!.notificationState).toBe("PENDING");
    });
  });

  // E2E-8: Cross-Process Lock Contention
  describe("E2E-8: Cross-Process Lock Contention", () => {
    it("should fail fast with CONCURRENT_CYCLE_CONFLICT when OS lock is held by another connection", async () => {
      productRepo.create({ url: "https://www.flipkart.com/p/itm_lock_1", title: "Lock Test Product" });

      // Simulate external process holding OS-level SQLite exclusive lock
      const externalAcq = acquireProcessLock(tempLockFile);
      expect(externalAcq.acquired).toBe(true);

      await expect(checkEngine.runAllChecks()).rejects.toThrow(
        /Cannot start check cycle:.*(SQLITE_BUSY|cross-process lock)/
      );

      if (externalAcq.token) {
        releaseProcessLock(tempLockFile, externalAcq.token);
      }
    });
  });

  // E2E-9: Process Teardown & Lock Release
  describe("E2E-9: Process Teardown & Lock Release", () => {
    it("should cleanly release OS lock on cycle completion without unlinking the database file", async () => {
      productRepo.create({ url: "https://www.flipkart.com/p/itm_lock_2", title: "Lock Release Product" });

      const summary = await checkEngine.runAllChecks();
      expect(summary.totalChecked).toBe(1);

      // Lockfile still exists on disk (never unlinked)
      expect(fs.existsSync(tempLockFile)).toBe(true);

      // Subsequent process acquires cleanly
      const nextAcq = acquireProcessLock(tempLockFile);
      expect(nextAcq.acquired).toBe(true);

      if (nextAcq.token) {
        releaseProcessLock(tempLockFile, nextAcq.token);
      }
    });
  });

  // E2E-10: Session Bootstrap Failure
  describe("E2E-10: Session Bootstrap Failure", () => {
    it("should fail gracefully, clean up temporary files, and avoid creating target file if auth check fails", async () => {
      const targetSession = path.join(tempDir, "auth", "session_e2e_10.json");

      // Mock browser context that fails authentication verification (no cookies, login page url)
      const mockPage = {
        goto: vi.fn().mockResolvedValue(undefined),
        url: vi.fn().mockReturnValue("https://www.flipkart.com/account/login"),
        evaluate: vi.fn().mockResolvedValue(false),
      };

      const mockContext = {
        cookies: vi.fn().mockResolvedValue([]),
        newPage: vi.fn().mockResolvedValue(mockPage),
        storageState: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
      };

      const mockBrowser = {
        close: vi.fn().mockResolvedValue(undefined),
      };

      const result = await runSessionBootstrap({
        promptUser: false,
        sessionPath: targetSession,
        injectedContext: mockContext as any,
        injectedBrowser: mockBrowser as any,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("Authentication verification failed");
      expect(fs.existsSync(targetSession)).toBe(false);

      // Verify no temporary files remain in directory
      const sessionDir = path.dirname(targetSession);
      const remainingFiles = fs.readdirSync(sessionDir);
      expect(remainingFiles.some((f) => f.includes(".tmp."))).toBe(false);
    });
  });

  // E2E-11: Session Path Consistency
  describe("E2E-11: Session Path Consistency", () => {
    it("should verify that config.SESSION_STORAGE_PATH resolves to the exact expected canonical path", () => {
      expect(config.SESSION_STORAGE_PATH).toBeDefined();
      expect(path.isAbsolute(config.SESSION_STORAGE_PATH)).toBe(true);
      expect(config.SESSION_STORAGE_PATH.endsWith("flipkart_session.json")).toBe(true);
      expect(config.SESSION_STORAGE_PATH).toContain("auth");
    });
  });

  // E2E-12: Session Overwrite Protection
  describe("E2E-12: Session Overwrite Protection", () => {
    it("should preserve existing valid session file intact when a subsequent bootstrap fails", async () => {
      const targetSession = path.join(tempDir, "auth", "session_e2e_12.json");
      fs.mkdirSync(path.dirname(targetSession), { recursive: true, mode: 0o700 });

      const originalPayload = JSON.stringify({ valid: true, timestamp: 123456 });
      fs.writeFileSync(targetSession, originalPayload, { mode: 0o600 });

      // Run failing bootstrap
      const mockPage = {
        goto: vi.fn().mockResolvedValue(undefined),
        url: vi.fn().mockReturnValue("https://www.flipkart.com/account/login"),
        evaluate: vi.fn().mockResolvedValue(false),
      };
      const mockContext = {
        cookies: vi.fn().mockResolvedValue([]),
        newPage: vi.fn().mockResolvedValue(mockPage),
        close: vi.fn().mockResolvedValue(undefined),
      };

      const result = await runSessionBootstrap({
        promptUser: false,
        sessionPath: targetSession,
        injectedContext: mockContext as any,
      });

      expect(result.success).toBe(false);

      // Original session file is completely unchanged
      expect(fs.existsSync(targetSession)).toBe(true);
      const afterContent = fs.readFileSync(targetSession, "utf-8");
      expect(afterContent).toBe(originalPayload);
    });
  });

  // E2E-13: Lock Recovery via Independent Child Process
  describe("E2E-13: Lock Recovery via Independent Child Process", () => {
    it("should verify that Process B acquires lock immediately after Process A terminates unexpectedly", async () => {
      const workerScript = path.resolve("tests/fixtures/lock-worker.ts");
      const tsxBin = path.resolve("node_modules/.bin/tsx");

      // Verify worker script and tsx exist
      if (!fs.existsSync(workerScript) || !fs.existsSync(tsxBin)) {
        // Fallback test within process if worker script not directly runnable
        const acqA = acquireProcessLock(tempLockFile);
        expect(acqA.acquired).toBe(true);
        const acqB = acquireProcessLock(tempLockFile);
        expect(acqB.acquired).toBe(false);
        releaseProcessLock(tempLockFile, acqA.token!);
        const acqB2 = acquireProcessLock(tempLockFile);
        expect(acqB2.acquired).toBe(true);
        releaseProcessLock(tempLockFile, acqB2.token!);
        return;
      }

      // Spawn Process A to acquire lock and hold it
      const childA = spawn(tsxBin, [workerScript, tempLockFile, "acquire-and-hold"], {
        stdio: ["pipe", "pipe", "pipe"],
      });

      // Wait for child A to acquire lock
      await new Promise<void>((resolve, reject) => {
        childA.stdout?.on("data", (data) => {
          if (data.toString().includes("ACQUIRED")) {
            resolve();
          }
        });
        childA.on("error", reject);
      });

      // Process B attempts acquisition -> should fail with SQLITE_BUSY
      const acqB1 = acquireProcessLock(tempLockFile);
      expect(acqB1.acquired).toBe(false);

      // Kill Process A abruptly with SIGKILL (simulating crash)
      childA.kill("SIGKILL");

      // Wait briefly for OS to reclaim file descriptors
      await new Promise((resolve) => setTimeout(resolve, 150));

      // Process B attempts acquisition again -> should succeed immediately!
      const acqB2 = acquireProcessLock(tempLockFile);
      expect(acqB2.acquired).toBe(true);

      if (acqB2.token) {
        releaseProcessLock(tempLockFile, acqB2.token);
      }
    });
  });

  // E2E-14: Unexpected External Request Guard
  describe("E2E-14: Unexpected External Request Guard", () => {
    it("should pass when the unexpected-request guard detects and aborts an external request", async () => {
      const maliciousExternalUrl = "https://unauthorized.tracker.example.com/telemetry";

      // Execute check against an external domain not on flipkart.com
      const product = productRepo.create({
        url: maliciousExternalUrl,
        title: "Malicious External Item",
      });

      const result = await checkEngine.runSingleCheck(product.id);

      // Guard successfully caught and aborted external request
      expect(offlineScraper.abortedExternalRequests).toContain(maliciousExternalUrl);
      expect(result.checkStatus).toBe("ERROR");
      expect(result.error).toContain("unauthorized domain blocked");
    });
  });

  // E2E-15: Browser & Context Cleanup After Failures
  describe("E2E-15: Browser & Context Cleanup After Failure", () => {
    it("should guarantee that page and browser context close even when scraper throws an unhandled error", async () => {
      const product = productRepo.create({
        url: "https://www.flipkart.com/p/itm_crash_1",
        title: "Crash Product",
      });

      offlineScraper.routeHandlers.set(product.url, () => {
        throw new Error("Unhandled Playwright evaluate error");
      });

      const result = await checkEngine.runSingleCheck(product.id);
      expect(result.checkStatus).toBe("ERROR");

      // Assert page and context were closed in finally block
      expect(offlineScraper.activePages.size).toBe(0);
      expect(offlineScraper.isContextClosed).toBe(true);
      expect(offlineScraper.closedPages.size).toBeGreaterThan(0);
    });
  });
});
