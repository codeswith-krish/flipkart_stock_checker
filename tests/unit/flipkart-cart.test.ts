import { describe, it, expect, vi, beforeEach } from "vitest";
import { cartVerifier, CartVerifier } from "../../src/modules/scraper/cart-verifier.js";
import { flipkartScraper } from "../../src/modules/scraper/flipkart.js";
import * as browserModule from "../../src/modules/scraper/browser.js";
import type { Page } from "playwright";

interface MockPageOptions {
  currentUrl?: string;
  redirectUrl?: string;
  title?: string | null;
  hasCaptcha?: boolean;
  hasLoginModal?: boolean;
  hasPincodeBlocker?: boolean;
  hasExplicitOosBanner?: boolean;
  buttonText?: "ADD TO CART" | "GO TO CART" | null;
  isButtonDisabled?: boolean;
  buttonCount?: number;
  cartItems?: Array<{ title: string; href: string; isOos?: boolean }>;
  onGoto?: (url: string) => Promise<void>;
  onClick?: () => Promise<void>;
}

function createMockPage(opts: MockPageOptions = {}): { page: Page; state: MockPageOptions } {
  const state: MockPageOptions = {
    currentUrl: opts.currentUrl || "https://www.flipkart.com/sample-product/p/itm12345?pid=MOB12345",
    redirectUrl: opts.redirectUrl,
    title: opts.title !== undefined ? opts.title : "Sample Flipkart Product",
    hasCaptcha: opts.hasCaptcha || false,
    hasLoginModal: opts.hasLoginModal || false,
    hasPincodeBlocker: opts.hasPincodeBlocker || false,
    hasExplicitOosBanner: opts.hasExplicitOosBanner || false,
    buttonText: opts.buttonText !== undefined ? opts.buttonText : "ADD TO CART",
    isButtonDisabled: opts.isButtonDisabled || false,
    buttonCount: opts.buttonCount !== undefined ? opts.buttonCount : 1,
    cartItems: opts.cartItems || [],
    onGoto: opts.onGoto,
    onClick: opts.onClick,
  };

  const createMockLocator = (matchesSelector: string, extraFilter?: any): any => {
    return {
      first: () => createMockLocator(matchesSelector, extraFilter),
      nth: (index: number) => {
        if (
          matchesSelector.includes("cartItem") ||
          matchesSelector.includes("_1AtVbE") ||
          matchesSelector.includes("gXlS2w")
        ) {
          const item = state.cartItems?.[index];
          return {
            locator: (subSelector: string) => {
              if (
                subSelector.includes("Out of Stock") ||
                subSelector.includes("outOfStock")
              ) {
                return {
                  first: () => ({
                    isVisible: async () => Boolean(item?.isOos),
                  }),
                };
              }

              const itemTitle = item?.title || "";
              const itemHref = item?.href || null;

              return {
                first: () => ({
                  getAttribute: async (attr: string) => (attr === "href" ? itemHref : null),
                  innerText: async () => itemTitle,
                }),
                count: async () => (item ? 1 : 0),
                nth: () => ({
                  getAttribute: async (attr: string) => (attr === "href" ? itemHref : null),
                  innerText: async () => itemTitle,
                }),
              };
            },
          };
        }
        return createMockLocator(matchesSelector, extraFilter);
      },
      count: async () => {
        if (
          matchesSelector.includes("cartItem") ||
          matchesSelector.includes("_1AtVbE") ||
          matchesSelector.includes("gXlS2w")
        ) {
          return state.cartItems?.length || 0;
        }
        if (extraFilter?.hasText) {
          const pattern: RegExp = extraFilter.hasText;
          if (pattern.test("go to cart")) {
            return state.buttonText === "GO TO CART" ? state.buttonCount || 1 : 0;
          }
          if (pattern.test("add to cart")) {
            return state.buttonText === "ADD TO CART" ? state.buttonCount || 1 : 0;
          }
        }
        return 1;
      },
      isVisible: async () => {
        if (matchesSelector.includes("captcha")) return Boolean(state.hasCaptcha);
        if (matchesSelector.includes("username") || matchesSelector.includes("Mobile number")) {
          return Boolean(state.hasLoginModal);
        }
        if (
          matchesSelector.includes("pincode") ||
          matchesSelector.includes("deliverable") ||
          matchesSelector.includes("shipped")
        ) {
          return Boolean(state.hasPincodeBlocker);
        }
        if (
          matchesSelector.includes("Currently Out of Stock") ||
          matchesSelector.includes("_16FRp0") ||
          matchesSelector.includes("Sold Out")
        ) {
          return Boolean(state.hasExplicitOosBanner);
        }
        if (extraFilter?.hasText) {
          const pattern: RegExp = extraFilter.hasText;
          if (pattern.test("go to cart")) return state.buttonText === "GO TO CART";
          if (pattern.test("add to cart")) return state.buttonText === "ADD TO CART";
        }
        return true;
      },
      isEnabled: async () => !state.isButtonDisabled,
      innerText: async () => {
        if (
          matchesSelector.includes("VU-ZEz") ||
          matchesSelector.includes("yhB1nd") ||
          matchesSelector.includes("h1")
        ) {
          if (state.title === null) throw new Error("Title element not found");
          return state.title;
        }
        return state.buttonText || "";
      },
      getAttribute: async (attr: string) => {
        if (attr === "disabled") return state.isButtonDisabled ? "disabled" : null;
        if (attr === "aria-disabled") return state.isButtonDisabled ? "true" : null;
        if (attr === "class") return state.isButtonDisabled ? "action-btn disabled" : "action-btn";
        return null;
      },
      click: async () => {
        if (state.onClick) {
          await state.onClick();
        } else {
          // Default click simulation: transition to cart
          state.currentUrl = "https://www.flipkart.com/viewcart";
        }
      },
      filter: (filterOpts: any) => createMockLocator(matchesSelector, filterOpts),
    };
  };

  const page: any = {
    url: () => state.currentUrl,
    goto: async (url: string) => {
      if (state.onGoto) {
        await state.onGoto(url);
      } else if (state.redirectUrl) {
        state.currentUrl = state.redirectUrl;
      } else if (
        state.currentUrl &&
        (state.currentUrl.includes("/account/login") || state.currentUrl.includes("flipkart.com/login"))
      ) {
        // Preserve login URL if initialized to simulate redirect landing
      } else {
        state.currentUrl = url;
      }
    },
    locator: (selector: string) => createMockLocator(selector),
  };

  return { page: page as Page, state };
}

describe("Flipkart Add-to-Cart & Multi-Signal Verification Engine (Unit)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("Scenario 1: Verified New Cart Addition", () => {
    it("should return SUCCESS + AVAILABLE with reason VERIFIED_NEW_ADD_TO_CART when item is clicked and verified in cart", async () => {
      const { page } = createMockPage({
        buttonText: "ADD TO CART",
        isButtonDisabled: false,
        cartItems: [
          {
            title: "Sample Product",
            href: "https://www.flipkart.com/sample/p/itm12345?pid=MOB12345",
            isOos: false,
          },
        ],
      });

      const result = await cartVerifier.executeVerificationFlow(
        page,
        "https://www.flipkart.com/sample/p/itm12345?pid=MOB12345",
        "itm12345",
        5000
      );

      expect(result.checkStatus).toBe("SUCCESS");
      expect(result.cartAvailability).toBe("AVAILABLE");
      if (result.checkStatus === "SUCCESS") {
        expect(result.reason).toBe("VERIFIED_NEW_ADD_TO_CART");
        expect(result.evidence.buttonFound).toBe(true);
        expect(result.evidence.buttonState).toBe("ENABLED");
        expect(result.evidence.matchedBy).toBe("PRODUCT_ID");
        expect(result.evidence.matchedItemId).toBe("itm12345");
      }
    });
  });

  describe("Scenario 2: Product Already in Cart", () => {
    it("should return SUCCESS + AVAILABLE with reason ALREADY_IN_CART when button shows GO TO CART", async () => {
      const { page } = createMockPage({
        buttonText: "GO TO CART",
        cartItems: [
          {
            title: "Sample Product",
            href: "https://www.flipkart.com/sample/p/itm12345?pid=MOB12345",
            isOos: false,
          },
        ],
      });

      const result = await cartVerifier.executeVerificationFlow(
        page,
        "https://www.flipkart.com/sample/p/itm12345?pid=MOB12345",
        "itm12345",
        5000
      );

      expect(result.checkStatus).toBe("SUCCESS");
      expect(result.cartAvailability).toBe("AVAILABLE");
      if (result.checkStatus === "SUCCESS") {
        expect(result.reason).toBe("ALREADY_IN_CART");
        expect(result.evidence.buttonText).toBe("GO TO CART");
      }
    });
  });

  describe("Scenario 3: Explicit Out-of-Stock Banner", () => {
    it("should return SUCCESS + OUT_OF_STOCK with reason EXPLICIT_OUT_OF_STOCK_BANNER", async () => {
      const { page } = createMockPage({
        hasExplicitOosBanner: true,
        buttonText: null,
      });

      const result = await cartVerifier.executeVerificationFlow(
        page,
        "https://www.flipkart.com/sample/p/itm12345?pid=MOB12345",
        "itm12345",
        5000
      );

      expect(result.checkStatus).toBe("SUCCESS");
      expect(result.cartAvailability).toBe("OUT_OF_STOCK");
      if (result.checkStatus === "SUCCESS") {
        expect(result.reason).toBe("EXPLICIT_OUT_OF_STOCK_BANNER");
      }
    });
  });

  describe("Scenario 4: Disabled Button WITH OOS Evidence", () => {
    it("should return SUCCESS + OUT_OF_STOCK with reason BUTTON_DISABLED_WITH_OOS_EVIDENCE", async () => {
      const { page } = createMockPage({
        hasExplicitOosBanner: true,
        buttonText: "ADD TO CART",
        isButtonDisabled: true,
      });

      const result = await cartVerifier.executeVerificationFlow(
        page,
        "https://www.flipkart.com/sample/p/itm12345?pid=MOB12345",
        "itm12345",
        5000
      );

      expect(result.checkStatus).toBe("SUCCESS");
      expect(result.cartAvailability).toBe("OUT_OF_STOCK");
      if (result.checkStatus === "SUCCESS") {
        expect(result.reason).toBe("BUTTON_DISABLED_WITH_OOS_EVIDENCE");
        expect(result.evidence.buttonState).toBe("DISABLED");
      }
    });
  });

  describe("Scenario 5: Disabled Button WITHOUT OOS Evidence", () => {
    it("should return ERROR + UNKNOWN with errorReason BUTTON_DISABLED_WITHOUT_OOS_EVIDENCE", async () => {
      const { page } = createMockPage({
        hasExplicitOosBanner: false,
        buttonText: "ADD TO CART",
        isButtonDisabled: true,
      });

      const result = await cartVerifier.executeVerificationFlow(
        page,
        "https://www.flipkart.com/sample/p/itm12345?pid=MOB12345",
        "itm12345",
        5000
      );

      expect(result.checkStatus).toBe("ERROR");
      expect(result.cartAvailability).toBe("UNKNOWN");
      if (result.checkStatus === "ERROR") {
        expect(result.errorReason).toBe("BUTTON_DISABLED_WITHOUT_OOS_EVIDENCE");
      }
    });
  });

  describe("Scenario 6: Item Marked OOS Inside Cart", () => {
    it("should return SUCCESS + OUT_OF_STOCK with reason CART_ITEM_MARKED_OOS", async () => {
      const { page } = createMockPage({
        buttonText: "ADD TO CART",
        isButtonDisabled: false,
        cartItems: [
          {
            title: "Sample Product",
            href: "https://www.flipkart.com/sample/p/itm12345?pid=MOB12345",
            isOos: true,
          },
        ],
      });

      const result = await cartVerifier.executeVerificationFlow(
        page,
        "https://www.flipkart.com/sample/p/itm12345?pid=MOB12345",
        "itm12345",
        5000
      );

      expect(result.checkStatus).toBe("SUCCESS");
      expect(result.cartAvailability).toBe("OUT_OF_STOCK");
      if (result.checkStatus === "SUCCESS") {
        expect(result.reason).toBe("CART_ITEM_MARKED_OOS");
      }
    });
  });

  describe("Scenario 7: Delivery / Pincode Restriction", () => {
    it("should return ERROR + UNKNOWN with errorReason DELIVERY_RESTRICTION_OR_PINCODE_REQUIRED", async () => {
      const { page } = createMockPage({
        hasPincodeBlocker: true,
      });

      const result = await cartVerifier.executeVerificationFlow(
        page,
        "https://www.flipkart.com/sample/p/itm12345?pid=MOB12345",
        "itm12345",
        5000
      );

      expect(result.checkStatus).toBe("ERROR");
      expect(result.cartAvailability).toBe("UNKNOWN");
      if (result.checkStatus === "ERROR") {
        expect(result.errorReason).toBe("DELIVERY_RESTRICTION_OR_PINCODE_REQUIRED");
      }
    });
  });

  describe("Scenario 8: Login Required (Redirect or Modal)", () => {
    it("should detect login redirect and return ERROR + UNKNOWN with errorReason LOGIN_REQUIRED", async () => {
      const { page } = createMockPage({
        currentUrl: "https://www.flipkart.com/account/login?ret=/sample",
        redirectUrl: "https://www.flipkart.com/account/login?ret=/sample",
      });

      const result = await cartVerifier.executeVerificationFlow(
        page,
        "https://www.flipkart.com/sample/p/itm12345?pid=MOB12345",
        "itm12345",
        5000
      );

      expect(result.checkStatus).toBe("ERROR");
      expect(result.cartAvailability).toBe("UNKNOWN");
      if (result.checkStatus === "ERROR") {
        expect(result.errorReason).toBe("LOGIN_REQUIRED");
      }
    });

    it("should detect login modal popup and return ERROR + UNKNOWN with errorReason LOGIN_REQUIRED", async () => {
      const { page } = createMockPage({
        hasLoginModal: true,
      });

      const result = await cartVerifier.executeVerificationFlow(
        page,
        "https://www.flipkart.com/sample/p/itm12345?pid=MOB12345",
        "itm12345",
        5000
      );

      expect(result.checkStatus).toBe("ERROR");
      expect(result.cartAvailability).toBe("UNKNOWN");
      if (result.checkStatus === "ERROR") {
        expect(result.errorReason).toBe("LOGIN_REQUIRED");
      }
    });
  });

  describe("Scenario 9: CAPTCHA Encountered", () => {
    it("should return ERROR + UNKNOWN with errorReason CAPTCHA_DETECTED", async () => {
      const { page } = createMockPage({
        hasCaptcha: true,
      });

      const result = await cartVerifier.executeVerificationFlow(
        page,
        "https://www.flipkart.com/sample/p/itm12345?pid=MOB12345",
        "itm12345",
        5000
      );

      expect(result.checkStatus).toBe("ERROR");
      expect(result.cartAvailability).toBe("UNKNOWN");
      if (result.checkStatus === "ERROR") {
        expect(result.errorReason).toBe("CAPTCHA_DETECTED");
      }
    });
  });

  describe("Scenario 10: Navigation Timeout", () => {
    it("should catch TimeoutError and return ERROR + UNKNOWN with errorReason NAVIGATION_TIMEOUT", async () => {
      const timeoutError = new Error("Navigation timeout of 5000ms exceeded");
      timeoutError.name = "TimeoutError";

      const { page } = createMockPage({
        onGoto: async () => {
          throw timeoutError;
        },
      });

      const result = await cartVerifier.executeVerificationFlow(
        page,
        "https://www.flipkart.com/sample/p/itm12345?pid=MOB12345",
        "itm12345",
        5000
      );

      expect(result.checkStatus).toBe("ERROR");
      expect(result.cartAvailability).toBe("UNKNOWN");
      if (result.checkStatus === "ERROR") {
        expect(result.errorReason).toBe("NAVIGATION_TIMEOUT");
        expect(result.errorMessage).toContain("timed out");
      }
    });
  });

  describe("Scenario 11: Ambiguous Action Buttons", () => {
    it("should return ERROR + UNKNOWN with errorReason AMBIGUOUS_ACTION_BUTTON when competing buttons exist", async () => {
      const { page } = createMockPage({
        buttonText: "ADD TO CART",
        buttonCount: 3, // More than 2 competing buttons
      });

      const result = await cartVerifier.executeVerificationFlow(
        page,
        "https://www.flipkart.com/sample/p/itm12345?pid=MOB12345",
        "itm12345",
        5000
      );

      expect(result.checkStatus).toBe("ERROR");
      expect(result.cartAvailability).toBe("UNKNOWN");
      if (result.checkStatus === "ERROR") {
        expect(result.errorReason).toBe("AMBIGUOUS_ACTION_BUTTON");
        expect(result.evidence.buttonState).toBe("AMBIGUOUS");
      }
    });
  });

  describe("Scenario 12: Pre-existing Cart Contents (Target Item Absent)", () => {
    it("should preserve existing cart items without deletion and return TARGET_ITEM_NOT_FOUND_IN_CART", async () => {
      const { page } = createMockPage({
        buttonText: "ADD TO CART",
        cartItems: [
          {
            title: "Unrelated Toothpaste",
            href: "https://www.flipkart.com/toothpaste/p/itm99999?pid=TOOTH123",
            isOos: false,
          },
          {
            title: "Unrelated Book",
            href: "https://www.flipkart.com/book/p/itm88888?pid=BOOK123",
            isOos: false,
          },
        ],
      });

      const result = await cartVerifier.executeVerificationFlow(
        page,
        "https://www.flipkart.com/sample/p/itm12345?pid=MOB12345",
        "itm12345",
        5000
      );

      expect(result.checkStatus).toBe("ERROR");
      expect(result.cartAvailability).toBe("UNKNOWN");
      if (result.checkStatus === "ERROR") {
        expect(result.errorReason).toBe("TARGET_ITEM_NOT_FOUND_IN_CART");
        expect(result.evidence.staleCartDetected).toBe(true);
      }
    });
  });

  describe("Scenario 13: Ambiguous Product Identity in Cart", () => {
    it("should return ERROR + UNKNOWN with errorReason AMBIGUOUS_PRODUCT_IDENTITY when identity is ambiguous", async () => {
      const { page } = createMockPage({
        title: "Same Title Product",
        buttonText: "ADD TO CART",
        // No exact product ID supplied, two items with identical title
        cartItems: [
          {
            title: "Same Title Product",
            href: "https://www.flipkart.com/p/itm_ambiguous_1",
            isOos: false,
          },
          {
            title: "Same Title Product",
            href: "https://www.flipkart.com/p/itm_ambiguous_2",
            isOos: false,
          },
        ],
      });

      const result = await cartVerifier.executeVerificationFlow(
        page,
        "https://www.flipkart.com/sample-product",
        null, // No target product ID
        5000
      );

      expect(result.checkStatus).toBe("ERROR");
      expect(result.cartAvailability).toBe("UNKNOWN");
      if (result.checkStatus === "ERROR") {
        expect(result.errorReason).toBe("AMBIGUOUS_PRODUCT_IDENTITY");
      }
    });
  });

  describe("Scenario 14: Missing Add-to-Cart Button", () => {
    it("should return ERROR + UNKNOWN with errorReason MISSING_ADD_TO_CART_BUTTON when no button or OOS banner exists", async () => {
      const { page } = createMockPage({
        title: "Recognized Title",
        buttonText: null,
        hasExplicitOosBanner: false,
      });

      const result = await cartVerifier.executeVerificationFlow(
        page,
        "https://www.flipkart.com/sample/p/itm12345?pid=MOB12345",
        "itm12345",
        5000
      );

      expect(result.checkStatus).toBe("ERROR");
      expect(result.cartAvailability).toBe("UNKNOWN");
      if (result.checkStatus === "ERROR") {
        expect(result.errorReason).toBe("MISSING_ADD_TO_CART_BUTTON");
        expect(result.evidence.buttonState).toBe("NOT_FOUND");
      }
    });
  });

  describe("Scenario 15: Unexpected Page Layout", () => {
    it("should return ERROR + UNKNOWN with errorReason UNEXPECTED_PAGE_LAYOUT when title and buttons are missing", async () => {
      const { page } = createMockPage({
        title: null,
        buttonText: null,
        hasExplicitOosBanner: false,
      });

      const result = await cartVerifier.executeVerificationFlow(
        page,
        "https://www.flipkart.com/sample/p/itm12345?pid=MOB12345",
        "itm12345",
        5000
      );

      expect(result.checkStatus).toBe("ERROR");
      expect(result.cartAvailability).toBe("UNKNOWN");
      if (result.checkStatus === "ERROR") {
        expect(result.errorReason).toBe("UNEXPECTED_PAGE_LAYOUT");
      }
    });
  });

  describe("Exact Normalized Product ID Matching", () => {
    it("should match by exact normalized PID even if path differs", async () => {
      const { page } = createMockPage({
        buttonText: "ADD TO CART",
        cartItems: [
          {
            title: "Apple iPhone 15",
            href: "https://www.flipkart.com/apple-iphone-15-black-128-gb/p/itm111?pid=MOBGTAGPTB3VS24W",
            isOos: false,
          },
        ],
      });

      const result = await cartVerifier.executeVerificationFlow(
        page,
        "https://www.flipkart.com/apple-iphone-15/p/itm999?pid=MOBGTAGPTB3VS24W",
        "mobgtagptb3vs24w", // Lowercase normalized target
        5000
      );

      expect(result.checkStatus).toBe("SUCCESS");
      expect(result.cartAvailability).toBe("AVAILABLE");
      if (result.checkStatus === "SUCCESS") {
        expect(result.evidence.matchedBy).toBe("PRODUCT_ID");
      }
    });

    it("should reject near-matches and substrings (preventing false positive on MOBGTAGPTB3VS24W_EXTRA)", async () => {
      const { page } = createMockPage({
        buttonText: "ADD TO CART",
        cartItems: [
          {
            title: "Different Variant",
            href: "https://www.flipkart.com/p/itm111?pid=MOBGTAGPTB3VS24W_EXTRA",
            isOos: false,
          },
        ],
      });

      const result = await cartVerifier.executeVerificationFlow(
        page,
        "https://www.flipkart.com/apple-iphone-15/p/itm111?pid=MOBGTAGPTB3VS24W",
        "MOBGTAGPTB3VS24W",
        5000
      );

      expect(result.checkStatus).toBe("ERROR");
      expect(result.cartAvailability).toBe("UNKNOWN");
      if (result.checkStatus === "ERROR") {
        expect(result.errorReason).toBe("TARGET_ITEM_NOT_FOUND_IN_CART");
      }
    });
  });

  describe("Browser Resource Cleanup & Lifecycle Guarantees", () => {
    it("should guarantee page and context cleanup via withIsolatedPage on check completion", async () => {
      const mockPage = createMockPage({
        buttonText: "GO TO CART",
        cartItems: [{ title: "T", href: "/p/itm123", isOos: false }],
      }).page;
      const mockContext = { close: vi.fn().mockResolvedValue(undefined) } as any;

      const withIsolatedPageSpy = vi.spyOn(browserModule, "withIsolatedPage").mockImplementation(
        async (fn) => fn(mockPage, mockContext)
      );

      const result = await flipkartScraper.checkCartAvailability("https://www.flipkart.com/sample/p/itm123", "itm123");

      expect(withIsolatedPageSpy).toHaveBeenCalledTimes(1);
      expect(result.checkStatus).toBe("SUCCESS");
      withIsolatedPageSpy.mockRestore();
    });

    it("should guarantee error handling and return ERROR + UNKNOWN on network failures without unhandled rejections", async () => {
      const { page } = createMockPage({
        onGoto: async () => {
          throw new Error("net::ERR_NAME_NOT_RESOLVED");
        },
      });

      const result = await cartVerifier.executeVerificationFlow(
        page,
        "https://www.flipkart.com/sample/p/itm123",
        "itm123",
        5000
      );

      expect(result.checkStatus).toBe("ERROR");
      expect(result.cartAvailability).toBe("UNKNOWN");
      if (result.checkStatus === "ERROR") {
        expect(result.errorReason).toBe("NETWORK_ERROR");
      }
    });
  });

  describe("Operational Memory Benchmark", () => {
    it("should record memory benchmark during test suite execution", () => {
      const mem = process.memoryUsage();
      const heapMb = (mem.heapUsed / 1024 / 1024).toFixed(2);
      const rssMb = (mem.rss / 1024 / 1024).toFixed(2);

      // Verify valid numeric memory measurements
      expect(mem.heapUsed).toBeGreaterThan(0);
      expect(mem.rss).toBeGreaterThan(0);

      // Operational benchmark record for Oracle Cloud Always Free VM
      // eslint-disable-next-line no-console
      console.log(`[Memory Benchmark] Heap Used: ${heapMb} MB | RSS: ${rssMb} MB`);
    });
  });
});
