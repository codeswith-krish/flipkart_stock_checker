import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database, { type Database as DatabaseInstance } from "better-sqlite3";
import { runMigrations } from "../../src/db/migrations.js";
import { ProductRepository } from "../../src/db/repositories/product.repository.js";
import { addCommand } from "../../src/cli/commands/add.js";
import { listCommand } from "../../src/cli/commands/list.js";
import { removeCommand } from "../../src/cli/commands/remove.js";

// Mock the db client to use our in-memory test database for CLI commands
let testDb: DatabaseInstance;

vi.mock("../../src/db/client.js", () => {
  return {
    getDb: () => testDb,
    closeDb: () => {
      if (testDb && testDb.open) testDb.close();
    },
  };
});

describe("CLI Commands Integration (In-Memory DB)", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let tableSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    testDb = new Database(":memory:");
    runMigrations(testDb);

    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    tableSpy = vi.spyOn(console, "table").mockImplementation(() => {});
    exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {}) as unknown as (code?: string | number | null | undefined) => never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (testDb && testDb.open) {
      testDb.close();
    }
  });

  describe("stock add", () => {
    it("should successfully add a valid Flipkart product URL without requiring price", async () => {
      const url = "https://www.flipkart.com/sample-product/p/itm123?pid=MOBTEST123";
      await addCommand(url, { title: "Sample Smartphone" });

      const repo = new ProductRepository(testDb);
      const product = repo.findByProductId("MOBTEST123");

      expect(product).not.toBeNull();
      expect(product?.title).toBe("Sample Smartphone");
      expect(product?.cartAvailability).toBe("UNKNOWN");
      expect(product?.lastCheckStatus).toBe("NEVER_CHECKED");
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Product successfully added"));
      expect(exitSpy).not.toHaveBeenCalled();
    });

    it("should reject invalid non-Flipkart URLs", async () => {
      const invalidUrl = "https://www.amazon.in/dp/B08L5WH74G";
      await addCommand(invalidUrl, {});

      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Invalid Flipkart product URL"));
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it("should reject malformed URL strings", async () => {
      await addCommand("not-a-valid-url", {});

      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Invalid Flipkart product URL"));
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it("should warn and prevent duplicate URL additions", async () => {
      const url = "https://www.flipkart.com/item/p/itm456?pid=MOBTEST456";
      await addCommand(url, { title: "Original" });

      // Attempt duplicate addition
      await addCommand(url, { title: "Duplicate" });

      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("already registered"));

      const repo = new ProductRepository(testDb);
      const all = repo.findAll();
      expect(all.length).toBe(1);
    });

    it("should warn and prevent duplicate product ID additions across different URLs", async () => {
      const url1 = "https://www.flipkart.com/variant-1/p/itm789?pid=MOBPID789";
      const url2 = "https://www.flipkart.com/variant-2/p/itm999?pid=MOBPID789";

      await addCommand(url1, { title: "Variant 1" });
      await addCommand(url2, { title: "Variant 2" });

      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("already exists"));

      const repo = new ProductRepository(testDb);
      expect(repo.findAll().length).toBe(1);
    });
  });

  describe("stock list", () => {
    it("should handle empty product list gracefully", () => {
      listCommand({});
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("No products found in the database"));
    });

    it("should display table of tracked products with new status columns", async () => {
      const repo = new ProductRepository(testDb);
      repo.create({
        url: "https://www.flipkart.com/item-a/p/itm1?pid=PIDA",
        title: "Product A",
      });

      listCommand({});

      expect(tableSpy).toHaveBeenCalled();
      const tableData = tableSpy.mock.calls[0][0] as Record<string, unknown>[];
      expect(tableData.length).toBe(1);
      expect(tableData[0]).toHaveProperty("ID");
      expect(tableData[0]).toHaveProperty("Title", "Product A");
      expect(tableData[0]).toHaveProperty("Product ID", "PIDA");
      expect(tableData[0]).toHaveProperty("Active", "Yes");
      expect(tableData[0]).toHaveProperty("Cart Status", "⚪ Unknown");
      expect(tableData[0]).toHaveProperty("Check Status", "⚪ Never Checked");
      expect(tableData[0]).toHaveProperty("Alert State", "IDLE");
    });

    it("should filter inactive products unless --all is passed", async () => {
      const repo = new ProductRepository(testDb);
      const p1 = repo.create({ url: "https://www.flipkart.com/item-1/p/itm1?pid=PID1", title: "Active Item" });
      const p2 = repo.create({ url: "https://www.flipkart.com/item-2/p/itm2?pid=PID2", title: "Inactive Item" });

      repo.deactivate(p2.id);

      // Default active only
      listCommand({});
      const activeData = tableSpy.mock.calls[0][0] as Record<string, unknown>[];
      expect(activeData.length).toBe(1);
      expect(activeData[0].ID).toBe(p1.id);

      // --all option
      tableSpy.mockClear();
      listCommand({ all: true });
      const allData = tableSpy.mock.calls[0][0] as Record<string, unknown>[];
      expect(allData.length).toBe(2);
    });
  });

  describe("stock remove", () => {
    it("should deactivate product by default without deleting record", async () => {
      const repo = new ProductRepository(testDb);
      const product = repo.create({ url: "https://www.flipkart.com/item/p/itm1?pid=PID1", title: "Item" });

      removeCommand(String(product.id), {});

      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Deactivated product ID"));
      const found = repo.findById(product.id);
      expect(found).not.toBeNull();
      expect(found?.isActive).toBe(false);
    });

    it("should permanently delete product when --permanent is provided", async () => {
      const repo = new ProductRepository(testDb);
      const product = repo.create({ url: "https://www.flipkart.com/item/p/itm2?pid=PID2", title: "Item to Delete" });

      removeCommand(String(product.id), { permanent: true });

      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Permanently deleted product ID"));
      expect(repo.findById(product.id)).toBeNull();
    });

    it("should report error when non-existent ID is passed", () => {
      removeCommand("9999", {});

      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("was not found"));
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it("should report error when invalid non-numeric ID is passed", () => {
      removeCommand("abc", {});

      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Invalid product ID"));
      expect(exitSpy).toHaveBeenCalledWith(1);
    });
  });
});
