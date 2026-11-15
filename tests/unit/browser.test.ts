import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { chromium } from "playwright";
import {
  getBrowser,
  isBrowserRunning,
  createLightweightPage,
  closePageAndContext,
  withIsolatedPage,
  closeBrowser,
  resolveSessionStoragePath,
  _resetBrowserForTesting,
} from "../../src/modules/scraper/browser.js";
import { ScraperError } from "../../src/shared/errors.js";

// Mock Playwright chromium module for deterministic, offline testing
vi.mock("playwright", () => {
  return {
    chromium: {
      launch: vi.fn(),
    },
  };
});

describe("Browser Lifecycle & Session Manager (Unit)", () => {
  let mockPage: any;
  let mockContext: any;
  let mockBrowser: any;
  let tempSessionPath: string;

  beforeEach(() => {
    vi.clearAllMocks();
    _resetBrowserForTesting();

    mockPage = {
      isClosed: vi.fn().mockReturnValue(false),
      close: vi.fn().mockResolvedValue(undefined),
      route: vi.fn().mockResolvedValue(undefined),
    };

    mockContext = {
      newPage: vi.fn().mockResolvedValue(mockPage),
      close: vi.fn().mockResolvedValue(undefined),
    };

    mockBrowser = {
      isConnected: vi.fn().mockReturnValue(true),
      close: vi.fn().mockResolvedValue(undefined),
      newContext: vi.fn().mockResolvedValue(mockContext),
      on: vi.fn(),
    };

    (chromium.launch as any).mockResolvedValue(mockBrowser);

    tempSessionPath = path.join(os.tmpdir(), `test_session_${Date.now()}.json`);
  });

  afterEach(async () => {
    await closeBrowser();
    _resetBrowserForTesting();

    if (fs.existsSync(tempSessionPath)) {
      try {
        fs.unlinkSync(tempSessionPath);
      } catch {}
    }
  });

  describe("Singleton Browser Lifecycle", () => {
    it("should lazily initialize a single Chromium instance with low-memory VM flags", async () => {
      expect(isBrowserRunning()).toBe(false);

      const browser1 = await getBrowser();
      expect(browser1).toBe(mockBrowser);
      expect(chromium.launch).toHaveBeenCalledTimes(1);

      const launchArgs = (chromium.launch as any).mock.calls[0][0];
      expect(launchArgs.args).toEqual(
        expect.arrayContaining([
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--disable-gpu",
        ])
      );
      // Ensure single-process is avoided by default
      expect(launchArgs.args).not.toContain("--single-process");
      expect(isBrowserRunning()).toBe(true);

      // Second call should reuse existing connected instance
      const browser2 = await getBrowser();
      expect(browser2).toBe(mockBrowser);
      expect(chromium.launch).toHaveBeenCalledTimes(1);
    });

    it("should relaunch browser if previously disconnected", async () => {
      await getBrowser();
      expect(chromium.launch).toHaveBeenCalledTimes(1);

      // Simulate disconnect
      mockBrowser.isConnected.mockReturnValue(false);

      const newMockBrowser = {
        ...mockBrowser,
        isConnected: vi.fn().mockReturnValue(true),
      };
      (chromium.launch as any).mockResolvedValueOnce(newMockBrowser);

      const browser2 = await getBrowser();
      expect(browser2).toBe(newMockBrowser);
      expect(chromium.launch).toHaveBeenCalledTimes(2);
    });

    it("should wrap launch failure in ScraperError and clear browserInstance", async () => {
      (chromium.launch as any).mockRejectedValueOnce(new Error("Executable not found"));

      await expect(getBrowser()).rejects.toThrow(ScraperError);
      expect(isBrowserRunning()).toBe(false);
    });

    it("should gracefully close browser instance and reset state", async () => {
      await getBrowser();
      expect(isBrowserRunning()).toBe(true);

      await closeBrowser();
      expect(mockBrowser.close).toHaveBeenCalledTimes(1);
      expect(isBrowserRunning()).toBe(false);

      // Idempotent close
      await closeBrowser();
      expect(mockBrowser.close).toHaveBeenCalledTimes(1);
    });
  });

  describe("Session Storage Handling", () => {
    it("should return null for non-existent session storage files without throwing", () => {
      const nonExistent = path.join(os.tmpdir(), "non_existent_auth_file.json");
      expect(resolveSessionStoragePath(nonExistent)).toBeNull();
    });

    it("should resolve existing session storage file", () => {
      fs.writeFileSync(tempSessionPath, JSON.stringify({ cookies: [] }));
      expect(resolveSessionStoragePath(tempSessionPath)).toBe(tempSessionPath);
    });

    it("should create unauthenticated context when session file is missing", async () => {
      const nonExistent = path.join(os.tmpdir(), "missing_session.json");
      const { page, context } = await createLightweightPage({
        sessionStoragePath: nonExistent,
      });

      expect(page).toBe(mockPage);
      expect(context).toBe(mockContext);
      expect(mockBrowser.newContext).toHaveBeenCalledTimes(1);

      const contextOptions = mockBrowser.newContext.mock.calls[0][0];
      expect(contextOptions.storageState).toBeUndefined();
      expect(contextOptions.userAgent).toBeDefined();
    });

    it("should load storageState when session file exists on disk", async () => {
      fs.writeFileSync(tempSessionPath, JSON.stringify({ cookies: [], origins: [] }));

      const { page, context } = await createLightweightPage({
        sessionStoragePath: tempSessionPath,
      });

      expect(page).toBe(mockPage);
      expect(context).toBe(mockContext);
      expect(mockBrowser.newContext).toHaveBeenCalledTimes(1);

      const contextOptions = mockBrowser.newContext.mock.calls[0][0];
      expect(contextOptions.storageState).toBe(tempSessionPath);
    });
  });

  describe("Page Route & Media Blocking", () => {
    it("should set up route blocking for images, media, and fonts by default", async () => {
      await createLightweightPage();
      expect(mockPage.route).toHaveBeenCalledWith("**/*", expect.any(Function));

      // Test route blocking logic
      const routeHandler = mockPage.route.mock.calls[0][1];

      const abortRoute = {
        request: () => ({ resourceType: () => "image" }),
        abort: vi.fn(),
        continue: vi.fn(),
      };
      routeHandler(abortRoute);
      expect(abortRoute.abort).toHaveBeenCalled();
      expect(abortRoute.continue).not.toHaveBeenCalled();

      const continueRoute = {
        request: () => ({ resourceType: () => "document" }),
        abort: vi.fn(),
        continue: vi.fn(),
      };
      routeHandler(continueRoute);
      expect(continueRoute.continue).toHaveBeenCalled();
      expect(continueRoute.abort).not.toHaveBeenCalled();
    });

    it("should skip route blocking when blockMedia is false", async () => {
      await createLightweightPage({ blockMedia: false });
      expect(mockPage.route).not.toHaveBeenCalled();
    });
  });

  describe("Cleanup & Isolated Execution", () => {
    it("should safely close page and context via closePageAndContext", async () => {
      await closePageAndContext(mockPage, mockContext);
      expect(mockPage.close).toHaveBeenCalledTimes(1);
      expect(mockContext.close).toHaveBeenCalledTimes(1);
    });

    it("should handle null or already closed page/context gracefully", async () => {
      mockPage.isClosed.mockReturnValue(true);
      await closePageAndContext(mockPage, null);
      expect(mockPage.close).not.toHaveBeenCalled();

      // Should not throw on nulls
      await closePageAndContext(null, null);
    });

    it("should handle close errors without rejecting in closePageAndContext", async () => {
      mockPage.close.mockRejectedValueOnce(new Error("Target closed"));
      mockContext.close.mockRejectedValueOnce(new Error("Browser disconnected"));

      await expect(closePageAndContext(mockPage, mockContext)).resolves.not.toThrow();
    });

    it("should guarantee cleanup in withIsolatedPage on successful execution", async () => {
      const result = await withIsolatedPage(async (page, context) => {
        expect(page).toBe(mockPage);
        expect(context).toBe(mockContext);
        return "check-success";
      });

      expect(result).toBe("check-success");
      expect(mockPage.close).toHaveBeenCalledTimes(1);
      expect(mockContext.close).toHaveBeenCalledTimes(1);
    });

    it("should guarantee cleanup in withIsolatedPage when callback throws", async () => {
      await expect(
        withIsolatedPage(async () => {
          throw new Error("Page navigation failed");
        })
      ).rejects.toThrow("Page navigation failed");

      expect(mockPage.close).toHaveBeenCalledTimes(1);
      expect(mockContext.close).toHaveBeenCalledTimes(1);
    });
  });
});
