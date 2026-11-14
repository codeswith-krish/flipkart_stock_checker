import type { Database as DatabaseInstance } from "better-sqlite3";
import { getDb } from "../client.js";
import type { Product, NewProductInput } from "../../types/index.js";
import { DatabaseError } from "../../shared/errors.js";

interface ProductRow {
  id: number;
  url: string;
  title: string;
  target_price: number;
  current_price: number | null;
  is_in_stock: number;
  is_active: number;
  created_at: string;
  updated_at: string;
}

function mapRowToProduct(row: ProductRow): Product {
  return {
    id: row.id,
    url: row.url,
    title: row.title,
    targetPrice: row.target_price,
    currentPrice: row.current_price,
    inStock: Boolean(row.is_in_stock),
    isActive: Boolean(row.is_active),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class ProductRepository {
  private db: DatabaseInstance;

  constructor(db?: DatabaseInstance) {
    this.db = db || getDb();
  }

  create(input: NewProductInput): Product {
    try {
      const now = new Date().toISOString();
      const stmt = this.db.prepare(`
        INSERT INTO products (url, title, target_price, current_price, is_in_stock, is_active, created_at, updated_at)
        VALUES (?, ?, ?, NULL, 1, 1, ?, ?)
      `);

      const result = stmt.run(
        input.url,
        input.title || "Pending Scrape",
        input.targetPrice,
        now,
        now
      );

      return this.findById(Number(result.lastInsertRowid))!;
    } catch (error) {
      throw new DatabaseError("Failed to insert product", error);
    }
  }

  findById(id: number): Product | null {
    try {
      const stmt = this.db.prepare("SELECT * FROM products WHERE id = ?");
      const row = stmt.get(id) as ProductRow | undefined;
      return row ? mapRowToProduct(row) : null;
    } catch (error) {
      throw new DatabaseError(`Failed to fetch product with id ${id}`, error);
    }
  }

  findByUrl(url: string): Product | null {
    try {
      const stmt = this.db.prepare("SELECT * FROM products WHERE url = ?");
      const row = stmt.get(url) as ProductRow | undefined;
      return row ? mapRowToProduct(row) : null;
    } catch (error) {
      throw new DatabaseError(`Failed to fetch product by URL: ${url}`, error);
    }
  }

  findActive(): Product[] {
    try {
      const stmt = this.db.prepare("SELECT * FROM products WHERE is_active = 1 ORDER BY id ASC");
      const rows = stmt.all() as ProductRow[];
      return rows.map(mapRowToProduct);
    } catch (error) {
      throw new DatabaseError("Failed to fetch active products", error);
    }
  }

  findAll(): Product[] {
    try {
      const stmt = this.db.prepare("SELECT * FROM products ORDER BY id DESC");
      const rows = stmt.all() as ProductRow[];
      return rows.map(mapRowToProduct);
    } catch (error) {
      throw new DatabaseError("Failed to fetch all products", error);
    }
  }

  updatePriceAndStock(id: number, currentPrice: number | null, inStock: boolean, title?: string): void {
    try {
      const now = new Date().toISOString();
      if (title) {
        const stmt = this.db.prepare(`
          UPDATE products
          SET current_price = ?, is_in_stock = ?, title = ?, updated_at = ?
          WHERE id = ?
        `);
        stmt.run(currentPrice, inStock ? 1 : 0, title, now, id);
      } else {
        const stmt = this.db.prepare(`
          UPDATE products
          SET current_price = ?, is_in_stock = ?, updated_at = ?
          WHERE id = ?
        `);
        stmt.run(currentPrice, inStock ? 1 : 0, now, id);
      }
    } catch (error) {
      throw new DatabaseError(`Failed to update product ${id}`, error);
    }
  }

  deactivate(id: number): boolean {
    try {
      const now = new Date().toISOString();
      const stmt = this.db.prepare("UPDATE products SET is_active = 0, updated_at = ? WHERE id = ?");
      const result = stmt.run(now, id);
      return result.changes > 0;
    } catch (error) {
      throw new DatabaseError(`Failed to deactivate product ${id}`, error);
    }
  }

  delete(id: number): boolean {
    try {
      const stmt = this.db.prepare("DELETE FROM products WHERE id = ?");
      const result = stmt.run(id);
      return result.changes > 0;
    } catch (error) {
      throw new DatabaseError(`Failed to delete product ${id}`, error);
    }
  }
}
