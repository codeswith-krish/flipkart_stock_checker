import { describe, it, expect } from "vitest";
import {
  parseCurrency,
  sanitizeFlipkartUrl,
  isValidFlipkartUrl,
  formatINR,
} from "../../src/shared/utils.js";

describe("Utils - parseCurrency", () => {
  it("should parse standard Indian Rupee formats", () => {
    expect(parseCurrency("₹1,499")).toBe(1499);
    expect(parseCurrency("₹ 24,999")).toBe(24999);
    expect(parseCurrency("Rs. 500")).toBe(500);
    expect(parseCurrency("12,345.00")).toBe(12345);
  });

  it("should return null for invalid or empty strings", () => {
    expect(parseCurrency(null)).toBeNull();
    expect(parseCurrency("")).toBeNull();
    expect(parseCurrency("Out of stock")).toBeNull();
  });
});

describe("Utils - isValidFlipkartUrl", () => {
  it("should identify valid Flipkart URLs", () => {
    expect(isValidFlipkartUrl("https://www.flipkart.com/apple-iphone-15/p/itm1234")).toBe(true);
    expect(isValidFlipkartUrl("https://dl.flipkart.com/s/xyz123")).toBe(true);
  });

  it("should reject non-Flipkart or malformed URLs", () => {
    expect(isValidFlipkartUrl("https://www.amazon.in/dp/B08L5WH74G")).toBe(false);
    expect(isValidFlipkartUrl("not-a-url")).toBe(false);
  });
});

describe("Utils - sanitizeFlipkartUrl", () => {
  it("should remove tracking click query parameters", () => {
    const raw = "https://www.flipkart.com/apple-iphone-15/p/itm1234?pid=MOB123&marketplace=FLIPKART&lid=LST123&spotlight=true&semcmpid=adwords";
    const cleaned = sanitizeFlipkartUrl(raw);
    const parsed = new URL(cleaned);

    expect(parsed.searchParams.get("pid")).toBe("MOB123");
    expect(parsed.searchParams.get("marketplace")).toBe("FLIPKART");
    expect(parsed.searchParams.get("spotlight")).toBeNull();
    expect(parsed.searchParams.get("semcmpid")).toBeNull();
  });
});

describe("Utils - formatINR", () => {
  it("should format number as INR string", () => {
    const formatted = formatINR(1499);
    expect(formatted).toContain("1,499");
    expect(formatINR(null)).toBe("N/A");
  });
});
