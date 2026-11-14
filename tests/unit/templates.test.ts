import { describe, it, expect } from "vitest";
import { formatNotification } from "../../src/modules/notifier/templates.js";
import type { Product } from "../../src/types/index.js";

describe("Notification Templates", () => {
  const mockProduct: Product = {
    id: 1,
    url: "https://www.flipkart.com/sample-product/p/itm123",
    title: "Wireless Noise Cancelling Headphones",
    targetPrice: 2000,
    currentPrice: 2500,
    inStock: true,
    isActive: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };

  it("should format PRICE_DROP notification correctly", () => {
    const message = formatNotification({
      type: "PRICE_DROP",
      product: mockProduct,
      previousPrice: 2500,
      currentPrice: 1800,
    });

    expect(message).toContain("PRICE DROP ALERT");
    expect(message).toContain("Wireless Noise Cancelling Headphones");
    expect(message).toContain("1,800");
    expect(message).toContain("2,000");
    expect(message).toContain("Down by");
  });

  it("should format BACK_IN_STOCK notification correctly", () => {
    const message = formatNotification({
      type: "BACK_IN_STOCK",
      product: mockProduct,
      previousPrice: null,
      currentPrice: 2000,
    });

    expect(message).toContain("BACK IN STOCK");
    expect(message).toContain("Wireless Noise Cancelling Headphones");
    expect(message).toContain("https://www.flipkart.com/sample-product/p/itm123");
  });
});
