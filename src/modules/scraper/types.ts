import type { CartAvailability, CheckStatus } from "../../types/index.js";

/**
 * Valid success reasons when cart availability is strictly AVAILABLE.
 */
export type AvailableSuccessReason =
  | "VERIFIED_NEW_ADD_TO_CART"
  | "ALREADY_IN_CART";

/**
 * Valid success reasons when cart availability is strictly OUT_OF_STOCK.
 */
export type OutOfStockSuccessReason =
  | "EXPLICIT_OUT_OF_STOCK_BANNER"
  | "BUTTON_DISABLED_WITH_OOS_EVIDENCE"
  | "CART_ITEM_MARKED_OOS";

export type CartCheckSuccessReason = AvailableSuccessReason | OutOfStockSuccessReason;

/**
 * Specific error reasons for technical or unverified check failures.
 * Technical errors always result in cartAvailability = UNKNOWN.
 */
export type CartCheckErrorReason =
  | "LOGIN_REQUIRED"
  | "CAPTCHA_DETECTED"
  | "DELIVERY_RESTRICTION_OR_PINCODE_REQUIRED"
  | "NAVIGATION_TIMEOUT"
  | "NETWORK_ERROR"
  | "MISSING_ADD_TO_CART_BUTTON"
  | "BUTTON_DISABLED_WITHOUT_OOS_EVIDENCE"
  | "AMBIGUOUS_ACTION_BUTTON"
  | "AMBIGUOUS_PRODUCT_IDENTITY"
  | "UNEXPECTED_PAGE_LAYOUT"
  | "TARGET_ITEM_NOT_FOUND_IN_CART"
  | "CART_VERIFICATION_FAILED"
  | "BROWSER_ERROR";

export interface CartVerificationEvidence {
  buttonFound: boolean;
  buttonText: string | null;
  buttonState: "ENABLED" | "DISABLED" | "AMBIGUOUS" | "NOT_FOUND";
  cartNavigated: boolean;
  cartUrl: string | null;
  matchedBy: "PRODUCT_ID" | "EXACT_TITLE_FALLBACK" | "NONE";
  matchedItemTitle: string | null;
  matchedItemId: string | null;
  staleCartDetected: boolean;
  preExistingCartCheckPerformed: boolean;
  rawError?: string | null;
}

/**
 * Success outcome when cart availability is proven AVAILABLE.
 */
export interface CartCheckAvailableResult {
  checkStatus: "SUCCESS";
  cartAvailability: "AVAILABLE";
  url: string;
  productId: string | null;
  productTitle: string | null;
  reason: AvailableSuccessReason;
  evidence: CartVerificationEvidence;
  checkedAt: string;
}

/**
 * Success outcome when cart availability is proven OUT_OF_STOCK with explicit evidence.
 */
export interface CartCheckOutOfStockResult {
  checkStatus: "SUCCESS";
  cartAvailability: "OUT_OF_STOCK";
  url: string;
  productId: string | null;
  productTitle: string | null;
  reason: OutOfStockSuccessReason;
  evidence: CartVerificationEvidence;
  checkedAt: string;
}

/**
 * Technical or ambiguous error outcome where cartAvailability is strictly UNKNOWN.
 */
export interface CartCheckErrorResult {
  checkStatus: "ERROR";
  cartAvailability: "UNKNOWN";
  url: string;
  productId: string | null;
  productTitle: string | null;
  errorReason: CartCheckErrorReason;
  errorMessage: string;
  evidence: CartVerificationEvidence;
  checkedAt: string;
}

/**
 * Discriminated union for cart check results preventing contradictory field combinations.
 */
export type CartCheckResult =
  | CartCheckAvailableResult
  | CartCheckOutOfStockResult
  | CartCheckErrorResult;

export interface ScrapedProductData {
  url: string;
  title: string | null;
  price: number | null;
  inStock: boolean;
  rawPriceText?: string | null;
  error?: string;
}

export interface IScraper {
  scrapeProduct(url: string): Promise<ScrapedProductData>;
  checkCartAvailability(url: string, expectedProductId?: string | null): Promise<CartCheckResult>;
  close(): Promise<void>;
}
