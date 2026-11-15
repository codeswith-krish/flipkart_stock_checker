import { ProductRepository } from "../../db/repositories/product.repository.js";

export function listCommand(options: { all?: boolean }): void {
  const repo = new ProductRepository();
  const products = options.all ? repo.findAll() : repo.findActive();

  if (products.length === 0) {
    console.log("No products found in the database. Use 'stock add <url>' to track items.");
    return;
  }

  console.log(`\n📋 Tracked Products (${products.length} ${options.all ? "total" : "active"}):\n`);

  const formattedRows = products.map((p) => ({
    ID: p.id,
    Title: p.title.length > 30 ? p.title.slice(0, 27) + "..." : p.title,
    "Product ID": p.productId || "N/A",
    Active: p.isActive ? "Yes" : "No",
    "Cart Status":
      p.cartAvailability === "AVAILABLE"
        ? "🟢 Available"
        : p.cartAvailability === "OUT_OF_STOCK"
        ? "🔴 Out of Stock"
        : "⚪ Unknown",
    "Check Status":
      p.lastCheckStatus === "SUCCESS"
        ? "🟢 OK"
        : p.lastCheckStatus === "ERROR"
        ? "🔴 Error"
        : "⚪ Never Checked",
    "Alert State": p.retryCount >= 5 ? "SUSPENDED" : p.notificationState,
    "Last Checked": p.lastCheckedAt ? new Date(p.lastCheckedAt).toLocaleString() : "Never",
  }));

  console.table(formattedRows);
}
