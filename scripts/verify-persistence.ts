import { runMigrations } from "../src/db/migrations.js";
import { ProductRepository } from "../src/db/repositories/product.repository.js";
import { closeDb } from "../src/db/client.js";

async function verifyPersistence(): Promise<void> {
  console.log("=== Verifying SQLite Persistence (Node.js/TypeScript) ===");

  // 1. Initialize schema on real disk database
  runMigrations();
  const repo = new ProductRepository();

  const testUrl = "https://www.flipkart.com/persistence-check/p/itm123?pid=PERSISTENCE_TEST_001";
  const testTitle = "Temporary Persistence Verification Product";

  // Clean up any previous test artifact if it exists
  const existing = repo.findByProductId("PERSISTENCE_TEST_001");
  if (existing) {
    repo.delete(existing.id);
  }

  // 2. Insert temporary product using project implementation
  console.log("1. Creating temporary test product in persistent database...");
  const created = repo.create({ url: testUrl, title: testTitle });
  console.log(`   Created Product ID: ${created.id}, Title: "${created.title}", PID: ${created.productId}`);

  // 3. Close database connection and re-open to verify persistent disk storage
  console.log("2. Closing and reopening connection to verify disk durability...");
  closeDb();

  const newRepo = new ProductRepository();
  const reloaded = newRepo.findById(created.id);

  if (!reloaded) {
    throw new Error(`Failed to reload product with ID ${created.id} from disk database!`);
  }
  console.log(`   Successfully reloaded product from disk: "${reloaded.title}" (Cart Status: ${reloaded.cartAvailability}, Check Status: ${reloaded.lastCheckStatus})`);

  // 4. Clean up only the temporary product
  console.log("3. Cleaning up temporary product...");
  const deleted = newRepo.delete(created.id);
  console.log(`   Deleted temporary test product: ${deleted}`);

  // 5. Confirm deletion
  const afterDelete = newRepo.findById(created.id);
  if (afterDelete !== null) {
    throw new Error("Temporary product was not cleaned up properly!");
  }
  console.log("   Confirmed product removed from persistent database.");

  closeDb();
  console.log("=== Persistence Verification Passed Successfully! ===");
}

verifyPersistence().catch((err) => {
  console.error("Persistence verification failed:", err);
  process.exit(1);
});
