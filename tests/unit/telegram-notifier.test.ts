import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TelegramNotifier, redactTelegramToken } from "../../src/modules/notifier/telegram.js";
import type { Product, NotificationPayload } from "../../src/types/index.js";
import { logger } from "../../src/shared/logger.js";

describe("Telegram Notifier Client (Unit)", () => {
  const TEST_BOT_TOKEN = "123456789:ABCdefGhIJKlmNoPQRsTUVwxyZ_123456";
  const TEST_CHAT_ID = "-100987654321";
  let mockFetch: ReturnType<typeof vi.fn>;
  let notifier: TelegramNotifier;

  const mockProduct: Product = {
    id: 1,
    url: "https://www.flipkart.com/sample-product/p/itm123",
    productId: "itm123",
    title: "Sample Wireless Headphones",
    cartAvailability: "AVAILABLE",
    lastCheckStatus: "SUCCESS",
    lastErrorMessage: null,
    notificationState: "PENDING",
    lastAlertSentAt: null,
    lastCheckedAt: "2026-01-01T12:00:00.000Z",
    isActive: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T12:00:00.000Z",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch = vi.fn();
    notifier = new TelegramNotifier(TEST_BOT_TOKEN, TEST_CHAT_ID, mockFetch as unknown as typeof fetch);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("HTTP 200 & Response Validation", () => {
    it("should return SUCCESS when Telegram returns HTTP 200 with ok: true", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: "OK",
        json: vi.fn().mockResolvedValueOnce({
          ok: true,
          result: {
            message_id: 9988,
            chat: { id: TEST_CHAT_ID },
            text: "🚨 Flipkart Stock Alert!",
          },
        }),
      });

      const result = await notifier.sendMessageWithResult("🚨 Flipkart Stock Alert!");

      expect(result.status).toBe("SUCCESS");
      if (result.status === "SUCCESS") {
        expect(result.messageId).toBe(9988);
      }
      expect(mockFetch).toHaveBeenCalledTimes(1);

      // Verify request payload
      const [url, options] = mockFetch.mock.calls[0];
      expect(url).toBe(`https://api.telegram.org/bot${TEST_BOT_TOKEN}/sendMessage`);
      expect(options.method).toBe("POST");
      expect(options.headers).toEqual({ "Content-Type": "application/json" });

      const parsedBody = JSON.parse(options.body);
      expect(parsedBody.chat_id).toBe(TEST_CHAT_ID);
      expect(parsedBody.parse_mode).toBe("HTML");
    });

    it("should classify response as TEMPORARY_FAILURE when HTTP 200 contains ok: false", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: "OK",
        json: vi.fn().mockResolvedValueOnce({
          ok: false,
          description: "Internal gateway inconsistency",
        }),
      });

      const result = await notifier.sendMessageWithResult("Alert text");

      expect(result.status).toBe("TEMPORARY_FAILURE");
      if (result.status === "TEMPORARY_FAILURE") {
        expect(result.error).toContain("ok: false");
      }
    });

    it("should classify malformed JSON responses as TEMPORARY_FAILURE", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: "OK",
        json: vi.fn().mockRejectedValueOnce(new SyntaxError("Unexpected token < in JSON at position 0")),
      });

      const result = await notifier.sendMessageWithResult("Alert text");

      expect(result.status).toBe("TEMPORARY_FAILURE");
      if (result.status === "TEMPORARY_FAILURE") {
        expect(result.error).toContain("Malformed JSON response");
      }
    });
  });

  describe("HTTP 429 Rate Limiting & Retry-After Extraction", () => {
    it("should extract full parameters.retry_after and return RATE_LIMIT status", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 429,
        statusText: "Too Many Requests",
        json: vi.fn().mockResolvedValueOnce({
          ok: false,
          error_code: 429,
          description: "Too Many Requests: retry after 45",
          parameters: {
            retry_after: 45,
          },
        }),
      });

      const result = await notifier.sendMessageWithResult("Alert text");

      expect(result.status).toBe("RATE_LIMIT");
      if (result.status === "RATE_LIMIT") {
        expect(result.retryAfterSeconds).toBe(45);
        expect(result.error).toContain("HTTP 429");
      }
    });

    it("should fallback to 30 seconds if retry_after parameter is missing in HTTP 429", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 429,
        statusText: "Too Many Requests",
        json: vi.fn().mockResolvedValueOnce({
          ok: false,
          error_code: 429,
          description: "Too Many Requests",
        }),
      });

      const result = await notifier.sendMessageWithResult("Alert text");

      expect(result.status).toBe("RATE_LIMIT");
      if (result.status === "RATE_LIMIT") {
        expect(result.retryAfterSeconds).toBe(30);
      }
    });
  });

  describe("HTTP 5xx Server Errors (Temporary Failure)", () => {
    it.each([500, 502, 503, 504])("should classify HTTP %i as TEMPORARY_FAILURE", async (status) => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status,
        statusText: "Server Error",
        json: vi.fn().mockResolvedValueOnce({
          ok: false,
          error_code: status,
          description: `Internal Server Error ${status}`,
        }),
      });

      const result = await notifier.sendMessageWithResult("Alert text");

      expect(result.status).toBe("TEMPORARY_FAILURE");
      if (result.status === "TEMPORARY_FAILURE") {
        expect(result.errorCode).toBe(status);
        expect(result.error).toContain(`HTTP ${status}`);
      }
    });
  });

  describe("HTTP 4xx Client Errors (Permanent Failure)", () => {
    it.each([
      [400, "Bad Request: can't parse entities in message text: HTML error"],
      [401, "Unauthorized: bot token is invalid"],
      [403, "Forbidden: bot was blocked by the user"],
      [404, "Not Found: method not found"],
    ])("should classify HTTP %i as PERMANENT_FAILURE", async (status, description) => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status,
        statusText: "Client Error",
        json: vi.fn().mockResolvedValueOnce({
          ok: false,
          error_code: status,
          description,
        }),
      });

      const result = await notifier.sendMessageWithResult("Alert text");

      expect(result.status).toBe("PERMANENT_FAILURE");
      if (result.status === "PERMANENT_FAILURE") {
        expect(result.errorCode).toBe(status);
        expect(result.error).toContain(`HTTP ${status}`);
      }
    });
  });

  describe("Network Timeouts & Connection Failures", () => {
    it("should classify request timeout as UNKNOWN_DELIVERY", async () => {
      const abortError = new Error("The operation was aborted");
      abortError.name = "AbortError";
      mockFetch.mockRejectedValueOnce(abortError);

      const result = await notifier.sendMessageWithResult("Alert text");

      expect(result.status).toBe("UNKNOWN_DELIVERY");
      if (result.status === "UNKNOWN_DELIVERY") {
        expect(result.error).toContain("timed out after 10000ms");
      }
    });

    it("should classify socket / connection error as TEMPORARY_FAILURE", async () => {
      const connectionError = new TypeError("fetch failed: connect ECONNREFUSED 149.154.167.220:443");
      mockFetch.mockRejectedValueOnce(connectionError);

      const result = await notifier.sendMessageWithResult("Alert text");

      expect(result.status).toBe("TEMPORARY_FAILURE");
      if (result.status === "TEMPORARY_FAILURE") {
        expect(result.error).toContain("Network failure");
      }
    });
  });

  describe("Security, Token Redaction & Unconfigured Credentials", () => {
    it("should redact bot token from URLs and error logs", () => {
      const rawUrl = `https://api.telegram.org/bot${TEST_BOT_TOKEN}/sendMessage`;
      const redacted = redactTelegramToken(rawUrl, TEST_BOT_TOKEN);

      expect(redacted).not.toContain(TEST_BOT_TOKEN);
      expect(redacted).toBe("https://api.telegram.org/bot[REDACTED]/sendMessage");
    });

    it("should immediately reject without network call when bot token is dummy or empty", async () => {
      const dummyNotifier = new TelegramNotifier("dummy_token", TEST_CHAT_ID, mockFetch as unknown as typeof fetch);

      const result = await dummyNotifier.sendMessageWithResult("Alert text");

      expect(result.status).toBe("PERMANENT_FAILURE");
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("should immediately reject without network call when chat ID is dummy or empty", async () => {
      const dummyNotifier = new TelegramNotifier(TEST_BOT_TOKEN, "dummy_chat_id", mockFetch as unknown as typeof fetch);

      const result = await dummyNotifier.sendMessageWithResult("Alert text");

      expect(result.status).toBe("PERMANENT_FAILURE");
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe("INotifier Interface Compatibility", () => {
    it("should return true for sendRawMessage when delivery succeeds", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValueOnce({ ok: true, result: { message_id: 101 } }),
      });

      const success = await notifier.sendRawMessage("Raw message");
      expect(success).toBe(true);
    });

    it("should return false for sendRawMessage when delivery fails", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: vi.fn().mockResolvedValueOnce({ ok: false }),
      });

      const success = await notifier.sendRawMessage("Raw message");
      expect(success).toBe(false);
    });

    it("should format and send CART_SUCCESS notification via sendNotification", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValueOnce({ ok: true, result: { message_id: 102 } }),
      });

      const payload: NotificationPayload = {
        type: "CART_SUCCESS",
        product: mockProduct,
      };

      const success = await notifier.sendNotification(payload);
      expect(success).toBe(true);

      const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(sentBody.text).toContain("🚨 <b>Flipkart Stock Alert!</b>");
      expect(sentBody.text).toContain("<b>Cart Availability:</b> AVAILABLE");
      expect(sentBody.text).toContain("<b>Status:</b> Cart Availability Confirmed");
      expect(sentBody.text).toContain("Sample Wireless Headphones");
    });
  });
});
