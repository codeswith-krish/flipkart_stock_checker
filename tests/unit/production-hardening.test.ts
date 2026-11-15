import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { chromium } from "playwright";
import { SchedulerRunner, schedulerRunner } from "../../src/scheduler/runner.js";
import * as browserModule from "../../src/modules/scraper/browser.js";
import * as clientModule from "../../src/db/client.js";
import { shutdown, _resetShutdownStateForTesting } from "../../src/scheduler/index.js";
import { redactSensitiveText, Logger } from "../../src/shared/logger.js";
import { loadConfig } from "../../src/config/env.js";
import { ConfigurationError } from "../../src/shared/errors.js";
import { verifySessionFile } from "../../scripts/verify-session.js";

describe("Phase 4 — Task 4.5: Production Hardening & Deployment Readiness", () => {
  describe("1. Scheduler Lifecycle & Browser Cleanup Sequencing", () => {
    it("1.1 Manages status lifecycle (STOPPED -> RUNNING -> STOPPED)", async () => {
      const fakeEngine: any = { runAllChecks: vi.fn().mockResolvedValue([]) };
      const fakeDispatcher: any = { dispatchPending: vi.fn().mockResolvedValue({ totalPending: 0 }) };

      const runner = new SchedulerRunner(fakeEngine, fakeDispatcher);
      expect(runner.getStatus()).toBe("STOPPED");

      runner.start();
      expect(runner.getStatus()).toBe("RUNNING");

      const clean = await runner.stop();
      expect(clean).toBe(true);
      expect(runner.getStatus()).toBe("STOPPED");
    });

    it("1.2 Guarantees closeBrowser() is called in finally before dispatchPending()", async () => {
      const callOrder: string[] = [];

      const fakeEngine: any = {
        runAllChecks: vi.fn().mockImplementation(async () => {
          callOrder.push("runAllChecks");
        }),
      };

      const fakeDispatcher: any = {
        dispatchPending: vi.fn().mockImplementation(async () => {
          callOrder.push("dispatchPending");
          return { totalPending: 0 };
        }),
      };

      const closeBrowserSpy = vi.spyOn(browserModule, "closeBrowser").mockImplementation(async () => {
        callOrder.push("closeBrowser");
      });

      const runner = new SchedulerRunner(fakeEngine, fakeDispatcher);
      await runner.executeCycle();

      expect(callOrder).toEqual([
        "runAllChecks",    // executeCycle checks
        "closeBrowser",    // Chromium closed in finally BEFORE post-check dispatch
        "dispatchPending", // post-check notification sweep
      ]);

      expect(closeBrowserSpy).toHaveBeenCalledTimes(1);
      expect(fakeDispatcher.dispatchPending).toHaveBeenCalledTimes(1);

      closeBrowserSpy.mockRestore();
    });

    it("1.3 Closes browser in finally even when runAllChecks() throws an unhandled error", async () => {
      const closeBrowserSpy = vi.spyOn(browserModule, "closeBrowser").mockResolvedValue();

      const fakeEngine: any = {
        runAllChecks: vi.fn().mockRejectedValue(new Error("Network connection dropped during check")),
      };

      const fakeDispatcher: any = {
        dispatchPending: vi.fn().mockResolvedValue({ totalPending: 0 }),
      };

      const runner = new SchedulerRunner(fakeEngine, fakeDispatcher);

      // Should not throw or crash the scheduler
      await runner.executeCycle();

      expect(closeBrowserSpy).toHaveBeenCalledTimes(1);

      closeBrowserSpy.mockRestore();
    });

    it("1.4 Skips cycle execution when scheduler is in STOPPING status", async () => {
      const fakeEngine: any = { runAllChecks: vi.fn() };
      const fakeDispatcher: any = { dispatchPending: vi.fn() };

      const runner = new SchedulerRunner(fakeEngine, fakeDispatcher);
      (runner as any).status = "STOPPING";

      await runner.executeCycle();

      expect(fakeEngine.runAllChecks).not.toHaveBeenCalled();
      expect(fakeDispatcher.dispatchPending).not.toHaveBeenCalled();
    });

    it("1.5 Executes startup notification sweep on start() independently of check cycle", async () => {
      const fakeEngine: any = { runAllChecks: vi.fn().mockResolvedValue([]) };
      const fakeDispatcher: any = { dispatchPending: vi.fn().mockResolvedValue({ totalPending: 0 }) };

      const runner = new SchedulerRunner(fakeEngine, fakeDispatcher);
      runner.start();

      await new Promise((r) => setTimeout(r, 10));

      expect(fakeDispatcher.dispatchPending).toHaveBeenCalled();

      await runner.stop();
    });
  });

  describe("2. Scheduler Promise Tracking & Timeout Drain", () => {
    it("2.1 stop() awaits active in-flight operations and returns true", async () => {
      let resolveCheck!: () => void;
      const checkPromise = new Promise<void>((r) => {
        resolveCheck = r;
      });

      const fakeEngine: any = {
        runAllChecks: vi.fn().mockImplementation(async () => {
          await checkPromise;
        }),
      };
      const fakeDispatcher: any = {
        dispatchPending: vi.fn().mockResolvedValue({ totalPending: 0 }),
      };

      const runner = new SchedulerRunner(fakeEngine, fakeDispatcher);
      runner.start();

      // Start an in-flight cycle
      const cyclePromise = runner.executeCycle();

      // Stop requested while cycle is still in flight
      const stopPromise = runner.stop(1000);

      // Resolve the in-flight check
      resolveCheck();
      await cyclePromise;

      const clean = await stopPromise;
      expect(clean).toBe(true);
      expect(runner.getStatus()).toBe("STOPPED");
    });

    it("2.2 stop() returns false if in-flight operation exceeds timeout", async () => {
      const hangingPromise = new Promise<void>(() => {}); // Never resolves

      const fakeEngine: any = {
        runAllChecks: vi.fn().mockReturnValue(hangingPromise),
      };
      const fakeDispatcher: any = {
        dispatchPending: vi.fn().mockResolvedValue({ totalPending: 0 }),
      };

      const runner = new SchedulerRunner(fakeEngine, fakeDispatcher);
      runner.start();

      // Trigger hanging cycle
      runner.executeCycle();

      // Stop with very short 30ms timeout
      const clean = await runner.stop(30);
      expect(clean).toBe(false);
      expect(runner.getStatus()).toBe("STOPPING");
    });
  });

  describe("3. Safe Graceful Shutdown & Database Integrity", () => {
    let exitSpy: ReturnType<typeof vi.spyOn>;
    let closeDbSpy: ReturnType<typeof vi.spyOn>;
    let closeBrowserSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      _resetShutdownStateForTesting();
      exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {}) as any);
      closeDbSpy = vi.spyOn(clientModule, "closeDb").mockImplementation(() => {});
      closeBrowserSpy = vi.spyOn(browserModule, "closeBrowser").mockResolvedValue();
    });

    afterEach(() => {
      _resetShutdownStateForTesting();
      exitSpy.mockRestore();
      closeDbSpy.mockRestore();
      closeBrowserSpy.mockRestore();
    });

    it("3.1 Clean shutdown closes browser and SQLite database, exiting with code 0", async () => {
      await shutdown("SIGTERM", 0);

      expect(closeBrowserSpy).toHaveBeenCalled();
      expect(closeDbSpy).toHaveBeenCalled();
      expect(exitSpy).toHaveBeenCalledWith(0);
    });

    it("3.2 Ignores duplicate shutdown signals while shutdown is in progress", async () => {
      const firstShutdown = shutdown("SIGINT", 0);
      const secondShutdown = shutdown("SIGTERM", 0);

      await Promise.all([firstShutdown, secondShutdown]);

      expect(exitSpy).toHaveBeenCalledTimes(1);
    });

    it("3.3 Does NOT call closeDb() when shutdown times out with active operations", async () => {
      const runnerStopSpy = vi.spyOn(schedulerRunner, "stop").mockResolvedValue(false);

      await shutdown("SIGTERM", 1);

      expect(closeDbSpy).not.toHaveBeenCalled();
      expect(exitSpy).toHaveBeenCalledWith(1);

      runnerStopSpy.mockRestore();
    });
  });

  describe("4. Logger Error Serialization & Sensitive Token Redaction", () => {
    it("4.1 Redacts Telegram bot tokens in URLs and messages", () => {
      const input = "Request to https://api.telegram.org/bot123456789:ABC-def_GHIjklMNOpqRst/sendMessage failed";
      const sanitized = redactSensitiveText(input);

      expect(sanitized).toBe("Request to https://api.telegram.org/bot[REDACTED]/sendMessage failed");
      expect(sanitized).not.toContain("123456789:ABC");
    });

    it("4.2 Redacts sensitive keys (token, cookie, password, secret)", () => {
      const input1 = "Config loaded: token=my_secret_token_12345&chat_id=987";
      expect(redactSensitiveText(input1)).toContain("token=[REDACTED]");
      expect(redactSensitiveText(input1)).not.toContain("my_secret_token_12345");

      const input2 = '{"cookie": "session_id=abcdefg123456", "user": "test"}';
      expect(redactSensitiveText(input2)).toContain('"cookie": "[REDACTED]"');

      const input3 = "password: SuperSecretPassword!123";
      expect(redactSensitiveText(input3)).toContain("password: [REDACTED]");
    });

    it("4.3 Formats Error object instances with name, message, and stack instead of empty object", () => {
      const logger = new Logger("debug");
      let capturedLog = "";
      const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation((msg) => {
        capturedLog = msg;
      });

      const testError = new Error("Database connection timed out");
      logger.error("Operation failed", testError);

      expect(capturedLog).toContain("Database connection timed out");
      expect(capturedLog).toContain("Error");
      expect(capturedLog).toContain("stack");
      expect(capturedLog).not.toBe("[ERROR] Operation failed {}");

      consoleErrorSpy.mockRestore();
    });
  });

  describe("5. Configuration Security & Fail-Fast Validation", () => {
    it("5.1 Throws ConfigurationError in production if TELEGRAM_BOT_TOKEN is dummy_token", () => {
      expect(() => {
        loadConfig({
          NODE_ENV: "production",
          TELEGRAM_BOT_TOKEN: "dummy_token",
          TELEGRAM_CHAT_ID: "123456789",
        });
      }).toThrow(ConfigurationError);
    });

    it("5.2 Throws ConfigurationError in production if TELEGRAM_CHAT_ID is dummy_chat_id", () => {
      expect(() => {
        loadConfig({
          NODE_ENV: "production",
          TELEGRAM_BOT_TOKEN: "real_production_token",
          TELEGRAM_CHAT_ID: "dummy_chat_id",
        });
      }).toThrow(ConfigurationError);
    });

    it("5.3 Accepts valid credentials in production mode", () => {
      const conf = loadConfig({
        NODE_ENV: "production",
        TELEGRAM_BOT_TOKEN: "real_production_token_12345",
        TELEGRAM_CHAT_ID: "-100987654321",
      });

      expect(conf.NODE_ENV).toBe("production");
      expect(conf.TELEGRAM_BOT_TOKEN).toBe("real_production_token_12345");
      expect(conf.TELEGRAM_CHAT_ID).toBe("-100987654321");
    });

    it("5.4 Correctly parses BROWSER_NO_SANDBOX boolean flag", () => {
      const confDefault = loadConfig({});
      expect(confDefault.BROWSER_NO_SANDBOX).toBe(true);

      const confDisabled = loadConfig({ BROWSER_NO_SANDBOX: "false" });
      expect(confDisabled.BROWSER_NO_SANDBOX).toBe(false);
    });
  });

  describe("6. Session Verification Resource Management", () => {
    it("6.1 Returns success: false when session file does not exist", async () => {
      const nonExistentPath = path.join(os.tmpdir(), "non_existent_flipkart_session.json");
      const result = await verifySessionFile(nonExistentPath);

      expect(result.success).toBe(false);
      expect(result.error).toContain("Session storage file does not exist");
    });

    it("6.2 Closes page, context, and browser in finally even on verification failure", async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "verify_test_"));
      const dummySession = path.join(tempDir, "session.json");
      fs.writeFileSync(dummySession, JSON.stringify({ cookies: [], origins: [] }), { mode: 0o600 });

      const mockPage = {
        isClosed: vi.fn().mockReturnValue(false),
        close: vi.fn().mockResolvedValue(undefined),
      };
      const mockContext = {
        close: vi.fn().mockResolvedValue(undefined),
        newPage: vi.fn().mockResolvedValue(mockPage),
      };
      const mockBrowser = {
        newContext: vi.fn().mockResolvedValue(mockContext),
        close: vi.fn().mockResolvedValue(undefined),
      };

      const launchSpy = vi.spyOn(chromium, "launch").mockResolvedValue(mockBrowser as any);

      const result = await verifySessionFile(dummySession);
      expect(result.success).toBe(false);

      expect(mockPage.close).toHaveBeenCalled();
      expect(mockContext.close).toHaveBeenCalled();
      expect(mockBrowser.close).toHaveBeenCalled();

      launchSpy.mockRestore();
      fs.rmSync(tempDir, { recursive: true, force: true });
    });
  });
});
