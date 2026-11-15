import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { config } from "../src/config/index.js";
import { logger } from "../src/shared/logger.js";
import { verifyFlipkartAuthentication } from "./bootstrap-session.js";

export interface VerifySessionResult {
  success: boolean;
  error?: string;
}

/**
 * Validates an existing Flipkart session storage file in a headless browser environment.
 * Ensures Playwright browser resources are cleaned up deterministically in a finally block.
 */
export async function verifySessionFile(
  customPath?: string
): Promise<VerifySessionResult> {
  const targetPath = customPath || config.SESSION_STORAGE_PATH;
  const resolvedPath = path.isAbsolute(targetPath)
    ? targetPath
    : path.resolve(process.cwd(), targetPath);

  logger.info(`Verifying session storage file at: ${resolvedPath}`);

  if (!fs.existsSync(resolvedPath)) {
    const errorMsg = `Session storage file does not exist at: ${resolvedPath}`;
    logger.warn(errorMsg);
    return {
      success: false,
      error: errorMsg,
    };
  }

  // Check file permissions on POSIX systems
  try {
    const stats = fs.statSync(resolvedPath);
    const mode = stats.mode & 0o777;
    if (mode !== 0o600 && process.platform !== "win32") {
      logger.warn(
        `Session file permissions (${mode.toString(8)}) are not restrictive. Recommended: chmod 600 ${resolvedPath}`
      );
    }
  } catch (error) {
    logger.debug("Could not inspect session file permissions", error);
  }

  let browser: Browser | null = null;
  let context: BrowserContext | null = null;
  let page: Page | null = null;

  try {
    const launchArgs = [
      "--disable-dev-shm-usage",
      "--disable-gpu",
    ];

    if (config.BROWSER_NO_SANDBOX) {
      launchArgs.unshift("--no-sandbox", "--disable-setuid-sandbox");
    }

    browser = await chromium.launch({
      headless: true,
      args: launchArgs,
    });

    context = await browser.newContext({
      storageState: resolvedPath,
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      viewport: { width: 1280, height: 720 },
    });

    page = await context.newPage();

    const isAuthenticated = await verifyFlipkartAuthentication(context, page);

    if (isAuthenticated) {
      logger.info("Session verified successfully: Flipkart session is valid and authenticated.");
      return { success: true };
    } else {
      const errorMsg = "Session verification failed: Stored session cookies are invalid or expired.";
      logger.warn(errorMsg);
      return {
        success: false,
        error: errorMsg,
      };
    }
  } catch (error: any) {
    const errorMsg = `Error encountered during headless session verification: ${error.message}`;
    logger.error(errorMsg, error);
    return {
      success: false,
      error: errorMsg,
    };
  } finally {
    // Guarantees all browser resources close before returning
    if (page) {
      try {
        if (!page.isClosed()) {
          await page.close();
        }
      } catch {}
    }

    if (context) {
      try {
        await context.close();
      } catch {}
    }

    if (browser) {
      try {
        await browser.close();
      } catch {}
    }
  }
}

// Direct CLI execution entry point
const isDirectRun =
  process.argv[1] &&
  (fileURLToPath(import.meta.url) === path.resolve(process.argv[1]) ||
    process.argv[1].endsWith("verify-session.ts") ||
    process.argv[1].endsWith("verify-session.js"));

if (isDirectRun) {
  console.log("=================================================");
  console.log("       Flipkart Headless Session Verification    ");
  console.log("=================================================");
  console.log(`Target Session Storage: ${config.SESSION_STORAGE_PATH}`);

  verifySessionFile().then((result) => {
    if (result.success) {
      console.log("\n🎉 Session verification successful! Authenticated cookies are active.");
      process.exit(0);
    } else {
      console.error(`\n❌ Session verification failed: ${result.error}`);
      console.error("Please re-authenticate locally using 'npm run auth:login' and re-copy the session file.");
      process.exit(1);
    }
  }).catch((err) => {
    console.error(`\n❌ Fatal error: ${err.message}`);
    process.exit(1);
  });
}
