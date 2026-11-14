import { config } from "../../config/index.js";
import { logger } from "../../shared/logger.js";
import type { INotifier } from "./types.js";
import type { NotificationPayload } from "../../types/index.js";
import { formatNotification } from "./templates.js";
import { NotificationError } from "../../shared/errors.js";

export class TelegramNotifier implements INotifier {
  private botToken: string;
  private chatId: string;

  constructor(botToken?: string, chatId?: string) {
    this.botToken = botToken || config.TELEGRAM_BOT_TOKEN;
    this.chatId = chatId || config.TELEGRAM_CHAT_ID;
  }

  async sendRawMessage(text: string): Promise<boolean> {
    if (!this.botToken || this.botToken === "dummy_token") {
      logger.warn("Telegram bot token not configured. Skipping notification.");
      return false;
    }

    const apiUrl = `https://api.telegram.org/bot${this.botToken}/sendMessage`;

    try {
      const response = await fetch(apiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: this.chatId,
          text,
          parse_mode: "HTML",
          disable_web_page_preview: false,
        }),
      });

      if (!response.ok) {
        const errorBody = await response.text();
        throw new NotificationError(
          `Telegram API error: HTTP ${response.status} - ${errorBody}`
        );
      }

      logger.info("Telegram notification sent successfully.");
      return true;
    } catch (error) {
      logger.error("Failed to send Telegram notification", error);
      return false;
    }
  }

  async sendNotification(payload: NotificationPayload): Promise<boolean> {
    const formattedMessage = formatNotification(payload);
    return this.sendRawMessage(formattedMessage);
  }
}

export const telegramNotifier = new TelegramNotifier();
