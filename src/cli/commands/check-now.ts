import { ProductRepository } from "../../db/repositories/product.repository.js";
import { checkEngine } from "../../modules/checker/check-engine.js";
import { closeBrowser } from "../../modules/scraper/browser.js";
import { notificationDispatcher } from "../../modules/notifier/dispatcher.js";
import { logger } from "../../shared/logger.js";

export async function checkNowCommand(options: { id?: string }): Promise<void> {
  const repo = new ProductRepository();

  try {
    if (options.id) {
      const id = parseInt(options.id, 10);
      const product = repo.findById(id);

      if (!product) {
        console.error(`❌ Product ID ${id} not found.`);
        process.exit(1);
        return;
      }

      console.log(`🔍 Checking product ID ${id}: ${product.title}...`);
      const result = await checkEngine.runSingleCheck(product);

      console.log(`\nResult for ${product.title}:`);
      console.log(`   Cart Availability: ${result.cartAvailability || "UNKNOWN"}`);
      console.log(`   Check Status:      ${result.checkStatus}`);
      console.log(`   Notification Queued: ${result.notificationQueued ? "Yes" : "No"}`);
      if (result.error) console.log(`   Error:             ${result.error}`);
    } else {
      console.log("🔍 Running full check cycle for all active products...");
      const summary = await checkEngine.runAllChecks();

      console.log(`\n✅ Check cycle finished.`);
      console.log(`   Total Checked:    ${summary.totalChecked}`);
      console.log(`   Notifications Queued: ${summary.alertsTriggered}`);
    }
  } catch (error) {
    console.error(`❌ Check execution failed: ${(error as Error).message}`);
  } finally {
    // Release browser resources immediately before notification dispatch
    await closeBrowser();
  }

  // Trigger post-check notification sweep
  try {
    const dispatchResult = await notificationDispatcher.dispatchPending();
    if (dispatchResult.dispatchedCount > 0) {
      console.log(`📬 Dispatched ${dispatchResult.dispatchedCount} Telegram alert(s).`);
    }
  } catch (dispatchErr: any) {
    logger.error("Error during post-check notification dispatch", dispatchErr);
  }
}
