import type { Page, Locator } from "playwright";
import type {
  CartCheckResult,
  CartCheckAvailableResult,
  CartCheckOutOfStockResult,
  CartCheckErrorResult,
  CartVerificationEvidence,
} from "./types.js";
import { extractFlipkartProductId } from "../../shared/utils.js";
import { logger } from "../../shared/logger.js";

export interface BlockerCheckResult {
  isBlocked: boolean;
  reason?:
    | "CAPTCHA_DETECTED"
    | "LOGIN_REQUIRED"
    | "DELIVERY_RESTRICTION_OR_PINCODE_REQUIRED";
  message?: string;
}

export interface ActionButtonDetection {
  found: boolean;
  isAddCart: boolean;
  isGoToCart: boolean;
  isDisabled: boolean;
  isAmbiguous: boolean;
  buttonText: string | null;
  locator: Locator | null;
}

export interface CartItemsInspectionResult {
  foundTarget: boolean;
  isOosInCart: boolean;
  isAmbiguousIdentity: boolean;
  totalItems: number;
  matchedBy: "PRODUCT_ID" | "EXACT_TITLE_FALLBACK" | "NONE";
  matchedItemTitle: string | null;
  matchedItemId: string | null;
  staleCartDetected: boolean;
}

export class CartVerifier {
  /**
   * Detects interactive blockers: CAPTCHA challenges, login walls, and delivery/pincode restrictions.
   */
  async detectBlockers(page: Page): Promise<BlockerCheckResult> {
    const currentUrl = page.url();

    // 1. Login redirect detection
    if (
      currentUrl.includes("/account/login") ||
      currentUrl.includes("flipkart.com/login")
    ) {
      return {
        isBlocked: true,
        reason: "LOGIN_REQUIRED",
        message: "Redirected to Flipkart account login page",
      };
    }

    // 2. CAPTCHA detection
    const captchaLocator = page.locator(
      'iframe[src*="captcha"], div[class*="captcha"], div[id*="captcha"], :text("Please enter the characters you see below")'
    );
    const hasCaptcha = await captchaLocator
      .first()
      .isVisible()
      .catch(() => false);

    if (hasCaptcha) {
      return {
        isBlocked: true,
        reason: "CAPTCHA_DETECTED",
        message: "CAPTCHA challenge detected on page",
      };
    }

    // 3. Login modal / popup detection
    const loginModalLocator = page.locator(
      'input[autocomplete="username"], input[type="tel"], :text("Please enter your Mobile number"), :text("LOGIN TO CONTINUE")'
    );
    const hasLoginModal = await loginModalLocator
      .first()
      .isVisible()
      .catch(() => false);

    if (hasLoginModal) {
      return {
        isBlocked: true,
        reason: "LOGIN_REQUIRED",
        message: "Login modal intercepted user interaction",
      };
    }

    // 4. Delivery / Pincode restriction detection
    const pincodeBlockerLocator = page.locator(
      ':text("Delivery not available to this pincode"), :text("Not deliverable to your pincode"), :text("Enter delivery pincode"), :text("Item cannot be shipped to your location"), :text("Delivery not available")'
    );
    const hasPincodeBlocker = await pincodeBlockerLocator
      .first()
      .isVisible()
      .catch(() => false);

    if (hasPincodeBlocker) {
      return {
        isBlocked: true,
        reason: "DELIVERY_RESTRICTION_OR_PINCODE_REQUIRED",
        message: "Delivery restriction or delivery pincode requirement detected",
      };
    }

    return { isBlocked: false };
  }

  /**
   * Detects explicit out-of-stock banners or messages on the product page.
   */
  async detectExplicitOutOfStock(page: Page): Promise<boolean> {
    const oosLocator = page.locator(
      'div._16FRp0, div._1V3wGL, :text("Currently Out of Stock"), :text("Sold Out"), :text("Item is unavailable"), :text("Coming Soon")'
    );
    return await oosLocator
      .first()
      .isVisible()
      .catch(() => false);
  }

  /**
   * Detects Add-to-Cart and Go-to-Cart controls, excluding Buy Now buttons.
   */
  async findActionButton(page: Page): Promise<ActionButtonDetection> {
    // 1. Check for "GO TO CART"
    const goToCartLocator = page
      .locator("button, a")
      .filter({ hasText: /^go to cart$/i });

    const goToCartCount = await goToCartLocator.count().catch(() => 0);
    if (goToCartCount > 0) {
      const firstGoToCart = goToCartLocator.first();
      const isVisible = await firstGoToCart.isVisible().catch(() => false);
      if (isVisible) {
        return {
          found: true,
          isAddCart: false,
          isGoToCart: true,
          isDisabled: false,
          isAmbiguous: false,
          buttonText: "GO TO CART",
          locator: firstGoToCart,
        };
      }
    }

    // 2. Check for "ADD TO CART" (strictly excluding "BUY NOW")
    const addToCartLocator = page
      .locator("button, a")
      .filter({ hasText: /^add to cart$/i });

    const count = await addToCartLocator.count().catch(() => 0);

    if (count === 0) {
      return {
        found: false,
        isAddCart: false,
        isGoToCart: false,
        isDisabled: false,
        isAmbiguous: false,
        buttonText: null,
        locator: null,
      };
    }

    if (count > 2) {
      // Ambiguous multiple conflicting Add to Cart buttons
      return {
        found: true,
        isAddCart: true,
        isGoToCart: false,
        isDisabled: false,
        isAmbiguous: true,
        buttonText: null,
        locator: null,
      };
    }

    const targetButton = addToCartLocator.first();
    const isVisible = await targetButton.isVisible().catch(() => false);
    if (!isVisible) {
      return {
        found: false,
        isAddCart: false,
        isGoToCart: false,
        isDisabled: false,
        isAmbiguous: false,
        buttonText: null,
        locator: null,
      };
    }

    // Check if button is disabled via attribute, aria, or class
    const disabledAttr = await targetButton
      .getAttribute("disabled")
      .catch(() => null);
    const ariaDisabled = await targetButton
      .getAttribute("aria-disabled")
      .catch(() => null);
    const className = (await targetButton.getAttribute("class").catch(() => "")) || "";
    const isEnabled = await targetButton.isEnabled().catch(() => true);

    const isDisabled =
      disabledAttr !== null ||
      ariaDisabled === "true" ||
      className.includes("disabled") ||
      !isEnabled;

    return {
      found: true,
      isAddCart: true,
      isGoToCart: false,
      isDisabled,
      isAmbiguous: false,
      buttonText: "ADD TO CART",
      locator: targetButton,
    };
  }

  /**
   * Normalizes Flipkart product identifiers for exact string matching.
   */
  normalizeProductId(rawId: string | null | undefined): string | null {
    if (!rawId) return null;
    const clean = rawId.trim();
    if (!clean) return null;

    // Check if rawId is a URL
    if (clean.includes("/") || clean.includes("?")) {
      const extracted = extractFlipkartProductId(clean);
      return extracted ? extracted.trim().toLowerCase() : clean.toLowerCase();
    }

    return clean.toLowerCase();
  }

  /**
   * Inspects active cart items inside /viewcart.
   * Prioritizes exact Flipkart product ID matching.
   * NEVER deletes or clears any existing cart items.
   */
  async inspectCartItems(
    page: Page,
    targetProductId: string | null,
    targetTitle: string | null
  ): Promise<CartItemsInspectionResult> {
    const normalizedTargetId = this.normalizeProductId(targetProductId);

    // Cart items container list
    const cartItemElements = page.locator("div._1AtVbE, div.gXlS2w, div[class*='cartItem']");
    const totalItems = await cartItemElements.count().catch(() => 0);

    if (totalItems === 0) {
      return {
        foundTarget: false,
        isOosInCart: false,
        isAmbiguousIdentity: false,
        totalItems: 0,
        matchedBy: "NONE",
        matchedItemTitle: null,
        matchedItemId: null,
        staleCartDetected: false,
      };
    }

    let matchedItemTitle: string | null = null;
    let matchedItemId: string | null = null;
    let foundTarget = false;
    let isOosInCart = false;

    for (let i = 0; i < totalItems; i++) {
      const item = cartItemElements.nth(i);

      // Extract all product link anchors inside this cart item
      const linkAnchors = item.locator("a[href*='/p/'], a[href*='pid=']");
      const linkCount = await linkAnchors.count().catch(() => 0);

      const candidateIds: string[] = [];
      let itemTitle: string | null = null;

      for (let j = 0; j < linkCount; j++) {
        const link = linkAnchors.nth(j);
        const href = await link.getAttribute("href").catch(() => null);
        if (href) {
          const extracted = extractFlipkartProductId(href);
          if (extracted) {
            candidateIds.push(extracted.toLowerCase());
          }
          // Also check for itm... pathname regex directly
          const itmMatch = href.match(/\/p\/(itm[a-zA-Z0-9]+)/i);
          if (itmMatch && itmMatch[1]) {
            candidateIds.push(itmMatch[1].toLowerCase());
          }
        }

        const titleText = await link.innerText().catch(() => null);
        if (titleText && titleText.trim().length > 0) {
          itemTitle = titleText.trim();
        }
      }

      // Check for exact product ID match
      const exactMatch =
        normalizedTargetId &&
        candidateIds.some((cid) => cid === normalizedTargetId);

      if (exactMatch) {
        foundTarget = true;
        matchedItemId = normalizedTargetId;
        matchedItemTitle = itemTitle;

        // Check if item is marked Out of Stock within the cart
        const itemOosIndicator = item.locator(
          ':text("Out of Stock"), :text("Currently Out of Stock"), div[class*="outOfStock"]'
        );
        isOosInCart = await itemOosIndicator
          .first()
          .isVisible()
          .catch(() => false);

        break;
      }
    }

    if (foundTarget) {
      return {
        foundTarget: true,
        isOosInCart,
        isAmbiguousIdentity: false,
        totalItems,
        matchedBy: "PRODUCT_ID",
        matchedItemTitle,
        matchedItemId,
        staleCartDetected: totalItems > 1,
      };
    }

    // Exact ID did not match. Check if targetProductId was absent and we must rely on title.
    if (!normalizedTargetId && targetTitle) {
      const cleanTargetTitle = targetTitle.trim().toLowerCase();
      // Strict exact title match only; fuzzy title match alone will not produce AVAILABLE
      let exactTitleMatches = 0;
      let matchedTitleText: string | null = null;

      for (let i = 0; i < totalItems; i++) {
        const item = cartItemElements.nth(i);
        const titleEl = item.locator("a[href*='/p/'], div[class*='title']").first();
        const text = await titleEl.innerText().catch(() => null);
        if (text && text.trim().toLowerCase() === cleanTargetTitle) {
          exactTitleMatches++;
          matchedTitleText = text.trim();
        }
      }

      if (exactTitleMatches === 1) {
        return {
          foundTarget: true,
          isOosInCart: false,
          isAmbiguousIdentity: false,
          totalItems,
          matchedBy: "EXACT_TITLE_FALLBACK",
          matchedItemTitle: matchedTitleText,
          matchedItemId: null,
          staleCartDetected: totalItems > 1,
        };
      }

      if (exactTitleMatches > 1) {
        return {
          foundTarget: false,
          isOosInCart: false,
          isAmbiguousIdentity: true,
          totalItems,
          matchedBy: "NONE",
          matchedItemTitle: null,
          matchedItemId: null,
          staleCartDetected: true,
        };
      }
    }

    // Target item was not found in cart
    return {
      foundTarget: false,
      isOosInCart: false,
      isAmbiguousIdentity: false,
      totalItems,
      matchedBy: "NONE",
      matchedItemTitle: null,
      matchedItemId: null,
      staleCartDetected: totalItems > 0,
    };
  }

  /**
   * Helper constructing a typed CartCheckAvailableResult.
   */
  createAvailableResult(
    url: string,
    productId: string | null,
    productTitle: string | null,
    reason: "VERIFIED_NEW_ADD_TO_CART" | "ALREADY_IN_CART",
    evidence: CartVerificationEvidence
  ): CartCheckAvailableResult {
    return {
      checkStatus: "SUCCESS",
      cartAvailability: "AVAILABLE",
      url,
      productId,
      productTitle,
      reason,
      evidence,
      checkedAt: new Date().toISOString(),
    };
  }

  /**
   * Helper constructing a typed CartCheckOutOfStockResult.
   */
  createOutOfStockResult(
    url: string,
    productId: string | null,
    productTitle: string | null,
    reason:
      | "EXPLICIT_OUT_OF_STOCK_BANNER"
      | "BUTTON_DISABLED_WITH_OOS_EVIDENCE"
      | "CART_ITEM_MARKED_OOS",
    evidence: CartVerificationEvidence
  ): CartCheckOutOfStockResult {
    return {
      checkStatus: "SUCCESS",
      cartAvailability: "OUT_OF_STOCK",
      url,
      productId,
      productTitle,
      reason,
      evidence,
      checkedAt: new Date().toISOString(),
    };
  }

  /**
   * Helper constructing a typed CartCheckErrorResult.
   */
  createErrorResult(
    url: string,
    productId: string | null,
    productTitle: string | null,
    errorReason:
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
      | "BROWSER_ERROR",
    errorMessage: string,
    evidence: CartVerificationEvidence
  ): CartCheckErrorResult {
    return {
      checkStatus: "ERROR",
      cartAvailability: "UNKNOWN",
      url,
      productId,
      productTitle,
      errorReason,
      errorMessage,
      evidence,
      checkedAt: new Date().toISOString(),
    };
  }

  /**
   * Executes the full multi-signal cart verification flow on an active Playwright page.
   */
  async executeVerificationFlow(
    page: Page,
    cleanUrl: string,
    targetProductId: string | null,
    timeoutMs: number
  ): Promise<CartCheckResult> {
    const evidence: CartVerificationEvidence = {
      buttonFound: false,
      buttonText: null,
      buttonState: "NOT_FOUND",
      cartNavigated: false,
      cartUrl: null,
      matchedBy: "NONE",
      matchedItemTitle: null,
      matchedItemId: null,
      staleCartDetected: false,
      preExistingCartCheckPerformed: false,
    };

    let extractedTitle: string | null = null;

    try {
      // 1. Initial page navigation
      await page.goto(cleanUrl, {
        waitUntil: "domcontentloaded",
        timeout: timeoutMs,
      });

      // 2. Initial blocker check
      const initialBlocker = await this.detectBlockers(page);
      if (initialBlocker.isBlocked) {
        return this.createErrorResult(
          cleanUrl,
          targetProductId,
          null,
          initialBlocker.reason!,
          initialBlocker.message!,
          evidence
        );
      }

      // 3. Extract title if possible
      extractedTitle = await page
        .locator("span.VU-ZEz, span.B_NuCI, h1.yhB1nd, h1")
        .first()
        .innerText({ timeout: 3000 })
        .catch(() => null);

      if (extractedTitle) {
        extractedTitle = extractedTitle.trim();
      }

      // 4. Check explicit out-of-stock evidence on PDP
      const explicitOosPresent = await this.detectExplicitOutOfStock(page);

      // 5. Detect Action Controls
      const buttonDetection = await this.findActionButton(page);
      evidence.buttonFound = buttonDetection.found;
      evidence.buttonText = buttonDetection.buttonText;
      evidence.buttonState = buttonDetection.isAmbiguous
        ? "AMBIGUOUS"
        : buttonDetection.isDisabled
        ? "DISABLED"
        : buttonDetection.found
        ? "ENABLED"
        : "NOT_FOUND";

      if (buttonDetection.isAmbiguous) {
        return this.createErrorResult(
          cleanUrl,
          targetProductId,
          extractedTitle,
          "AMBIGUOUS_ACTION_BUTTON",
          "Multiple competing Add-to-Cart buttons detected on product page",
          evidence
        );
      }

      // Check explicit OOS banner condition
      if (explicitOosPresent) {
        if (buttonDetection.isDisabled) {
          return this.createOutOfStockResult(
            cleanUrl,
            targetProductId,
            extractedTitle,
            "BUTTON_DISABLED_WITH_OOS_EVIDENCE",
            evidence
          );
        }
        return this.createOutOfStockResult(
          cleanUrl,
          targetProductId,
          extractedTitle,
          "EXPLICIT_OUT_OF_STOCK_BANNER",
          evidence
        );
      }

      // If button is missing and no OOS evidence exists
      if (!buttonDetection.found) {
        // Check if page lacks basic expected structure
        if (!extractedTitle) {
          return this.createErrorResult(
            cleanUrl,
            targetProductId,
            null,
            "UNEXPECTED_PAGE_LAYOUT",
            "Page did not render recognized title, action controls, or stock indicators",
            evidence
          );
        }

        return this.createErrorResult(
          cleanUrl,
          targetProductId,
          extractedTitle,
          "MISSING_ADD_TO_CART_BUTTON",
          "Product page rendered without Add-to-Cart controls and without explicit out-of-stock banners",
          evidence
        );
      }

      // If button is disabled WITHOUT supporting out-of-stock evidence
      if (buttonDetection.isDisabled) {
        return this.createErrorResult(
          cleanUrl,
          targetProductId,
          extractedTitle,
          "BUTTON_DISABLED_WITHOUT_OOS_EVIDENCE",
          "Add-to-Cart button is disabled, but no explicit out-of-stock evidence was confirmed",
          evidence
        );
      }

      // Handle "GO TO CART" state
      if (buttonDetection.isGoToCart) {
        logger.debug(`Product button shows GO TO CART; inspecting /viewcart for ${cleanUrl}`);
        evidence.cartNavigated = true;

        await page.goto("https://www.flipkart.com/viewcart", {
          waitUntil: "domcontentloaded",
          timeout: timeoutMs,
        });

        evidence.cartUrl = page.url();

        // Check blockers in cart
        const cartBlocker = await this.detectBlockers(page);
        if (cartBlocker.isBlocked) {
          return this.createErrorResult(
            cleanUrl,
            targetProductId,
            extractedTitle,
            cartBlocker.reason!,
            cartBlocker.message!,
            evidence
          );
        }

        const cartInspection = await this.inspectCartItems(
          page,
          targetProductId,
          extractedTitle
        );

        evidence.matchedBy = cartInspection.matchedBy;
        evidence.matchedItemId = cartInspection.matchedItemId;
        evidence.matchedItemTitle = cartInspection.matchedItemTitle;
        evidence.staleCartDetected = cartInspection.staleCartDetected;

        if (cartInspection.isAmbiguousIdentity) {
          return this.createErrorResult(
            cleanUrl,
            targetProductId,
            extractedTitle,
            "AMBIGUOUS_PRODUCT_IDENTITY",
            "Product identity in cart was ambiguous and could not be verified reliably",
            evidence
          );
        }

        if (cartInspection.foundTarget) {
          if (cartInspection.isOosInCart) {
            return this.createOutOfStockResult(
              cleanUrl,
              targetProductId,
              extractedTitle,
              "CART_ITEM_MARKED_OOS",
              evidence
            );
          }
          return this.createAvailableResult(
            cleanUrl,
            targetProductId,
            extractedTitle,
            "ALREADY_IN_CART",
            evidence
          );
        }

        return this.createErrorResult(
          cleanUrl,
          targetProductId,
          extractedTitle,
          "TARGET_ITEM_NOT_FOUND_IN_CART",
          "Product page showed GO TO CART, but target product was not found in active cart items",
          evidence
        );
      }

      // Handle "ADD TO CART" (enabled)
      logger.debug(`Attempting Add to Cart click for ${cleanUrl}`);
      const button = buttonDetection.locator!;

      // Click Add to Cart with bounded timeout
      await button.click({ timeout: 5000 });

      // Post-click blocker check (e.g. login popup or delivery pincode intercept)
      const postClickBlocker = await this.detectBlockers(page);
      if (postClickBlocker.isBlocked) {
        return this.createErrorResult(
          cleanUrl,
          targetProductId,
          extractedTitle,
          postClickBlocker.reason!,
          postClickBlocker.message!,
          evidence
        );
      }

      // Check if button transitioned to "GO TO CART" or page navigated
      let freshAdditionSignal = false;
      const currentUrl = page.url();

      if (currentUrl.includes("/viewcart")) {
        freshAdditionSignal = true;
        evidence.cartNavigated = true;
        evidence.cartUrl = currentUrl;
      } else {
        // Wait briefly for button transition or navigate to /viewcart
        const transitioned = await page
          .locator("button, a")
          .filter({ hasText: /^go to cart$/i })
          .first()
          .isVisible({ timeout: 2000 })
          .catch(() => false);

        if (transitioned) {
          freshAdditionSignal = true;
        }

        // Navigate to /viewcart to verify item presence
        await page.goto("https://www.flipkart.com/viewcart", {
          waitUntil: "domcontentloaded",
          timeout: timeoutMs,
        });
        evidence.cartNavigated = true;
        evidence.cartUrl = page.url();
      }

      // Check blockers on /viewcart
      const cartBlocker = await this.detectBlockers(page);
      if (cartBlocker.isBlocked) {
        return this.createErrorResult(
          cleanUrl,
          targetProductId,
          extractedTitle,
          cartBlocker.reason!,
          cartBlocker.message!,
          evidence
        );
      }

      // Inspect cart items
      const cartInspection = await this.inspectCartItems(
        page,
        targetProductId,
        extractedTitle
      );

      evidence.matchedBy = cartInspection.matchedBy;
      evidence.matchedItemId = cartInspection.matchedItemId;
      evidence.matchedItemTitle = cartInspection.matchedItemTitle;
      evidence.staleCartDetected = cartInspection.staleCartDetected;

      if (cartInspection.isAmbiguousIdentity) {
        return this.createErrorResult(
          cleanUrl,
          targetProductId,
          extractedTitle,
          "AMBIGUOUS_PRODUCT_IDENTITY",
          "Product identity in cart was ambiguous and could not be verified reliably",
          evidence
        );
      }

      if (cartInspection.foundTarget) {
        if (cartInspection.isOosInCart) {
          return this.createOutOfStockResult(
            cleanUrl,
            targetProductId,
            extractedTitle,
            "CART_ITEM_MARKED_OOS",
            evidence
          );
        }

        // Distinguish fresh addition from conservative ALREADY_IN_CART
        const reason = freshAdditionSignal
          ? "VERIFIED_NEW_ADD_TO_CART"
          : "ALREADY_IN_CART";

        return this.createAvailableResult(
          cleanUrl,
          targetProductId,
          extractedTitle,
          reason,
          evidence
        );
      }

      // Target item was not found in cart
      return this.createErrorResult(
        cleanUrl,
        targetProductId,
        extractedTitle,
        "TARGET_ITEM_NOT_FOUND_IN_CART",
        "Add-to-Cart was clicked, but target product was not found in active cart items",
        evidence
      );
    } catch (error) {
      const err = error as Error;
      evidence.rawError = err.message;

      if (err.name === "TimeoutError" || err.message.toLowerCase().includes("timeout")) {
        return this.createErrorResult(
          cleanUrl,
          targetProductId,
          extractedTitle,
          "NAVIGATION_TIMEOUT",
          `Operation timed out: ${err.message}`,
          evidence
        );
      }

      if (
        err.message.includes("ERR_NAME_NOT_RESOLVED") ||
        err.message.includes("ERR_CONNECTION_REFUSED") ||
        err.message.includes("net::")
      ) {
        return this.createErrorResult(
          cleanUrl,
          targetProductId,
          extractedTitle,
          "NETWORK_ERROR",
          `Network communication failed: ${err.message}`,
          evidence
        );
      }

      return this.createErrorResult(
        cleanUrl,
        targetProductId,
        extractedTitle,
        "BROWSER_ERROR",
        `Unexpected browser execution error: ${err.message}`,
        evidence
      );
    }
  }
}

export const cartVerifier = new CartVerifier();
