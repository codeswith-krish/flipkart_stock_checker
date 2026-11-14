import { ProductRepository } from "../../db/repositories/product.repository.js";
import { flipkartScraper } from "../scraper/flipkart.js";
import { telegramNotifier } from "../notifier/telegram.js";
import type { IScraper } from "../scraper/types.js";
import type { INotifier } from "../notifier/types.js";
import type { CheckResult, Product } from "../../types/index.js";
import type { CheckCycleSummary } from "./types.js";
import { AppError } from "../../shared/errors.js";

export class CheckEngine {
  private productRepo: ProductRepository;
  private scraper: IScraper;
  private notifier: INotifier;

  constructor(
    productRepo?: ProductRepository,
    scraper?: IScraper,
    notifier?: INotifier
  ) {
    this.productRepo = productRepo || new ProductRepository();
    this.scraper = scraper || flipkartScraper;
    this.notifier = notifier || telegramNotifier;
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async runSingleCheck(_product: Product): Promise<CheckResult> {
    throw new AppError(
      "Check engine execution is not implemented yet (scheduled for Phase 3: Playwright Add-to-Cart automation)",
      "NOT_IMPLEMENTED"
    );
  }

  async runAllChecks(): Promise<CheckCycleSummary> {
    throw new AppError(
      "Check engine execution is not implemented yet (scheduled for Phase 3: Playwright Add-to-Cart automation)",
      "NOT_IMPLEMENTED"
    );
  }
}

export const checkEngine = new CheckEngine();
