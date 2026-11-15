import fs from "node:fs";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { config } from "../../config/index.js";
import { logger } from "../../shared/logger.js";
import { ScraperError } from "../../shared/errors.js";

export interface CreatePageOptions {
  sessionStoragePath?: string;
  blockMedia?: boolean;
}

let browserInstance: Browser | null = null;
let launchPromise: Promise<Browser> | null = null;

/**
 * Returns the active Chromium browser instance or launches a new singleton instance.
 */
export async function getBrowser(): Promise<Browser> {
  if (browserInstance && browserInstance.isConnected()) {
    return browserInstance;
  }

  if (launchPromise) {
    return launchPromise;
  }

  launchPromise = (async () => {
    try {
      logger.debug("Launching Playwright Chromium instance...");
      browserInstance = await chromium.launch({
        headless: config.BROWSER_HEADLESS,
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--disable-gpu",
        ],
      });

      browserInstance.on("disconnected", () => {
        logger.debug("Playwright browser instance disconnected.");
        browserInstance = null;
      });

      return browserInstance;
    } catch (error) {
      browserInstance = null;
      throw new ScraperError("Failed to launch Playwright browser instance", undefined, error);
    } finally {
      launchPromise = null;
    }
  })();

  return launchPromise;
}

/**
 * Checks whether the singleton browser instance is currently running and connected.
 */
export function isBrowserRunning(): boolean {
  return Boolean(browserInstance && browserInstance.isConnected());
}

/**
 * Resolves the path to the session storage state file, if it exists on disk.
 * Returns null if the file does not exist or path is empty.
 * Note: Never logs file contents, cookies, or credentials.
 */
export function resolveSessionStoragePath(customPath?: string): string | null {
  const targetPath = customPath || config.SESSION_STORAGE_PATH;
  if (!targetPath) {
    return null;
  }

  try {
    if (fs.existsSync(targetPath)) {
      return targetPath;
    }
  } catch {
    return null;
  }

  return null;
}

/**
 * Creates an isolated browser context and page for an individual check.
 * Supports loading an optional existing Playwright storageState file.
 * Handles missing session file gracefully without inventing authentication.
 */
export async function createLightweightPage(
  options?: CreatePageOptions
): Promise<{ page: Page; context: BrowserContext }> {
  const browser = await getBrowser();

  const sessionPath = resolveSessionStoragePath(options?.sessionStoragePath);
  const contextOptions: Parameters<typeof browser.newContext>[0] = {
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    viewport: { width: 1280, height: 720 },
  };

  if (sessionPath) {
    logger.debug(`Loaded authenticated storageState from: ${sessionPath}`);
    contextOptions.storageState = sessionPath;
  } else {
    logger.debug("No session storage file found; creating unauthenticated browser context.");
  }

  const context = await browser.newContext(contextOptions);

  let page: Page;
  try {
    page = await context.newPage();
  } catch (error) {
    await context.close().catch(() => {});
    throw error;
  }

  // Block images, fonts, and media to save bandwidth and memory on the VM
  if (options?.blockMedia !== false) {
    try {
      await page.route("**/*", (route) => {
        const resourceType = route.request().resourceType();
        if (["image", "media", "font"].includes(resourceType)) {
          route.abort();
        } else {
          route.continue();
        }
      });
    } catch (error) {
      await closePageAndContext(page, context);
      throw error;
    }
  }

  return { page, context };
}

/**
 * Reliably closes an individual page and browser context.
 * Safe to call even if the page or context is already closed or null.
 */
export async function closePageAndContext(
  page?: Page | null,
  context?: BrowserContext | null
): Promise<void> {
  if (page) {
    try {
      if (!page.isClosed()) {
        await page.close();
      }
    } catch (error) {
      logger.debug(`Error closing page: ${(error as Error).message}`);
    }
  }

  if (context) {
    try {
      await context.close();
    } catch (error) {
      logger.debug(`Error closing browser context: ${(error as Error).message}`);
    }
  }
}

/**
 * Higher-order utility ensuring an isolated page and context close reliably in a finally block.
 */
export async function withIsolatedPage<T>(
  fn: (page: Page, context: BrowserContext) => Promise<T>,
  options?: CreatePageOptions
): Promise<T> {
  const { page, context } = await createLightweightPage(options);
  try {
    return await fn(page, context);
  } finally {
    await closePageAndContext(page, context);
  }
}

/**
 * Gracefully shuts down the singleton browser instance and cleans up resources.
 */
export async function closeBrowser(): Promise<void> {
  if (browserInstance) {
    const instance = browserInstance;
    browserInstance = null;
    try {
      if (instance.isConnected()) {
        await instance.close();
        logger.debug("Browser instance closed.");
      }
    } catch (error) {
      logger.error("Error closing browser instance", error);
    }
  }
}

/**
 * Internal helper for testing: resets browser singleton state.
 */
export function _resetBrowserForTesting(): void {
  browserInstance = null;
  launchPromise = null;
}
