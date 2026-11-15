import { ProductRepository } from "../../db/repositories/product.repository.js";
import { isValidFlipkartUrl, sanitizeFlipkartUrl, extractFlipkartProductId } from "../../shared/utils.js";
import { DatabaseError } from "../../shared/errors.js";

export async function addCommand(
  url: string,
  options: { title?: string }
): Promise<void> {
  if (!isValidFlipkartUrl(url)) {
    console.error("❌ Error: Invalid Flipkart product URL provided.");
    process.exit(1);
    return;
  }

  const cleanUrl = sanitizeFlipkartUrl(url);
  const productId = extractFlipkartProductId(cleanUrl);
  const repo = new ProductRepository();

  const existingByUrl = repo.findByUrl(cleanUrl);
  if (existingByUrl) {
    console.warn(`⚠️ Warning: This product is already registered (ID: ${existingByUrl.id}, Title: "${existingByUrl.title}").`);
    return;
  }

  if (productId) {
    const existingByPid = repo.findByProductId(productId);
    if (existingByPid) {
      console.warn(`⚠️ Warning: Product with Flipkart ID "${productId}" already exists (ID: ${existingByPid.id}, Title: "${existingByPid.title}").`);
      return;
    }
  }

  try {
    const product = repo.create({
      url: cleanUrl,
      title: options.title || "Pending Initial Check",
    });

    console.log("✅ Product successfully added to Stock Checker!");
    console.log(`   ID:                ${product.id}`);
    console.log(`   Title:             ${product.title}`);
    console.log(`   Product ID:        ${product.productId || "None"}`);
    console.log(`   Cart Availability: ${product.cartAvailability}`);
    console.log(`   Check Status:      ${product.lastCheckStatus}`);
    console.log(`   URL:               ${product.url}`);
  } catch (error) {
    if (error instanceof DatabaseError && error.code === "DUPLICATE_PRODUCT") {
      console.warn(`⚠️ Warning: ${error.message}`);
    } else {
      console.error(`❌ Error adding product: ${(error as Error).message}`);
      process.exit(1);
    }
  }
}
