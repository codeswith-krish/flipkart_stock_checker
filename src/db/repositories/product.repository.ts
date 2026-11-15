import type { Database as DatabaseInstance } from "better-sqlite3";
import { getDb } from "../client.js";
import type {
  Product,
  NewProductInput,
  UpdateCheckResultInput,
  CartAvailability,
  CheckStatus,
  NotificationState,
  NotificationFailureDetails,
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
  notification_cycle: number;
  retry_count: number;
  next_retry_at: string | null;
  last_delivery_error: string | null;
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
    notificationCycle: row.notification_cycle ?? 0,
    retryCount: row.retry_count ?? 0,
    nextRetryAt: row.next_retry_at ?? null,
    lastDeliveryError: row.last_delivery_error ?? null,
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
          notification_cycle,
          retry_count,
          next_retry_at,
          last_delivery_error,
          created_at,
          updated_at
        )
        VALUES (?, ?, ?, 1, 'UNKNOWN', 'NEVER_CHECKED', NULL, 'IDLE', NULL, NULL, 0, 0, NULL, NULL, ?, ?)
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
        // Preserve existing cart_availability and notification metadata on technical check error
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

        if (newAvailability === "AVAILABLE" && existing.notificationState === "IDLE") {
          // Restock transition: Start a new notification cycle, reset retries
          const stmt = this.db.prepare(`
            UPDATE products
            SET
              cart_availability = ?,
              last_check_status = 'SUCCESS',
              last_error_message = NULL,
              notification_state = 'PENDING',
              notification_cycle = notification_cycle + 1,
              retry_count = 0,
              next_retry_at = NULL,
              last_delivery_error = NULL,
              last_checked_at = ?,
              updated_at = ?
            WHERE id = ?
          `);
          stmt.run(newAvailability, checkedAt, now, id);
        } else if (newAvailability === "OUT_OF_STOCK") {
          // Out of stock transition: Reset notification state to IDLE and clear retries
          const stmt = this.db.prepare(`
            UPDATE products
            SET
              cart_availability = ?,
              last_check_status = 'SUCCESS',
              last_error_message = NULL,
              notification_state = 'IDLE',
              retry_count = 0,
              next_retry_at = NULL,
              last_delivery_error = NULL,
              last_checked_at = ?,
              updated_at = ?
            WHERE id = ?
          `);
          stmt.run(newAvailability, checkedAt, now, id);
        } else {
          // Other SUCCESS states (e.g., remaining AVAILABLE when already PENDING or DELIVERED)
          // Preserves notification_cycle, retry_count, next_retry_at, and last_delivery_error
          const stmt = this.db.prepare(`
            UPDATE products
            SET
              cart_availability = ?,
              last_check_status = 'SUCCESS',
              last_error_message = NULL,
              last_checked_at = ?,
              updated_at = ?
            WHERE id = ?
          `);
          stmt.run(newAvailability, checkedAt, now, id);
        }
      }
    } catch (error) {
      throw new DatabaseError(`Failed to update check result for product ${id}`, error);
    }
  }

  /**
   * Retrieves all candidate products awaiting notification dispatch.
   * Matches active products with PENDING alerts, confirmed cart availability,
   * retry count strictly under 5, and eligible retry timestamp.
   */
  findPendingNotifications(now?: string): Product[] {
    const currentIso = now || new Date().toISOString();
    try {
      const stmt = this.db.prepare(`
        SELECT * FROM products
        WHERE is_active = 1
          AND notification_state = 'PENDING'
          AND cart_availability = 'AVAILABLE'
          AND retry_count < 5
          AND (next_retry_at IS NULL OR next_retry_at <= ?)
        ORDER BY id ASC
      `);
      const rows = stmt.all(currentIso) as ProductRow[];
      return rows.map(mapRowToProduct);
    } catch (error) {
      throw new DatabaseError("Failed to fetch pending notifications for dispatch", error);
    }
  }

  /**
   * Atomically transitions notification_state from PENDING to DELIVERED using CAS.
   * Guards against race conditions by checking expected notification cycle, active status,
   * and cart availability. Returns true if exactly 1 row was updated.
   */
  markNotificationDelivered(
    id: number,
    expectedCycle: number,
    sentAt?: string
  ): boolean {
    try {
      const now = new Date().toISOString();
      const alertTime = sentAt || now;
      const stmt = this.db.prepare(`
        UPDATE products
        SET
          notification_state = 'DELIVERED',
          last_alert_sent_at = ?,
          next_retry_at = NULL,
          last_delivery_error = NULL,
          updated_at = ?
        WHERE id = ?
          AND notification_cycle = ?
          AND notification_state = 'PENDING'
          AND is_active = 1
          AND cart_availability = 'AVAILABLE'
      `);
      const result = stmt.run(alertTime, now, id, expectedCycle);
      return result.changes === 1;
    } catch (error) {
      throw new DatabaseError(`Failed to mark notification delivered for product ${id}`, error);
    }
  }

  /**
   * Atomically records a delivery failure using CAS.
   * Increments retry count in SQLite, applies authoritative backoff schedule,
   * caps maximum retries at 5 (immediate suspension), and guards against stale cycles.
   * Returns true if exactly 1 row was updated.
   */
  recordNotificationFailure(
    id: number,
    expectedCycle: number,
    details: NotificationFailureDetails
  ): boolean {
    try {
      const now = new Date();
      const nowIso = now.toISOString();
      const nowMs = now.getTime();

      // Precalculate canonical UTC ISO timestamps with ms and Z for backoff delays
      const retry1 = new Date(nowMs + 30 * 1000).toISOString();
      const retry2 = new Date(nowMs + 60 * 1000).toISOString();
      const retry3 = new Date(nowMs + 120 * 1000).toISOString();
      const retry4 = new Date(nowMs + 240 * 1000).toISOString();

      const isPermanent = details.isPermanent ? 1 : 0;
      const errorMessage = details.error.slice(0, 500);

      const stmt = this.db.prepare(`
        UPDATE products
        SET
          retry_count = CASE
            WHEN :isPermanent = 1 THEN 5
            WHEN retry_count + 1 >= 5 THEN 5
            ELSE retry_count + 1
          END,
          next_retry_at = CASE
            WHEN :isPermanent = 1 THEN NULL
            WHEN retry_count + 1 >= 5 THEN NULL
            WHEN retry_count = 0 THEN :retry1
            WHEN retry_count = 1 THEN :retry2
            WHEN retry_count = 2 THEN :retry3
            WHEN retry_count = 3 THEN :retry4
            ELSE NULL
          END,
          last_delivery_error = :errorMessage,
          updated_at = :now
        WHERE id = :id
          AND notification_cycle = :expectedCycle
          AND notification_state = 'PENDING'
          AND is_active = 1
          AND cart_availability = 'AVAILABLE'
          AND retry_count < 5
      `);

      const result = stmt.run({
        id,
        expectedCycle,
        isPermanent,
        retry1,
        retry2,
        retry3,
        retry4,
        errorMessage,
        now: nowIso,
      });

      return result.changes === 1;
    } catch (error) {
      throw new DatabaseError(`Failed to record notification failure for product ${id}`, error);
    }
  }

  /**
   * Retrieves active cooldown timestamp for the given chat_id if cooldown_until > now.
   * Returns cooldown ISO string or null if inactive/expired.
   */
  getChatCooldown(chatId: string, now?: string): string | null {
    const currentIso = now || new Date().toISOString();
    try {
      const stmt = this.db.prepare(`
        SELECT cooldown_until FROM chat_cooldowns
        WHERE chat_id = ? AND cooldown_until > ?
      `);
      const row = stmt.get(chatId, currentIso) as { cooldown_until: string } | undefined;
      return row ? row.cooldown_until : null;
    } catch (error) {
      throw new DatabaseError(`Failed to fetch chat cooldown for chat ${chatId}`, error);
    }
  }

  /**
   * Records or extends a cooldown timestamp for a Telegram chat.
   * Guarantees that an existing cooldown is never shortened.
   */
  setChatCooldown(chatId: string, retryAfterSeconds: number): void {
    const safeSeconds = Math.max(1, Math.floor(retryAfterSeconds));
    const now = new Date();
    const cooldownUntil = new Date(now.getTime() + safeSeconds * 1000).toISOString();
    const nowIso = now.toISOString();

    try {
      const stmt = this.db.prepare(`
        INSERT INTO chat_cooldowns (chat_id, cooldown_until, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(chat_id) DO UPDATE SET
          cooldown_until = CASE
            WHEN excluded.cooldown_until > chat_cooldowns.cooldown_until THEN excluded.cooldown_until
            ELSE chat_cooldowns.cooldown_until
          END,
          updated_at = excluded.updated_at
      `);
      stmt.run(chatId, cooldownUntil, nowIso);
    } catch (error) {
      throw new DatabaseError(`Failed to set chat cooldown for chat ${chatId}`, error);
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
