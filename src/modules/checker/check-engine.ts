import { ProductRepository } from "../../db/repositories/product.repository.js";
import { PriceHistoryRepository } from "../../db/repositories/price-history.repository.js";
import { flipkartScraper } from "../scraper/flipkart.js";
import { telegramNotifier } from "../notifier/telegram.js";
import type { IScraper } from "../scraper/types.js";
import type { INotifier } from "../notifier/types.js";
import type { CheckResult, Product } from "../../types/index.js";
import type { CheckCycleSummary } from "./types.js";
import { logger } from "../../shared/logger.js";
import { sleep } from "../../shared/utils.js";

export class CheckEngine {
  private productRepo: ProductRepository;
  private historyRepo: PriceHistoryRepository;
  private scraper: IScraper;
  private notifier: INotifier;

  constructor(
    productRepo?: ProductRepository,
    historyRepo?: PriceHistoryRepository,
    scraper?: IScraper,
    notifier?: INotifier
  ) {
    this.productRepo = productRepo || new ProductRepository();
    this.historyRepo = historyRepo || new PriceHistoryRepository();
    this.scraper = scraper || flipkartScraper;
    this.notifier = notifier || telegramNotifier;
  }

  async runSingleCheck(product: Product): Promise<CheckResult> {
    const previousPrice = product.currentPrice;
    const previousInStock = product.inStock;

    const scraped = await this.scraper.scrapeProduct(product.url);

    // Record check history
    this.historyRepo.record(
      product.id,
      scraped.price,
      scraped.inStock,
      scraped.error || null
    );

    let alertTriggered = false;

    if (!scraped.error && scraped.price !== null) {
      // Update database product record
      this.productRepo.updatePriceAndStock(
        product.id,
        scraped.price,
        scraped.inStock,
        scraped.title || product.title
      );

      // Check condition 1: Back in stock
      if (!previousInStock && scraped.inStock) {
        logger.info(`Stock change detected for ${product.title}: now in stock!`);
        await this.notifier.sendNotification({
          type: "BACK_IN_STOCK",
          product: { ...product, title: scraped.title || product.title },
          previousPrice,
          currentPrice: scraped.price,
        });
        alertTriggered = true;
      }

      // Check condition 2: Price drop below target
      const hitTargetPrice = scraped.price <= product.targetPrice;
      const isPriceLowerThanPrevious = previousPrice === null || scraped.price < previousPrice;

      if (hitTargetPrice && isPriceLowerThanPrevious && scraped.inStock) {
        logger.info(
          `Target price hit for ${product.title}! Target: ${product.targetPrice}, Current: ${scraped.price}`
        );
        await this.notifier.sendNotification({
          type: "PRICE_DROP",
          product: { ...product, title: scraped.title || product.title },
          previousPrice,
          currentPrice: scraped.price,
        });
        alertTriggered = true;
      }
    }

    return {
      productId: product.id,
      url: product.url,
      previousPrice,
      currentPrice: scraped.price,
      previousInStock,
      currentInStock: scraped.inStock,
      alertTriggered,
      error: scraped.error,
    };
  }

  async runAllChecks(): Promise<CheckCycleSummary> {
    const startedAt = new Date().toISOString();
    const activeProducts = this.productRepo.findActive();

    logger.info(`Starting check cycle for ${activeProducts.length} active products.`);

    const results: CheckResult[] = [];
    let alertsCount = 0;

    for (const product of activeProducts) {
      try {
        const result = await this.runSingleCheck(product);
        results.push(result);
        if (result.alertTriggered) alertsCount++;
      } catch (err) {
        logger.error(`Error during check for product ID ${product.id}`, err);
        results.push({
          productId: product.id,
          url: product.url,
          previousPrice: product.currentPrice,
          currentPrice: null,
          previousInStock: product.inStock,
          currentInStock: false,
          alertTriggered: false,
          error: (err as Error).message,
        });
      }

      // 2-second polite cooldown between requests on single VM
      await sleep(2000);
    }

    const completedAt = new Date().toISOString();
    logger.info(
      `Check cycle completed. Checked: ${results.length}, Alerts sent: ${alertsCount}`
    );

    return {
      startedAt,
      completedAt,
      totalChecked: results.length,
      alertsTriggered: alertsCount,
      results,
    };
  }
}

export const checkEngine = new CheckEngine();
