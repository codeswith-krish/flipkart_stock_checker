export type CartAvailability = "UNKNOWN" | "AVAILABLE" | "OUT_OF_STOCK";
export type CheckStatus = "NEVER_CHECKED" | "SUCCESS" | "ERROR";
export type NotificationState = "IDLE" | "PENDING" | "DELIVERED";

export interface Product {
  id: number;
  url: string;
  productId: string | null;
  title: string;
  isActive: boolean;
  cartAvailability: CartAvailability;
  lastCheckStatus: CheckStatus;
  lastErrorMessage: string | null;
  notificationState: NotificationState;
  lastAlertSentAt: string | null;
  lastCheckedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface NewProductInput {
  url: string;
  title?: string;
}

export interface UpdateCheckResultInput {
  cartAvailability?: CartAvailability;
  checkStatus: CheckStatus;
  errorMessage?: string | null;
  checkedAt?: string;
}

export interface UpdateNotificationStateInput {
  state: NotificationState;
  alertSentAt?: string | null;
}

export type NotificationType = "CART_SUCCESS" | "INFO";

export interface NotificationPayload {
  type: NotificationType;
  product: Product;
  message?: string;
}

export interface CheckResult {
  productId: number;
  url: string;
  cartAvailability?: CartAvailability;
  checkStatus: CheckStatus;
  alertTriggered: boolean;
  error?: string;
}
