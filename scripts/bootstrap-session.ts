import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { config } from "../src/config/index.js";
import { logger } from "../src/shared/logger.js";

export interface BootstrapSessionOptions {
  promptUser?: boolean;
  sessionPath?: string;
  injectedContext?: BrowserContext;
  injectedBrowser?: Browser;
}

export interface BootstrapSessionResult {
  success: boolean;
  sessionPath: string;
  error?: string;
}

/**
 * Validates whether the browser context possesses a genuine authenticated Flipkart session.
 * Evaluates multiple signals:
 * 1. Presence of Flipkart domain cookies.
 * 2. Navigates to /account and verifies user is not redirected back to /account/login.
 * 3. Inspects DOM for logged-in profile indicators or absence of the unauthenticated login wall.
 */
export async function verifyFlipkartAuthentication(
  context: BrowserContext,
  page: Page
): Promise<boolean> {
  try {
    const cookies = await context.cookies(["https://www.flipkart.com"]);
    const hasFlipkartCookies = cookies.some((c) => c.domain.includes("flipkart.com"));
    if (!hasFlipkartCookies) {
      return false;
    }

    // Navigate to Flipkart account page to test access
    await page.goto("https://www.flipkart.com/account", {
      waitUntil: "domcontentloaded",
      timeout: 15000,
    });

    const currentUrl = page.url();
    if (currentUrl.includes("/account/login")) {
      return false;
    }

    const hasAccountIndicator = await page.evaluate(() => {
      const text = document.body ? document.body.innerText : "";
      return (
        text.includes("My Profile") ||
        text.includes("Manage Addresses") ||
        text.includes("PAN Card Information") ||
        text.includes("Logout") ||
        text.includes("Orders") ||
        !text.includes("Enter Email/Mobile number")
      );
    });

    return hasAccountIndicator;
  } catch {
    // If navigation throws, inspect existing URL and cookies
    try {
      const url = page.url();
      const cookies = await context.cookies(["https://www.flipkart.com"]);
      return !url.includes("/account/login") && cookies.length > 0;
    } catch {
      return false;
    }
  }
}

/**
 * Executes user-assisted interactive session bootstrap.
 * Saves storageState atomically with strict 0600 permissions.
 * Never prints or leaks sensitive cookies or tokens.
 */
export async function runSessionBootstrap(
  options?: BootstrapSessionOptions
): Promise<BootstrapSessionResult> {
  const targetSessionPath = options?.sessionPath || config.SESSION_STORAGE_PATH;
  const sessionDir = path.dirname(targetSessionPath);

  // Ensure target directory exists with restrictive 0700 permissions
  if (!fs.existsSync(sessionDir)) {
    fs.mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
  } else {
    try {
      fs.chmodSync(sessionDir, 0o700);
    } catch {}
  }

  let browser: Browser | null = options?.injectedBrowser || null;
  let context: BrowserContext | null = options?.injectedContext || null;
  let shouldCloseBrowser = false;
  let tempFilePath: string | null = null;

  try {
    if (!browser && !context) {
      shouldCloseBrowser = true;
      browser = await chromium.launch({
        headless: false,
        args: ["--no-sandbox", "--disable-setuid-sandbox"],
      });
      context = await browser.newContext({
        viewport: { width: 1280, height: 720 },
        userAgent:
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      });
    } else if (browser && !context) {
      context = await browser.newContext();
    }

    const page = await context!.newPage();

    const loginUrl = "https://www.flipkart.com/account/login";
    await page.goto(loginUrl, { waitUntil: "domcontentloaded", timeout: 45000 });

    if (options?.promptUser !== false) {
      console.log("\n-------------------------------------------------");
      console.log("ACTION REQUIRED:");
      console.log("1. In the opened browser window, log in to Flipkart via mobile number & OTP.");
      console.log("2. Complete any two-factor or security prompts directly in the browser.");
      console.log("3. Once logged in, return here and press ENTER to save your session.");
      console.log("   (Or press Ctrl+C to cancel; existing sessions will not be modified.)");
      console.log("-------------------------------------------------\n");

      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });

      await new Promise<void>((resolve) => {
        rl.question("Press ENTER after completing login in the browser: ", () => {
          rl.close();
          resolve();
        });
      });
    }

    const isAuthenticated = await verifyFlipkartAuthentication(context!, page);

    if (!isAuthenticated) {
      const errorMsg = "Authentication verification failed: No active Flipkart session detected.";
      logger.warn(errorMsg);
      return {
        success: false,
        sessionPath: targetSessionPath,
        error: errorMsg,
      };
    }

    // Save atomically to a temporary file in the same directory
    tempFilePath = path.join(
      sessionDir,
      `.flipkart_session.tmp.${process.pid}.${Date.now()}.json`
    );

    await context!.storageState({ path: tempFilePath });

    // Set restrictive 0600 file permissions on temporary file
    fs.chmodSync(tempFilePath, 0o600);

    // Atomically move to target destination
    fs.renameSync(tempFilePath, targetSessionPath);
    tempFilePath = null; // Clear so cleanup won't unlink destination

    // Enforce 0600 on destination
    fs.chmodSync(targetSessionPath, 0o600);

    logger.info(`Session successfully saved with 0600 permissions to: ${targetSessionPath}`);
    return {
      success: true,
      sessionPath: targetSessionPath,
    };
  } catch (error: any) {
    logger.error(`Error during session bootstrap: ${error.message}`);
    return {
      success: false,
      sessionPath: targetSessionPath,
      error: error.message,
    };
  } finally {
    // Delete temporary file if still exists
    if (tempFilePath && fs.existsSync(tempFilePath)) {
      try {
        fs.unlinkSync(tempFilePath);
      } catch {}
    }

    // Clean up browser resources if this script created them
    if (shouldCloseBrowser && browser) {
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
    process.argv[1].endsWith("bootstrap-session.ts") ||
    process.argv[1].endsWith("bootstrap-session.js"));

if (isDirectRun) {
  console.log("=================================================");
  console.log("       Flipkart Session Authentication Setup     ");
  console.log("=================================================");
  console.log(`Target Session Storage: ${config.SESSION_STORAGE_PATH}`);

  runSessionBootstrap({ promptUser: true }).then((result) => {
    if (result.success) {
      console.log(`\n🎉 Success! Authenticated session securely saved to: ${result.sessionPath}`);
      console.log("   Permissions: -rw------- (0600)");
      console.log("   Directory:   drwx------ (0700)");
      process.exit(0);
    } else {
      console.error(`\n❌ Session setup failed: ${result.error}`);
      console.error("Existing session files (if any) were preserved untouched.");
      process.exit(1);
    }
  });
}
