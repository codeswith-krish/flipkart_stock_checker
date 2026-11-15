import type { NotificationPayload, Product } from "../../types/index.js";
import { NotificationError } from "../../shared/errors.js";
import { isValidFlipkartUrl } from "../../shared/utils.js";

/**
 * Escapes dynamic text for safe insertion into Telegram HTML parse mode.
 * Encodes &, <, >, ", and ' to strictly prevent HTML injection breakouts.
 */
export function escapeHtml(text: unknown): string {
  if (text === null || text === undefined) return "";
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Escapes characters that could break out of HTML attribute contexts (e.g. href="...").
 */
export function escapeUrlAttribute(url: unknown): string {
  if (!url) return "";
  return String(url)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Formats a confirmed cart availability notification message using Telegram HTML parse mode.
 * Uses generic "Cart Availability Confirmed" status wording in compliance with Phase 4 architecture.
 * Does not contain any price or price-drop text.
 */
export function formatCartSuccessMessage(product: Product): string {
  const title = escapeHtml(product.title || "Unknown Product");
  const timestamp = escapeHtml(product.lastCheckedAt || new Date().toISOString());
  const rawUrl = product.url || "";
  const isValid = isValidFlipkartUrl(rawUrl);

  const urlDisplay = isValid
    ? `<a href="${escapeUrlAttribute(rawUrl)}">Open on Flipkart</a>`
    : escapeHtml(rawUrl || "N/A");

  return (
    `🚨 <b>Flipkart Stock Alert!</b>\n\n` +
    `<b>Product:</b> ${title}\n` +
    `<b>Cart Availability:</b> AVAILABLE\n` +
    `<b>Status:</b> Cart Availability Confirmed\n` +
    `<b>Verified At:</b> ${timestamp}\n` +
    `<b>Open on Flipkart:</b> ${urlDisplay}`
  );
}

/**
 * Main notification formatting dispatcher.
 */
export function formatNotification(payload: NotificationPayload): string {
  const { type, product } = payload;

  switch (type) {
    case "CART_SUCCESS": {
      return formatCartSuccessMessage(product);
    }

    case "INFO": {
      const title = escapeHtml(product.title || "Product");
      const rawUrl = product.url || "";
      const isValid = isValidFlipkartUrl(rawUrl);
      const urlLink = isValid
        ? `<a href="${escapeUrlAttribute(rawUrl)}">View Product</a>`
        : escapeHtml(rawUrl || "N/A");

      return (
        `ℹ️ <b>Stock Checker Notification</b>\n\n` +
        `<b>Product:</b> ${title}\n` +
        `💬 ${escapeHtml(payload.message || "Status update")}\n\n` +
        `🔗 ${urlLink}`
      );
    }

    default: {
      throw new NotificationError(
        `Notification template for type '${String(type)}' is not implemented.`
      );
    }
  }
}
