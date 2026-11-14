import type { Database as DatabaseInstance } from "better-sqlite3";
import { getDb } from "../client.js";
import type { PriceHistory } from "../../types/index.js";
import { DatabaseError } from "../../shared/errors.js";

interface PriceHistoryRow {
  id: number;
  product_id: number;
  price: number | null;
  is_in_stock: number;
  error_message: string | null;
  checked_at: string;
}

function mapRowToPriceHistory(row: PriceHistoryRow): PriceHistory {
  return {
    id: row.id,
    productId: row.product_id,
    price: row.price,
    inStock: Boolean(row.is_in_stock),
    errorMessage: row.error_message,
    checkedAt: row.checked_at,
  };
}

export class PriceHistoryRepository {
  private db: DatabaseInstance;

  constructor(db?: DatabaseInstance) {
    this.db = db || getDb();
  }

  record(productId: number, price: number | null, inStock: boolean, errorMessage?: string | null): PriceHistory {
    try {
      const now = new Date().toISOString();
      const stmt = this.db.prepare(`
        INSERT INTO price_history (product_id, price, is_in_stock, error_message, checked_at)
        VALUES (?, ?, ?, ?, ?)
      `);

      const result = stmt.run(
        productId,
        price,
        inStock ? 1 : 0,
        errorMessage || null,
        now
      );

      return {
        id: Number(result.lastInsertRowid),
        productId,
        price,
        inStock,
        errorMessage: errorMessage || null,
        checkedAt: now,
      };
    } catch (error) {
      throw new DatabaseError(`Failed to record price history for product ${productId}`, error);
    }
  }

  findByProductId(productId: number, limit: number = 20): PriceHistory[] {
    try {
      const stmt = this.db.prepare(`
        SELECT * FROM price_history
        WHERE product_id = ?
        ORDER BY checked_at DESC
        LIMIT ?
      `);
      const rows = stmt.all(productId, limit) as PriceHistoryRow[];
      return rows.map(mapRowToPriceHistory);
    } catch (error) {
      throw new DatabaseError(`Failed to fetch price history for product ${productId}`, error);
    }
  }
}
