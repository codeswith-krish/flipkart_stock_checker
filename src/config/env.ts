import dotenv from "dotenv";
import path from "node:path";
import { z } from "zod";
import { ConfigurationError } from "../shared/errors.js";

// Load .env file
dotenv.config();

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  TELEGRAM_BOT_TOKEN: z.string().min(1, "TELEGRAM_BOT_TOKEN is required").default("dummy_token"),
  TELEGRAM_CHAT_ID: z.string().min(1, "TELEGRAM_CHAT_ID is required").default("dummy_chat_id"),
  DATABASE_PATH: z.string().default("./data/stock_checker.db"),
  CHECK_INTERVAL_CRON: z.string().default("*/5 * * * *"),
  BROWSER_HEADLESS: z
    .string()
    .default("true")
    .transform((val) => val === "true" || val === "1"),
  BROWSER_NO_SANDBOX: z
    .string()
    .default("true")
    .transform((val) => val === "true" || val === "1"),
  SCRAPER_TIMEOUT_MS: z
    .string()
    .default("30000")
    .transform((val) => parseInt(val, 10) || 30000),
  SESSION_STORAGE_PATH: z.string().default("./data/auth/flipkart_session.json"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export type EnvConfig = z.infer<typeof envSchema>;

export function loadConfig(overrideEnv?: Record<string, string>): EnvConfig {
  const source = overrideEnv || process.env;
  const result = envSchema.safeParse(source);

  if (!result.success) {
    const errorMessages = result.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join(", ");
    throw new ConfigurationError(`Environment configuration error: ${errorMessages}`);
  }

  // Production fail-fast validation: ensure real Telegram credentials are configured
  if (result.data.NODE_ENV === "production") {
    if (!result.data.TELEGRAM_BOT_TOKEN || result.data.TELEGRAM_BOT_TOKEN === "dummy_token") {
      throw new ConfigurationError(
        "Production environment requires a valid TELEGRAM_BOT_TOKEN. Default dummy token is not permitted."
      );
    }
    if (!result.data.TELEGRAM_CHAT_ID || result.data.TELEGRAM_CHAT_ID === "dummy_chat_id") {
      throw new ConfigurationError(
        "Production environment requires a valid TELEGRAM_CHAT_ID. Default dummy chat ID is not permitted."
      );
    }
  }

  const resolvedDbPath = path.isAbsolute(result.data.DATABASE_PATH)
    ? result.data.DATABASE_PATH
    : path.resolve(process.cwd(), result.data.DATABASE_PATH);

  const resolvedSessionPath = path.isAbsolute(result.data.SESSION_STORAGE_PATH)
    ? result.data.SESSION_STORAGE_PATH
    : path.resolve(process.cwd(), result.data.SESSION_STORAGE_PATH);

  return {
    ...result.data,
    DATABASE_PATH: resolvedDbPath,
    SESSION_STORAGE_PATH: resolvedSessionPath,
  };
}
