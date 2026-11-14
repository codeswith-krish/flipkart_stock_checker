import type { Database as DatabaseInstance } from "better-sqlite3";
import { getDb } from "../client.js";
import type {
  Product,
  NewProductInput,
  UpdateCheckResultInput,
  CartAvailability,
  CheckStatus,
  NotificationState,
} from "../../types/index.js";
import { DatabaseError } from "../../shared/errors.js";
import { sanitizeFlipkartUrl, extractFlipkartProductId } from "../../shared/utils.js";

interface ProductRow {
  id: number;
  url: string;
  product_id: string | null;
  title: string;
  is_active: number;
  cart_availability: string;
  last_check_status: string;
  last_error_message: string | null;
  notification_state: string;
  last_alert_sent_at: string | null;
  last_checked_at: string | null;
  created_at: string;
  updated_at: string;
}

function mapRowToProduct(row: ProductRow): Product {
  return {
    id: row.id,
    url: row.url,
    productId: row.product_id,
    title: row.title,
    isActive: Boolean(row.is_active),
    cartAvailability: row.cart_availability as CartAvailability,
    lastCheckStatus: row.last_check_status as CheckStatus,
    lastErrorMessage: row.last_error_message,
    notificationState: row.notification_state as NotificationState,
    lastAlertSentAt: row.last_alert_sent_at,
    lastCheckedAt: row.last_checked_at,
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
    const cleanUrl = sanitizeFlipkartUrl(input.url);
    const productId = extractFlipkartProductId(cleanUrl);

    // Reliable duplicate prevention by canonical URL
    const existingByUrl = this.findByUrl(cleanUrl);
    if (existingByUrl) {
      throw new DatabaseError(
        `Product with URL "${cleanUrl}" already exists (ID: ${existingByUrl.id}).`,
        "DUPLICATE_PRODUCT"
      );
    }

    // Reliable duplicate prevention by Flipkart product ID where available
    if (productId) {
      const existingByPid = this.findByProductId(productId);
      if (existingByPid) {
        throw new DatabaseError(
          `Product with Flipkart ID "${productId}" already exists (ID: ${existingByPid.id}, Title: "${existingByPid.title}").`,
          "DUPLICATE_PRODUCT"
        );
      }
    }

    try {
      const now = new Date().toISOString();
      const stmt = this.db.prepare(`
        INSERT INTO products (
          url,
          product_id,
          title,
          is_active,
          cart_availability,
          last_check_status,
          last_error_message,
          notification_state,
          last_alert_sent_at,
          last_checked_at,
          created_at,
          updated_at
        )
        VALUES (?, ?, ?, 1, 'UNKNOWN', 'NEVER_CHECKED', NULL, 'IDLE', NULL, NULL, ?, ?)
      `);

      const result = stmt.run(
        cleanUrl,
        productId,
        input.title || "Pending Initial Check",
        now,
        now
      );

      return this.findById(Number(result.lastInsertRowid))!;
    } catch (error) {
      throw new DatabaseError("Failed to insert product record into SQLite", error);
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
      const cleanUrl = sanitizeFlipkartUrl(url);
      const stmt = this.db.prepare("SELECT * FROM products WHERE url = ?");
      const row = stmt.get(cleanUrl) as ProductRow | undefined;
      return row ? mapRowToProduct(row) : null;
    } catch (error) {
      throw new DatabaseError(`Failed to fetch product by URL: ${url}`, error);
    }
  }

  findByProductId(productId: string): Product | null {
    try {
      const stmt = this.db.prepare("SELECT * FROM products WHERE product_id = ?");
      const row = stmt.get(productId) as ProductRow | undefined;
      return row ? mapRowToProduct(row) : null;
    } catch (error) {
      throw new DatabaseError(`Failed to fetch product by product ID: ${productId}`, error);
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

  updateCheckResult(id: number, input: UpdateCheckResultInput): void {
    const existing = this.findById(id);
    if (!existing) {
      throw new DatabaseError(`Product with ID ${id} not found for check result update`);
    }

    const now = new Date().toISOString();
    const checkedAt = input.checkedAt || now;

    try {
      if (input.checkStatus === "ERROR") {
        // Preserve existing cart_availability on technical check error
        const stmt = this.db.prepare(`
          UPDATE products
          SET
            last_check_status = 'ERROR',
            last_error_message = ?,
            last_checked_at = ?,
            updated_at = ?
          WHERE id = ?
        `);
        stmt.run(input.errorMessage || "Unknown check error", checkedAt, now, id);
      } else {
        // SUCCESS: Clear error, update availability if provided
        const newAvailability = input.cartAvailability !== undefined
          ? input.cartAvailability
          : existing.cartAvailability;

        // Transition notification state if cart becomes available
        let newNotificationState = existing.notificationState;
        if (newAvailability === "AVAILABLE" && existing.notificationState === "IDLE") {
          newNotificationState = "PENDING";
        } else if (newAvailability === "OUT_OF_STOCK") {
          newNotificationState = "IDLE";
        }

        const stmt = this.db.prepare(`
          UPDATE products
          SET
            cart_availability = ?,
            last_check_status = 'SUCCESS',
            last_error_message = NULL,
            notification_state = ?,
            last_checked_at = ?,
            updated_at = ?
          WHERE id = ?
        `);
        stmt.run(newAvailability, newNotificationState, checkedAt, now, id);
      }
    } catch (error) {
      throw new DatabaseError(`Failed to update check result for product ${id}`, error);
    }
  }

  updateNotificationState(
    id: number,
    state: NotificationState,
    alertSentAt?: string | null
  ): void {
    try {
      const now = new Date().toISOString();
      if (alertSentAt !== undefined) {
        const stmt = this.db.prepare(`
          UPDATE products
          SET notification_state = ?, last_alert_sent_at = ?, updated_at = ?
          WHERE id = ?
        `);
        stmt.run(state, alertSentAt, now, id);
      } else {
        const stmt = this.db.prepare(`
          UPDATE products
          SET notification_state = ?, updated_at = ?
          WHERE id = ?
        `);
        stmt.run(state, now, id);
      }
    } catch (error) {
      throw new DatabaseError(`Failed to update notification state for product ${id}`, error);
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

  activate(id: number): boolean {
    try {
      const now = new Date().toISOString();
      const stmt = this.db.prepare("UPDATE products SET is_active = 1, updated_at = ? WHERE id = ?");
      const result = stmt.run(now, id);
      return result.changes > 0;
    } catch (error) {
      throw new DatabaseError(`Failed to activate product ${id}`, error);
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
