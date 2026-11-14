import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { config } from "../../config/index.js";
import { logger } from "../../shared/logger.js";
import { ScraperError } from "../../shared/errors.js";

let browserInstance: Browser | null = null;

export async function getBrowser(): Promise<Browser> {
  if (browserInstance && browserInstance.isConnected()) {
    return browserInstance;
  }

  try {
    logger.debug("Launching Playwright Chromium instance...");
    browserInstance = await chromium.launch({
      headless: config.BROWSER_HEADLESS,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-accelerated-2d-canvas",
        "--no-first-run",
        "--no-zygote",
        "--disable-gpu",
      ],
    });
    return browserInstance;
  } catch (error) {
    throw new ScraperError("Failed to launch Playwright browser instance", undefined, error);
  }
}

export async function createLightweightPage(): Promise<{ page: Page; context: BrowserContext }> {
  const browser = await getBrowser();
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    viewport: { width: 1280, height: 720 },
  });

  const page = await context.newPage();

  // Block images, fonts, and media to save bandwidth and memory on the VM
  await page.route("**/*", (route) => {
    const resourceType = route.request().resourceType();
    if (["image", "media", "font"].includes(resourceType)) {
      route.abort();
    } else {
      route.continue();
    }
  });

  return { page, context };
}

export async function closeBrowser(): Promise<void> {
  if (browserInstance) {
    try {
      await browserInstance.close();
      logger.debug("Browser instance closed.");
    } catch (error) {
      logger.error("Error closing browser instance", error);
    } finally {
      browserInstance = null;
    }
  }
}
