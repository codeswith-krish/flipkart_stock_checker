import type { NotificationPayload } from "../../types/index.js";
import { formatINR } from "../../shared/utils.js";

export function formatNotification(payload: NotificationPayload): string {
  const { type, product, previousPrice, currentPrice } = payload;
  const title = product.title || "Product";
  const url = product.url;

  switch (type) {
    case "PRICE_DROP": {
      const dropAmount =
        previousPrice && currentPrice ? previousPrice - currentPrice : null;
      const dropText = dropAmount ? ` (Down by ${formatINR(dropAmount)})` : "";

      return (
        `🔥 <b>PRICE DROP ALERT!</b>\n\n` +
        `📦 <b>Product:</b> ${escapeHtml(title)}\n` +
        `💰 <b>New Price:</b> ${formatINR(currentPrice)}${dropText}\n` +
        `🎯 <b>Target Price:</b> ${formatINR(product.targetPrice)}\n\n` +
        `🔗 <a href="${url}">Buy on Flipkart</a>`
      );
    }

    case "BACK_IN_STOCK": {
      return (
        `🎉 <b>BACK IN STOCK!</b>\n\n` +
        `📦 <b>Product:</b> ${escapeHtml(title)}\n` +
        `💰 <b>Current Price:</b> ${formatINR(currentPrice)}\n` +
        `🎯 <b>Target Price:</b> ${formatINR(product.targetPrice)}\n\n` +
        `🔗 <a href="${url}">Buy on Flipkart</a>`
      );
    }

    case "INFO":
    default: {
      return (
        `ℹ️ <b>Stock Checker Notification</b>\n\n` +
        `📦 <b>Product:</b> ${escapeHtml(title)}\n` +
        `💬 ${escapeHtml(payload.message || "Status update")}\n\n` +
        `🔗 <a href="${url}">View Product</a>`
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
