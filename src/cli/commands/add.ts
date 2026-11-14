import { ProductRepository } from "../../db/repositories/product.repository.js";
import { isValidFlipkartUrl, sanitizeFlipkartUrl, formatINR } from "../../shared/utils.js";
import { logger } from "../../shared/logger.js";

export async function addCommand(
  url: string,
  options: { targetPrice: string; title?: string }
): Promise<void> {
  if (!isValidFlipkartUrl(url)) {
    console.error("❌ Error: Invalid Flipkart product URL provided.");
    process.exit(1);
  }

  const targetPrice = parseInt(options.targetPrice, 10);
  if (isNaN(targetPrice) || targetPrice <= 0) {
    console.error("❌ Error: Target price must be a positive integer.");
    process.exit(1);
  }

  const cleanUrl = sanitizeFlipkartUrl(url);
  const repo = new ProductRepository();

  const existing = repo.findByUrl(cleanUrl);
  if (existing) {
    console.warn(`⚠️ Warning: This product is already registered (ID: ${existing.id}, Title: "${existing.title}").`);
    return;
  }

  const product = repo.create({
    url: cleanUrl,
    targetPrice,
    title: options.title || "Pending Scrape",
  });

  console.log("✅ Product successfully added to Stock Checker!");
  console.log(`   ID:           ${product.id}`);
  console.log(`   Title:        ${product.title}`);
  console.log(`   Target Price: ${formatINR(product.targetPrice)}`);
  console.log(`   URL:          ${product.url}`);
}
