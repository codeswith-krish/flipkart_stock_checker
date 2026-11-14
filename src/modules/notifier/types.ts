import type { Product, NotificationPayload } from "../../types/index.js";

export interface INotifier {
  sendNotification(payload: NotificationPayload): Promise<boolean>;
  sendRawMessage(text: string): Promise<boolean>;
}
