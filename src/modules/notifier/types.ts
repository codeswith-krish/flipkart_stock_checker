import type { Product, NotificationPayload } from "../../types/index.js";

export type TelegramDeliveryStatus =
  | "SUCCESS"
  | "RATE_LIMIT"
  | "TEMPORARY_FAILURE"
  | "PERMANENT_FAILURE"
  | "UNKNOWN_DELIVERY";

export interface TelegramSendSuccessResult {
  status: "SUCCESS";
  messageId: number;
  description?: string;
}

export interface TelegramRateLimitResult {
  status: "RATE_LIMIT";
  retryAfterSeconds: number;
  error: string;
  description?: string;
}

export interface TelegramTemporaryFailureResult {
  status: "TEMPORARY_FAILURE";
  error: string;
  errorCode?: number;
  description?: string;
}

export interface TelegramPermanentFailureResult {
  status: "PERMANENT_FAILURE";
  error: string;
  errorCode?: number;
  description?: string;
}

export interface TelegramUnknownDeliveryResult {
  status: "UNKNOWN_DELIVERY";
  error: string;
  errorCode?: number;
  description?: string;
}

export type TelegramSendResult =
  | TelegramSendSuccessResult
  | TelegramRateLimitResult
  | TelegramTemporaryFailureResult
  | TelegramPermanentFailureResult
  | TelegramUnknownDeliveryResult;

export interface INotifier {
  sendNotification(payload: NotificationPayload): Promise<boolean>;
  sendRawMessage(text: string): Promise<boolean>;
  sendMessageWithResult(text: string): Promise<TelegramSendResult>;
}
