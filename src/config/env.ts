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
  SCRAPER_TIMEOUT_MS: z
    .string()
    .default("30000")
    .transform((val) => parseInt(val, 10) || 30000),
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

  const resolvedDbPath = path.isAbsolute(result.data.DATABASE_PATH)
    ? result.data.DATABASE_PATH
    : path.resolve(process.cwd(), result.data.DATABASE_PATH);

  return {
    ...result.data,
    DATABASE_PATH: resolvedDbPath,
  };
}
