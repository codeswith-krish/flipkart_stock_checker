import type { INotifier } from "../../src/modules/notifier/types.js";
import type { NotificationPayload } from "../../src/types/index.js";

export class MockNotifier implements INotifier {
  public sentNotifications: NotificationPayload[] = [];
  public sentMessages: string[] = [];

  async sendNotification(payload: NotificationPayload): Promise<boolean> {
    this.sentNotifications.push(payload);
    return true;
  }

  async sendRawMessage(text: string): Promise<boolean> {
    this.sentMessages.push(text);
    return true;
  }

  clear(): void {
    this.sentNotifications = [];
    this.sentMessages = [];
  }
}
