import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database, { type Database as DatabaseInstance } from "better-sqlite3";
import { runMigrations } from "../../src/db/migrations.js";
import { ProductRepository } from "../../src/db/repositories/product.repository.js";
import { PriceHistoryRepository } from "../../src/db/repositories/price-history.repository.js";
import { CheckEngine } from "../../src/modules/checker/check-engine.js";
import { MockNotifier } from "../mocks/mock-telegram.js";
import type { IScraper, ScrapedProductData } from "../../src/modules/scraper/types.js";

class MockScraper implements IScraper {
  public mockData: Map<string, ScrapedProductData> = new Map();

  async scrapeProduct(url: string): Promise<ScrapedProductData> {
    const data = this.mockData.get(url);
    if (!data) {
      return { url, title: null, price: null, inStock: false, error: "Not found" };
    }
    return data;
  }

  async close(): Promise<void> {}
}

describe("CheckEngine Integration", () => {
  let db: DatabaseInstance;
  let productRepo: ProductRepository;
  let historyRepo: PriceHistoryRepository;
  let mockScraper: MockScraper;
  let mockNotifier: MockNotifier;
  let checkEngine: CheckEngine;

  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db);
    productRepo = new ProductRepository(db);
    historyRepo = new PriceHistoryRepository(db);
    mockScraper = new MockScraper();
    mockNotifier = new MockNotifier();
    checkEngine = new CheckEngine(productRepo, historyRepo, mockScraper, mockNotifier);
  });

  afterEach(() => {
    db.close();
  });

  it("should trigger PRICE_DROP alert when price hits or falls below target", async () => {
    const url = "https://www.flipkart.com/sample/p/itm123";
    const product = productRepo.create({
      url,
      title: "Gadget",
      targetPrice: 2000,
    });

    // Set initial price higher than target
    productRepo.updatePriceAndStock(product.id, 2500, true);

    // Mock price drop below target
    mockScraper.mockData.set(url, {
      url,
      title: "Gadget",
      price: 1900,
      inStock: true,
    });

    const refreshedProduct = productRepo.findById(product.id)!;
    const result = await checkEngine.runSingleCheck(refreshedProduct);

    expect(result.alertTriggered).toBe(true);
    expect(result.currentPrice).toBe(1900);
    expect(mockNotifier.sentNotifications.length).toBe(1);
    expect(mockNotifier.sentNotifications[0].type).toBe("PRICE_DROP");

    // Verify DB updated
    const updated = productRepo.findById(product.id);
    expect(updated?.currentPrice).toBe(1900);
  });

  it("should trigger BACK_IN_STOCK alert when an out-of-stock item becomes available", async () => {
    const url = "https://www.flipkart.com/sample/p/itm456";
    const product = productRepo.create({
      url,
      title: "Out-of-stock Item",
      targetPrice: 1000,
    });

    // Set product as out of stock initially
    productRepo.updatePriceAndStock(product.id, 1200, false);

    // Mock becoming available (price still above target, but back in stock)
    mockScraper.mockData.set(url, {
      url,
      title: "Out-of-stock Item",
      price: 1200,
      inStock: true,
    });

    const refreshedProduct = productRepo.findById(product.id)!;
    const result = await checkEngine.runSingleCheck(refreshedProduct);

    expect(result.alertTriggered).toBe(true);
    expect(mockNotifier.sentNotifications.length).toBe(1);
    expect(mockNotifier.sentNotifications[0].type).toBe("BACK_IN_STOCK");
  });
});
