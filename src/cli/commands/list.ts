import { ProductRepository } from "../../db/repositories/product.repository.js";
import { formatINR } from "../../shared/utils.js";

export function listCommand(options: { all?: boolean }): void {
  const repo = new ProductRepository();
  const products = options.all ? repo.findAll() : repo.findActive();

  if (products.length === 0) {
    console.log("No products found in the database. Use 'stock add <url> --target-price <amount>' to track items.");
    return;
  }

  console.log(`\n📋 Tracked Products (${products.length} ${options.all ? "total" : "active"}):\n`);

  const formattedRows = products.map((p) => ({
    ID: p.id,
    Title: p.title.length > 35 ? p.title.slice(0, 32) + "..." : p.title,
    "Target Price": formatINR(p.targetPrice),
    "Current Price": formatINR(p.currentPrice),
    Stock: p.inStock ? "🟢 In Stock" : "🔴 Out of Stock",
    Active: p.isActive ? "Yes" : "No",
    "Last Checked": p.updatedAt ? new Date(p.updatedAt).toLocaleString() : "Never",
  }));

  console.table(formattedRows);
}
