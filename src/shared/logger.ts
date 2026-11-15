export type LogLevel = "debug" | "info" | "warn" | "error";

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

/**
 * Sanitizes sensitive credentials, bot tokens, and authorization cookies from log strings.
 */
export function redactSensitiveText(text: string): string {
  return text
    // Redact Telegram bot tokens (e.g., /bot123456:ABC-DEF...)
    .replace(/\/bot[0-9a-zA-Z:_-]+/g, "/bot[REDACTED]")
    // Redact tokens, cookies, auth headers, passwords in key=val or "key": "val" formats
    .replace(
      /(["']?(?:cookie|token|auth|secret|password|authorization)["']?\s*[:=]\s*["']?)([^"',\s;}{]+)(["']?)/gi,
      "$1[REDACTED]$3"
    );
}

export class Logger {
  private currentLevel: LogLevel;

  constructor(level: LogLevel = "info") {
    this.currentLevel = level;
  }

  setLevel(level: LogLevel): void {
    this.currentLevel = level;
  }

  private shouldLog(level: LogLevel): boolean {
    return LOG_LEVEL_PRIORITY[level] >= LOG_LEVEL_PRIORITY[this.currentLevel];
  }

  private serializeMeta(meta: unknown): string {
    if (meta instanceof Error) {
      const errorObj: Record<string, unknown> = {
        name: meta.name,
        message: meta.message,
        stack: meta.stack,
      };

      if ("cause" in meta && meta.cause !== undefined) {
        errorObj.cause = meta.cause;
      }

      Object.assign(errorObj, meta);

      try {
        return JSON.stringify(errorObj);
      } catch {
        return String(meta);
      }
    }

    if (typeof meta === "object" && meta !== null) {
      try {
        return JSON.stringify(meta);
      } catch {
        return String(meta);
      }
    }

    return String(meta);
  }

  private formatMessage(level: LogLevel, message: string, meta?: unknown): string {
    const timestamp = new Date().toISOString();
    const prefix = `[${timestamp}] [${level.toUpperCase()}]`;
    let raw: string;
    if (meta !== undefined) {
      const serializedMeta = this.serializeMeta(meta);
      raw = `${prefix} ${message} ${serializedMeta}`;
    } else {
      raw = `${prefix} ${message}`;
    }
    return redactSensitiveText(raw);
  }

  debug(message: string, meta?: unknown): void {
    if (this.shouldLog("debug")) {
      console.debug(this.formatMessage("debug", message, meta));
    }
  }

  info(message: string, meta?: unknown): void {
    if (this.shouldLog("info")) {
      console.log(this.formatMessage("info", message, meta));
    }
  }

  warn(message: string, meta?: unknown): void {
    if (this.shouldLog("warn")) {
      console.warn(this.formatMessage("warn", message, meta));
    }
  }

  error(message: string, meta?: unknown): void {
    if (this.shouldLog("error")) {
      console.error(this.formatMessage("error", message, meta));
    }
  }
}

export const logger = new Logger(
  (process.env.LOG_LEVEL as LogLevel) || "info"
);
