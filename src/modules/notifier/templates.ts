import type { NotificationPayload } from "../../types/index.js";
import { NotificationError } from "../../shared/errors.js";

export function formatNotification(payload: NotificationPayload): string {
  const { type, product } = payload;
  const title = product.title || "Product";
  const url = product.url;

  switch (type) {
    case "CART_SUCCESS": {
      throw new NotificationError(
        "Cart success notification template is not implemented yet (scheduled for Phase 4: Telegram Notifications)"
      );
    }

    case "INFO": {
      return (
        `ℹ️ <b>Stock Checker Notification</b>\n\n` +
        `📦 <b>Product:</b> ${escapeHtml(title)}\n` +
        `💬 ${escapeHtml(payload.message || "Status update")}\n\n` +
        `🔗 <a href="${url}">View Product</a>`
      );
    }

    default: {
      throw new NotificationError(
        `Notification template for type '${String(type)}' is not implemented.`
      );
    }
  }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
