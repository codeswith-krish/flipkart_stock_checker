import { createLightweightPage, closeBrowser } from "./browser.js";
import type { IScraper, ScrapedProductData } from "./types.js";
import { parseCurrency, sanitizeFlipkartUrl } from "../../shared/utils.js";
import { logger } from "../../shared/logger.js";
import { config } from "../../config/index.js";

export class FlipkartScraper implements IScraper {
  async scrapeProduct(rawUrl: string): Promise<ScrapedProductData> {
    const cleanUrl = sanitizeFlipkartUrl(rawUrl);
    logger.info(`Scraping Flipkart product: ${cleanUrl}`);

    let pageContext: Awaited<ReturnType<typeof createLightweightPage>> | null = null;

    try {
      pageContext = await createLightweightPage();
      const { page, context } = pageContext;

      await page.goto(cleanUrl, {
        waitUntil: "domcontentloaded",
        timeout: config.SCRAPER_TIMEOUT_MS,
      });

      // Flipkart selectors
      // Product Title selectors
      const title = await page
        .locator("span.VU-ZEz, span.B_NuCI, h1.yhB1nd")
        .first()
        .innerText({ timeout: 5000 })
        .catch(() => null);

      // Price selectors
      const priceText = await page
        .locator("div.Nx9bqj.CxhGGd, div._30jeq3._16Jk6d, div._30jeq3")
        .first()
        .innerText({ timeout: 5000 })
        .catch(() => null);

      // Out of stock indicators: "Currently Out of Stock", "Sold Out", or presence of specific out-of-stock classes
      const outOfStockBanner = await page
        .locator("div._16FRp0, div._1V3wGL, :text('Currently Out of Stock'), :text('Sold Out')")
        .first()
        .isVisible()
        .catch(() => false);

      const parsedPrice = parseCurrency(priceText);
      const inStock = !outOfStockBanner && parsedPrice !== null;

      await page.close();
      await context.close();

      return {
        url: cleanUrl,
        title: title ? title.trim() : null,
        price: parsedPrice,
        inStock,
        rawPriceText: priceText,
      };
    } catch (error) {
      logger.error(`Error scraping ${cleanUrl}: ${(error as Error).message}`);
      if (pageContext) {
        await pageContext.page.close().catch(() => {});
        await pageContext.context.close().catch(() => {});
      }
      return {
        url: cleanUrl,
        title: null,
        price: null,
        inStock: false,
        error: (error as Error).message,
      };
    }
  }

  async close(): Promise<void> {
    await closeBrowser();
  }
}

export const flipkartScraper = new FlipkartScraper();
