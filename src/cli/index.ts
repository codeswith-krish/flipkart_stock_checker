#!/usr/bin/env node

import { Command } from "commander";
import { runMigrations } from "../db/migrations.js";
import { addCommand } from "./commands/add.js";
import { listCommand } from "./commands/list.js";
import { removeCommand } from "./commands/remove.js";
import { checkNowCommand } from "./commands/check-now.js";

// Ensure database schema is ready before any CLI action
runMigrations();

const program = new Command();

program
  .name("stock")
  .description("Stock Checker CLI - Manage Flipkart tracked products")
  .version("1.0.0");

program
  .command("add")
  .description("Add a Flipkart product URL to track")
  .argument("<url>", "Flipkart product URL")
  .requiredOption("-t, --target-price <number>", "Target alert price in INR")
  .option("--title <name>", "Optional custom product title")
  .action(addCommand);

program
  .command("list")
  .description("List tracked products")
  .option("-a, --all", "Include inactive products")
  .action(listCommand);

program
  .command("remove")
  .description("Deactivate or delete a tracked product")
  .argument("<id>", "Product ID to remove")
  .option("-p, --permanent", "Permanently delete record instead of deactivating")
  .action(removeCommand);

program
  .command("check-now")
  .description("Run an immediate stock & price check")
  .option("-i, --id <number>", "Check only a specific product ID")
  .action(checkNowCommand);

program.parseAsync(process.argv);
