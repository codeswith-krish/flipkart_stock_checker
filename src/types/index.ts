export interface Product {
  id: number;
  url: string;
  title: string;
  targetPrice: number;
  currentPrice: number | null;
  inStock: boolean;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface NewProductInput {
  url: string;
  targetPrice: number;
  title?: string;
}

export interface PriceHistory {
  id: number;
  productId: number;
  price: number | null;
  inStock: boolean;
  errorMessage: string | null;
  checkedAt: string;
}

export type NotificationType = "PRICE_DROP" | "BACK_IN_STOCK" | "INFO";

export interface NotificationPayload {
  type: NotificationType;
  product: Product;
  previousPrice?: number | null;
  currentPrice?: number | null;
  message?: string;
}

export interface CheckResult {
  productId: number;
  url: string;
  previousPrice: number | null;
  currentPrice: number | null;
  previousInStock: boolean;
  currentInStock: boolean;
  alertTriggered: boolean;
  error?: string;
}
