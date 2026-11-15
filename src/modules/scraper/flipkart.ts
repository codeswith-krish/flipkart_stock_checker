import { withIsolatedPage, closeBrowser } from "./browser.js";
import type { IScraper, ScrapedProductData, CartCheckResult } from "./types.js";
import { cartVerifier } from "./cart-verifier.js";
import { parseCurrency, sanitizeFlipkartUrl, extractFlipkartProductId } from "../../shared/utils.js";
import { logger } from "../../shared/logger.js";
import { config } from "../../config/index.js";

export class FlipkartScraper implements IScraper {
  /**
   * Pure read-only scraper for product metadata (title, price, inStock banner).
   * Strictly avoids cart interaction or cart mutation.
   */
  async scrapeProduct(rawUrl: string): Promise<ScrapedProductData> {
    const cleanUrl = sanitizeFlipkartUrl(rawUrl);
    logger.info(`Scraping Flipkart product metadata (read-only): ${cleanUrl}`);

    return await withIsolatedPage(async (page) => {
      try {
        await page.goto(cleanUrl, {
          waitUntil: "domcontentloaded",
          timeout: config.SCRAPER_TIMEOUT_MS,
        });

        // Product Title
        const title = await page
          .locator("span.VU-ZEz, span.B_NuCI, h1.yhB1nd, h1")
          .first()
          .innerText({ timeout: 5000 })
          .catch(() => null);

        // Price
        const priceText = await page
          .locator("div.Nx9bqj.CxhGGd, div._30jeq3._16Jk6d, div._30jeq3")
          .first()
          .innerText({ timeout: 5000 })
          .catch(() => null);

        // Out of stock banner indicators
        const outOfStockBanner = await page
          .locator("div._16FRp0, div._1V3wGL, :text('Currently Out of Stock'), :text('Sold Out')")
          .first()
          .isVisible()
          .catch(() => false);

        const parsedPrice = parseCurrency(priceText);
        const inStock = !outOfStockBanner && parsedPrice !== null;

        return {
          url: cleanUrl,
          title: title ? title.trim() : null,
          price: parsedPrice,
          inStock,
          rawPriceText: priceText,
        };
      } catch (error) {
        logger.error(`Error scraping metadata for ${cleanUrl}: ${(error as Error).message}`);
        return {
          url: cleanUrl,
          title: null,
          price: null,
          inStock: false,
          error: (error as Error).message,
        };
      }
    });
  }

  /**
   * Multi-signal Add-to-Cart detection and verification engine.
   * Interacts with Add-to-Cart, verifies exact product identity in cart,
   * and classifies outcomes into a strict discriminated union.
   *
   * Note: This method never modifies SQLite records and never deletes cart items.
   */
  async checkCartAvailability(
    rawUrl: string,
    expectedProductId?: string | null
  ): Promise<CartCheckResult> {
    const cleanUrl = sanitizeFlipkartUrl(rawUrl);
    const targetProductId = expectedProductId || extractFlipkartProductId(cleanUrl);

    logger.info(
      `Checking cart availability for product: ${cleanUrl} (targetProductId: ${targetProductId || "unknown"})`
    );

    return await withIsolatedPage(async (page) => {
      return await cartVerifier.executeVerificationFlow(
        page,
        cleanUrl,
        targetProductId,
        config.SCRAPER_TIMEOUT_MS
      );
    });
  }

  async close(): Promise<void> {
    await closeBrowser();
  }
}

export const flipkartScraper = new FlipkartScraper();
