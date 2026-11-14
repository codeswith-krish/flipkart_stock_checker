/**
 * Parses raw price string (e.g. "₹1,499", "Rs. 2,999.00", "1499") into a numeric value.
 */
export function parseCurrency(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const cleaned = raw.replace(/[^0-9.]/g, "");
  if (!cleaned) return null;
  const parsed = parseFloat(cleaned);
  return isNaN(parsed) ? null : Math.round(parsed);
}

/**
 * Extracts canonical Flipkart product ID (PID or item ID from pathname).
 */
export function extractFlipkartProductId(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl);
    const pid = url.searchParams.get("pid");
    if (pid && pid.trim().length > 0) {
      return pid.trim();
    }
    const match = url.pathname.match(/\/p\/(itm[a-zA-Z0-9]+)/i);
    if (match && match[1]) {
      return match[1];
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Sanitizes Flipkart URLs by removing tracking and session query parameters.
 */
export function sanitizeFlipkartUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    // Keep essential query params for Flipkart product pages, strip click identifiers
    const paramsToKeep = ["pid", "lid", "marketplace"];
    const newSearchParams = new URLSearchParams();

    paramsToKeep.forEach((param) => {
      const val = url.searchParams.get(param);
      if (val) newSearchParams.set(param, val);
    });

    url.search = newSearchParams.toString();
    url.hash = "";
    return url.toString();
  } catch {
    return rawUrl.trim();
  }
}

/**
 * Validates if the given URL is a valid Flipkart product URL.
 */
export function isValidFlipkartUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    return (
      (url.hostname === "www.flipkart.com" || url.hostname === "flipkart.com" || url.hostname === "dl.flipkart.com") &&
      url.pathname.length > 1
    );
  } catch {
    return false;
  }
}

/**
 * Formats a numeric price into INR currency string.
 */
export function formatINR(price: number | null | undefined): string {
  if (price === null || price === undefined) return "N/A";
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0,
  }).format(price);
}

/**
 * Async delay helper.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
