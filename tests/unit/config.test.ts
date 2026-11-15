import { describe, it, expect } from "vitest";
import { loadConfig } from "../../src/config/env.js";

describe("Configuration Loader", () => {
  it("should apply default configurations when optional variables are omitted", () => {
    const config = loadConfig({
      TELEGRAM_BOT_TOKEN: "mock_token",
      TELEGRAM_CHAT_ID: "mock_chat_id",
    });

    expect(config.CHECK_INTERVAL_CRON).toBe("*/5 * * * *");
    expect(config.BROWSER_HEADLESS).toBe(true);
    expect(config.LOG_LEVEL).toBe("info");
    expect(config.DATABASE_PATH).toContain("stock_checker.db");
    expect(config.SESSION_STORAGE_PATH).toContain("flipkart_session.json");
  });

  it("should parse boolean and numeric environment variables correctly", () => {
    const config = loadConfig({
      TELEGRAM_BOT_TOKEN: "token",
      TELEGRAM_CHAT_ID: "chat",
      BROWSER_HEADLESS: "false",
      SCRAPER_TIMEOUT_MS: "45000",
      SESSION_STORAGE_PATH: "/custom/path/session.json",
      LOG_LEVEL: "debug",
    });

    expect(config.BROWSER_HEADLESS).toBe(false);
    expect(config.SCRAPER_TIMEOUT_MS).toBe(45000);
    expect(config.SESSION_STORAGE_PATH).toBe("/custom/path/session.json");
    expect(config.LOG_LEVEL).toBe("debug");
  });
});
