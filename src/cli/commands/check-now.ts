import { ProductRepository } from "../../db/repositories/product.repository.js";
import { checkEngine } from "../../modules/checker/check-engine.js";
import { closeBrowser } from "../../modules/scraper/browser.js";
import { formatINR } from "../../shared/utils.js";

export async function checkNowCommand(options: { id?: string }): Promise<void> {
  const repo = new ProductRepository();

  try {
    if (options.id) {
      const id = parseInt(options.id, 10);
      const product = repo.findById(id);

      if (!product) {
        console.error(`❌ Product ID ${id} not found.`);
        process.exit(1);
      }

      console.log(`🔍 Checking product ID ${id}: ${product.title}...`);
      const result = await checkEngine.runSingleCheck(product);

      console.log(`\nResult for ${product.title}:`);
      console.log(`   Price: ${formatINR(result.currentPrice)}`);
      console.log(`   Stock: ${result.currentInStock ? "🟢 In Stock" : "🔴 Out of Stock"}`);
      console.log(`   Alert Sent: ${result.alertTriggered ? "Yes" : "No"}`);
      if (result.error) console.log(`   Error: ${result.error}`);
    } else {
      console.log("🔍 Running full check cycle for all active products...");
      const summary = await checkEngine.runAllChecks();

      console.log(`\n✅ Check cycle finished.`);
      console.log(`   Total Checked:    ${summary.totalChecked}`);
      console.log(`   Alerts Sent:      ${summary.alertsTriggered}`);
    }
  } finally {
    await closeBrowser();
  }
}
