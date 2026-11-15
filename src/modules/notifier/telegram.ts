import { config } from "../../config/index.js";
import { logger } from "../../shared/logger.js";
import type {
  INotifier,
  TelegramSendResult,
} from "./types.js";
import type { NotificationPayload } from "../../types/index.js";
import { formatNotification } from "./templates.js";

/**
 * Redacts Telegram bot tokens from API URLs, error strings, and logger outputs.
 */
export function redactTelegramToken(text: string, token?: string): string {
  if (!text) return "";
  let sanitized = String(text).replace(/\/bot[0-9a-zA-Z:_-]+/g, "/bot[REDACTED]");
  if (token && token.length > 5) {
    sanitized = sanitized.replaceAll(token, "[REDACTED_TOKEN]");
  }
  return sanitized;
}

export class TelegramNotifier implements INotifier {
  private botToken: string;
  private chatId: string;
  private fetchFn: typeof fetch;

  constructor(botToken?: string, chatId?: string, fetchFn?: typeof fetch) {
    this.botToken = botToken || config.TELEGRAM_BOT_TOKEN;
    this.chatId = chatId || config.TELEGRAM_CHAT_ID;
    this.fetchFn = fetchFn || globalThis.fetch.bind(globalThis);
  }

  /**
   * Transmits a message to Telegram and returns a strongly typed delivery result.
   * Enforces 10s request timeout, full retry_after extraction, error classification,
   * and strict token redaction.
   */
  async sendMessageWithResult(text: string): Promise<TelegramSendResult> {
    if (!this.botToken || this.botToken === "dummy_token") {
      logger.warn("Telegram bot token not configured. Skipping notification transmission.");
      return {
        status: "PERMANENT_FAILURE",
        error: "Telegram bot token is not configured (dummy_token or empty)",
      };
    }

    if (!this.chatId || this.chatId === "dummy_chat_id") {
      logger.warn("Telegram chat ID not configured. Skipping notification transmission.");
      return {
        status: "PERMANENT_FAILURE",
        error: "Telegram chat ID is not configured (dummy_chat_id or empty)",
      };
    }

    const apiUrl = `https://api.telegram.org/bot${this.botToken}/sendMessage`;
    const sanitizedUrl = redactTelegramToken(apiUrl, this.botToken);

    try {
      logger.debug(`Sending Telegram notification to chat ${this.chatId} via ${sanitizedUrl}...`);

      const response = await this.fetchFn(apiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: this.chatId,
          text,
          parse_mode: "HTML",
          disable_web_page_preview: false,
        }),
        signal: AbortSignal.timeout(10000), // Bounded 10s timeout
      });

      let json: any = null;
      try {
        json = await response.json();
      } catch (parseErr: any) {
        logger.error(
          `Failed to parse Telegram API JSON response (HTTP ${response.status}): ${parseErr.message}`
        );
        return {
          status: "TEMPORARY_FAILURE",
          errorCode: response.status,
          error: `Malformed JSON response from Telegram (HTTP ${response.status})`,
        };
      }

      // 1. Success: HTTP 200 and json.ok === true
      if (response.ok && json?.ok === true) {
        const messageId = json.result?.message_id;
        logger.info(`Telegram notification delivered successfully (Message ID: ${messageId || "N/A"}).`);
        return {
          status: "SUCCESS",
          messageId: messageId || 0,
          description: json.description,
        };
      }

      // 1b. Inconsistency: HTTP 200 but json.ok is false
      if (response.ok && json?.ok === false) {
        const description = json?.description || "Unknown error";
        logger.warn(
          `Telegram API returned ok: false with HTTP 200: ${redactTelegramToken(description, this.botToken)}`
        );
        return {
          status: "TEMPORARY_FAILURE",
          errorCode: response.status,
          error: `Telegram API returned ok: false (HTTP ${response.status}: ${description})`,
          description,
        };
      }

      // 2. Rate Limit: HTTP 429 (Extract full retry_after seconds)
      if (response.status === 429) {
        const retryAfterSeconds =
          typeof json?.parameters?.retry_after === "number" && json.parameters.retry_after > 0
            ? json.parameters.retry_after
            : 30;

        logger.warn(
          `Telegram rate limit encountered (HTTP 429). Retry after: ${retryAfterSeconds}s. Description: ${json?.description || "N/A"}`
        );
        return {
          status: "RATE_LIMIT",
          retryAfterSeconds,
          error: `Telegram API rate limit (HTTP 429): retry after ${retryAfterSeconds}s`,
          description: json?.description,
        };
      }

      // 3. Permanent Client Errors: HTTP 400, 401, 403, 404
      if ([400, 401, 403, 404].includes(response.status)) {
        const description = json?.description || response.statusText;
        logger.error(
          `Permanent Telegram API failure (HTTP ${response.status}): ${redactTelegramToken(description, this.botToken)}`
        );
        return {
          status: "PERMANENT_FAILURE",
          errorCode: response.status,
          error: `Permanent Telegram API failure (HTTP ${response.status}: ${description})`,
          description,
        };
      }

      // 4. Server Errors: HTTP 500, 502, 503, 504
      if (response.status >= 500 && response.status < 600) {
        const description = json?.description || response.statusText;
        logger.warn(
          `Telegram server error (HTTP ${response.status}): ${redactTelegramToken(description, this.botToken)}`
        );
        return {
          status: "TEMPORARY_FAILURE",
          errorCode: response.status,
          error: `Telegram server error (HTTP ${response.status}: ${description})`,
          description,
        };
      }

      // 5. Other unhandled responses
      const description = json?.description || response.statusText || "Unknown error";
      logger.warn(`Unexpected Telegram API response (HTTP ${response.status}): ${description}`);
      return {
        status: "TEMPORARY_FAILURE",
        errorCode: response.status,
        error: `Unexpected Telegram response (HTTP ${response.status}: ${description})`,
        description,
      };
    } catch (error: any) {
      // 6. Network Timeout: Outcome uncertain after 10s timeout
      if (error.name === "AbortError" || error.name === "TimeoutError") {
        logger.warn("Telegram API request timed out after 10000ms. Delivery outcome uncertain.");
        return {
          status: "UNKNOWN_DELIVERY",
          error: "Request timed out after 10000ms: delivery outcome uncertain",
        };
      }

      // 7. Network / Socket Connection Failures
      const sanitizedMsg = redactTelegramToken(error.message, this.botToken);
      logger.error(`Network connection error during Telegram send: ${sanitizedMsg}`);
      return {
        status: "TEMPORARY_FAILURE",
        error: `Network failure: ${sanitizedMsg}`,
      };
    }
  }

  async sendRawMessage(text: string): Promise<boolean> {
    const result = await this.sendMessageWithResult(text);
    return result.status === "SUCCESS";
  }

  async sendNotification(payload: NotificationPayload): Promise<boolean> {
    const formatted = formatNotification(payload);
    const result = await this.sendMessageWithResult(formatted);
    return result.status === "SUCCESS";
  }
}

export const telegramNotifier = new TelegramNotifier();
