import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database, { type Database as DatabaseInstance } from "better-sqlite3";
import { runMigrations } from "../../src/db/migrations.js";
import { ProductRepository } from "../../src/db/repositories/product.repository.js";
import { DatabaseError } from "../../src/shared/errors.js";

describe("Database & ProductRepository Integration (In-Memory)", () => {
  let db: DatabaseInstance;
  let productRepo: ProductRepository;

  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db);
    productRepo = new ProductRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  describe("Product Creation & Defaults", () => {
    it("should create a product with correct initial state defaults and extract PID", () => {
      const url = "https://www.flipkart.com/sony-headphones/p/itm123?pid=ACC12345&marketplace=FLIPKART";
      const product = productRepo.create({
        url,
        title: "Sony Noise Cancelling Headphones",
      });

      expect(product.id).toBeGreaterThan(0);
      expect(product.title).toBe("Sony Noise Cancelling Headphones");
      expect(product.productId).toBe("ACC12345");
      expect(product.isActive).toBe(true);
      expect(product.cartAvailability).toBe("UNKNOWN");
      expect(product.lastCheckStatus).toBe("NEVER_CHECKED");
      expect(product.lastErrorMessage).toBeNull();
      expect(product.notificationState).toBe("IDLE");
      expect(product.lastAlertSentAt).toBeNull();
      expect(product.lastCheckedAt).toBeNull();
      expect(product.notificationCycle).toBe(0);
      expect(product.retryCount).toBe(0);
      expect(product.nextRetryAt).toBeNull();
      expect(product.lastDeliveryError).toBeNull();
      expect(product.createdAt).toBeDefined();
      expect(product.updatedAt).toBeDefined();
    });

    it("should provide default title if title is not provided", () => {
      const product = productRepo.create({
        url: "https://www.flipkart.com/product/p/itm999?pid=MOB99999",
      });

      expect(product.title).toBe("Pending Initial Check");
      expect(product.productId).toBe("MOB99999");
    });
  });

  describe("URL & Product ID Deduplication", () => {
    it("should prevent duplicate product insertion with identical canonical URL", () => {
      const url = "https://www.flipkart.com/sample/p/itm111?pid=PID111";
      productRepo.create({ url, title: "Item 1" });

      // Attempt adding same URL with extra tracking parameters
      const duplicateUrl = "https://www.flipkart.com/sample/p/itm111?pid=PID111&spotlight=true&semcmpid=google";
      expect(() => {
        productRepo.create({ url: duplicateUrl, title: "Item 1 Dup" });
      }).toThrowError(DatabaseError);

      try {
        productRepo.create({ url: duplicateUrl });
      } catch (err) {
        expect((err as DatabaseError).code).toBe("DUPLICATE_PRODUCT");
      }
    });

    it("should prevent duplicate product insertion with different URL but same Flipkart PID", () => {
      const url1 = "https://www.flipkart.com/variant-black/p/itm222?pid=MOBVAR222";
      productRepo.create({ url: url1, title: "Variant Black" });

      const url2 = "https://www.flipkart.com/variant-blue/p/itm333?pid=MOBVAR222";
      expect(() => {
        productRepo.create({ url: url2, title: "Variant Blue" });
      }).toThrowError(DatabaseError);
    });
  });

  describe("Lookups & Filtering", () => {
    it("should find products by ID, URL, and Product ID", () => {
      const url = "https://www.flipkart.com/item/p/itm444?pid=MOB44444";
      const created = productRepo.create({ url, title: "Phone" });

      const byId = productRepo.findById(created.id);
      expect(byId?.id).toBe(created.id);

      const byUrl = productRepo.findByUrl("https://www.flipkart.com/item/p/itm444?pid=MOB44444&extra=1");
      expect(byUrl?.id).toBe(created.id);

      const byPid = productRepo.findByProductId("MOB44444");
      expect(byPid?.id).toBe(created.id);
    });

    it("should filter active vs all products", () => {
      const p1 = productRepo.create({ url: "https://www.flipkart.com/a/p/itm1?pid=A1", title: "A" });
      const p2 = productRepo.create({ url: "https://www.flipkart.com/b/p/itm2?pid=B2", title: "B" });

      productRepo.deactivate(p1.id);

      const active = productRepo.findActive();
      expect(active.length).toBe(1);
      expect(active[0].id).toBe(p2.id);

      const all = productRepo.findAll();
      expect(all.length).toBe(2);
    });
  });

  describe("Activation, Deactivation & Deletion", () => {
    it("should deactivate, reactivate and permanently delete products", () => {
      const product = productRepo.create({ url: "https://www.flipkart.com/test/p/itm5?pid=T5" });

      // Deactivate
      expect(productRepo.deactivate(product.id)).toBe(true);
      expect(productRepo.findById(product.id)?.isActive).toBe(false);

      // Reactivate
      expect(productRepo.activate(product.id)).toBe(true);
      expect(productRepo.findById(product.id)?.isActive).toBe(true);

      // Delete
      expect(productRepo.delete(product.id)).toBe(true);
      expect(productRepo.findById(product.id)).toBeNull();
    });
  });

  describe("State Separation: Check Results & Technical Errors", () => {
    it("should update cart availability and transition notification state on SUCCESS", () => {
      const product = productRepo.create({ url: "https://www.flipkart.com/item/p/itm6?pid=T6" });

      productRepo.updateCheckResult(product.id, {
        checkStatus: "SUCCESS",
        cartAvailability: "AVAILABLE",
      });

      const updated = productRepo.findById(product.id)!;
      expect(updated.lastCheckStatus).toBe("SUCCESS");
      expect(updated.cartAvailability).toBe("AVAILABLE");
      expect(updated.lastErrorMessage).toBeNull();
      expect(updated.lastCheckedAt).toBeDefined();
      // When cart becomes AVAILABLE from IDLE, notificationState transitions to PENDING
      expect(updated.notificationState).toBe("PENDING");
    });

    it("should preserve cart availability and notification state when a technical check fails with ERROR", () => {
      const product = productRepo.create({ url: "https://www.flipkart.com/item/p/itm7?pid=T7" });

      // First simulate verified cart success
      productRepo.updateCheckResult(product.id, {
        checkStatus: "SUCCESS",
        cartAvailability: "AVAILABLE",
      });

      const beforeError = productRepo.findById(product.id)!;
      expect(beforeError.cartAvailability).toBe("AVAILABLE");
      expect(beforeError.notificationState).toBe("PENDING");

      // Now simulate network failure or Playwright timeout
      productRepo.updateCheckResult(product.id, {
        checkStatus: "ERROR",
        errorMessage: "Navigation timeout 30000ms exceeded",
      });

      const afterError = productRepo.findById(product.id)!;
      // Technical status is ERROR with error details
      expect(afterError.lastCheckStatus).toBe("ERROR");
      expect(afterError.lastErrorMessage).toBe("Navigation timeout 30000ms exceeded");
      // CRITICAL: Cart availability and notification state are PRESERVED!
      expect(afterError.cartAvailability).toBe("AVAILABLE");
      expect(afterError.notificationState).toBe("PENDING");
    });

    it("should reset notification state to IDLE when item becomes confirmed OUT_OF_STOCK", () => {
      const product = productRepo.create({ url: "https://www.flipkart.com/item/p/itm8?pid=T8" });

      // Make available
      productRepo.updateCheckResult(product.id, {
        checkStatus: "SUCCESS",
        cartAvailability: "AVAILABLE",
      });
      expect(productRepo.findById(product.id)?.notificationState).toBe("PENDING");

      // Confirmed out of stock
      productRepo.updateCheckResult(product.id, {
        checkStatus: "SUCCESS",
        cartAvailability: "OUT_OF_STOCK",
      });
      const oosProduct = productRepo.findById(product.id)!;
      expect(oosProduct.cartAvailability).toBe("OUT_OF_STOCK");
      expect(oosProduct.notificationState).toBe("IDLE");
    });
  });

  describe("Notification State Persistence", () => {
    it("should update notification delivery state and record timestamp independently", () => {
      const product = productRepo.create({ url: "https://www.flipkart.com/item/p/itm9?pid=T9" });

      const deliveredAt = new Date().toISOString();
      productRepo.updateNotificationState(product.id, "DELIVERED", deliveredAt);

      const updated = productRepo.findById(product.id)!;
      expect(updated.notificationState).toBe("DELIVERED");
      expect(updated.lastAlertSentAt).toBe(deliveredAt);
      expect(updated.cartAvailability).toBe("UNKNOWN"); // Untouched
      expect(updated.lastCheckStatus).toBe("NEVER_CHECKED"); // Untouched
    });
  });

  describe("Migrations & Persistence", () => {
    it("should execute migrations non-destructively and maintain table integrity", () => {
      // Running migrations again on already initialized database should be safe and idempotent
      expect(() => runMigrations(db)).not.toThrow();

      // Verify table still works and data persists
      const product = productRepo.create({ url: "https://www.flipkart.com/p/p/itm10?pid=T10" });
      expect(productRepo.findById(product.id)).not.toBeNull();
    });
  });
});
