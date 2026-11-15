import { describe, it, expect } from "vitest";
import {
  formatNotification,
  formatCartSuccessMessage,
  escapeHtml,
  escapeUrlAttribute,
} from "../../src/modules/notifier/templates.js";
import type { Product } from "../../src/types/index.js";
import { NotificationError } from "../../src/shared/errors.js";

describe("Notification Templates (Phase 4)", () => {
  const mockProduct: Product = {
    id: 1,
    url: "https://www.flipkart.com/sample-product/p/itm123?pid=MOB123",
    productId: "MOB123",
    title: "Wireless Noise Cancelling Headphones",
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

  describe("CART_SUCCESS Template", () => {
    it("should format CART_SUCCESS notification with required structure and accurate status", () => {
      const message = formatNotification({
        type: "CART_SUCCESS",
        product: mockProduct,
      });

      expect(message).toContain("🚨 <b>Flipkart Stock Alert!</b>");
      expect(message).toContain("<b>Product:</b> Wireless Noise Cancelling Headphones");
      expect(message).toContain("<b>Cart Availability:</b> AVAILABLE");
      expect(message).toContain("<b>Status:</b> Cart Availability Confirmed");
      expect(message).toContain("<b>Verified At:</b> 2026-01-01T12:00:00.000Z");
      expect(message).toContain(
        '<a href="https://www.flipkart.com/sample-product/p/itm123?pid=MOB123">Open on Flipkart</a>'
      );
    });

    it("should strictly omit any price or price drop fields", () => {
      const message = formatNotification({
        type: "CART_SUCCESS",
        product: mockProduct,
      });

      expect(message).not.toContain("PRICE DROP");
      expect(message).not.toContain("Down by");
      expect(message).not.toContain("Target Price");
      expect(message).not.toContain("Current Price");
      expect(message).not.toContain("₹");
    });

    it("should use generic 'Cart Availability Confirmed' wording for all cart reasons", () => {
      const message = formatCartSuccessMessage(mockProduct);
      expect(message).toContain("<b>Status:</b> Cart Availability Confirmed");
      expect(message).not.toContain("Newly Added to Cart");
    });

    it("should handle missing product title and lastCheckedAt gracefully", () => {
      const incompleteProduct: Product = {
        ...mockProduct,
        title: "",
        lastCheckedAt: null,
      };

      const message = formatCartSuccessMessage(incompleteProduct);
      expect(message).toContain("<b>Product:</b> Unknown Product");
      expect(message).toContain("<b>Verified At:</b>");
    });
  });

  describe("HTML & URL Attribute Injection Prevention", () => {
    it("should escape special HTML entities in product titles", () => {
      const maliciousProduct: Product = {
        ...mockProduct,
        title: '<script>alert("hack")</script> & "Headphones" <special>',
      };

      const message = formatCartSuccessMessage(maliciousProduct);
      expect(message).not.toContain("<script>");
      expect(message).not.toContain('alert("hack")');
      expect(message).toContain("&lt;script&gt;alert(&quot;hack&quot;)&lt;/script&gt;");
      expect(message).toContain("&amp; &quot;Headphones&quot; &lt;special&gt;");
    });

    it("should escape quote characters in URL attributes to prevent breakout", () => {
      const escaped = escapeUrlAttribute('https://www.flipkart.com/p?param="><script>');
      expect(escaped).not.toContain('"');
      expect(escaped).toContain("&quot;&gt;&lt;script&gt;");
    });

    it("should safely handle non-Flipkart or invalid URLs by rendering plaintext without <a> tag", () => {
      const invalidProduct: Product = {
        ...mockProduct,
        url: 'javascript:alert("pwned")',
      };

      const message = formatCartSuccessMessage(invalidProduct);
      expect(message).not.toContain('<a href="javascript:');
      expect(message).toContain("javascript:alert");
    });

    it("should verify escapeHtml utility handles null, undefined, and non-string inputs", () => {
      expect(escapeHtml(null)).toBe("");
      expect(escapeHtml(undefined)).toBe("");
      expect(escapeHtml(12345)).toBe("12345");
      expect(escapeHtml("Tom & Jerry")).toBe("Tom &amp; Jerry");
      expect(escapeHtml("He said 'hello'")).toBe("He said &#39;hello&#39;");
    });
  });

  describe("INFO and Unsupported Template Handling", () => {
    it("should format INFO notifications with safe HTML", () => {
      const message = formatNotification({
        type: "INFO",
        product: mockProduct,
        message: "Stock monitoring resumed successfully",
      });

      expect(message).toContain("ℹ️ <b>Stock Checker Notification</b>");
      expect(message).toContain("Stock monitoring resumed successfully");
      expect(message).toContain("View Product");
    });

    it("should throw NotificationError for obsolete or unknown notification types", () => {
      expect(() =>
        formatNotification({
          type: "PRICE_DROP" as any,
          product: mockProduct,
        })
      ).toThrow(NotificationError);

      expect(() =>
        formatNotification({
          type: "BACK_IN_STOCK" as any,
          product: mockProduct,
        })
      ).toThrow(NotificationError);
    });
  });
});
