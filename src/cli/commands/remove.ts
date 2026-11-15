import { ProductRepository } from "../../db/repositories/product.repository.js";

export function removeCommand(idStr: string, options: { permanent?: boolean }): void {
  const id = parseInt(idStr, 10);
  if (isNaN(id) || !Number.isInteger(id) || id <= 0) {
    console.error("❌ Error: Invalid product ID.");
    process.exit(1);
    return;
  }

  const repo = new ProductRepository();
  const existing = repo.findById(id);

  if (!existing) {
    console.error(`❌ Error: Product with ID ${id} was not found.`);
    process.exit(1);
    return;
  }

  if (options.permanent) {
    repo.delete(id);
    console.log(`🗑️ Permanently deleted product ID ${id} ("${existing.title}")`);
  } else {
    repo.deactivate(id);
    console.log(`⏸️ Deactivated product ID ${id} ("${existing.title}"). It will no longer be checked.`);
  }
}
