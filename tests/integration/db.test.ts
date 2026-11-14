import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database, { type Database as DatabaseInstance } from "better-sqlite3";
import { runMigrations } from "../../src/db/migrations.js";
import { ProductRepository } from "../../src/db/repositories/product.repository.js";
import { PriceHistoryRepository } from "../../src/db/repositories/price-history.repository.js";

describe("Database Repositories (In-Memory)", () => {
  let db: DatabaseInstance;
  let productRepo: ProductRepository;
  let historyRepo: PriceHistoryRepository;

  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db);
    productRepo = new ProductRepository(db);
    historyRepo = new PriceHistoryRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  it("should create, find, update and deactivate products", () => {
    // 1. Create product
    const product = productRepo.create({
      url: "https://www.flipkart.com/item/p/itm123",
      title: "Test Headphones",
      targetPrice: 2000,
    });

    expect(product.id).toBeDefined();
    expect(product.targetPrice).toBe(2000);
    expect(product.inStock).toBe(true);
    expect(product.isActive).toBe(true);

    // 2. Find by URL
    const found = productRepo.findByUrl("https://www.flipkart.com/item/p/itm123");
    expect(found).not.toBeNull();
    expect(found?.title).toBe("Test Headphones");

    // 3. Update price and stock
    productRepo.updatePriceAndStock(product.id, 1800, true, "Test Headphones Updated");
    const updated = productRepo.findById(product.id);
    expect(updated?.currentPrice).toBe(1800);
    expect(updated?.title).toBe("Test Headphones Updated");

    // 4. Record price history
    historyRepo.record(product.id, 1800, true);
    const history = historyRepo.findByProductId(product.id);
    expect(history.length).toBe(1);
    expect(history[0].price).toBe(1800);

    // 5. Deactivate product
    const deactivated = productRepo.deactivate(product.id);
    expect(deactivated).toBe(true);

    const activeList = productRepo.findActive();
    expect(activeList.length).toBe(0);

    const allList = productRepo.findAll();
    expect(allList.length).toBe(1);
  });
});
