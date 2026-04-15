/**
 * Run once to save your BC session locally.
 * Opens a visible browser – log in with MFA, navigate to BC,
 * then press Enter in the terminal. Session is saved to .auth/bc-state.json
 */

import { chromium } from "playwright";
import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";

const AUTH_STATE_PATH = path.join(__dirname, "../.auth/bc-state.json");

async function login() {
  const authDir = path.dirname(AUTH_STATE_PATH);
  if (!fs.existsSync(authDir)) fs.mkdirSync(authDir, { recursive: true });

  console.log("🔐 Starting BC login...");
  console.log("   Log in to the browser window that opens (MFA etc.)");
  console.log("   Press Enter here in the terminal once you are inside BC.\n");

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  const config = JSON.parse(
    fs.readFileSync(path.join(__dirname, "../config/rules.json"), "utf-8")
  );

  await page.goto(config.settings.bcUrl);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  await new Promise<void>((resolve) => {
    rl.question("Press Enter once you are logged in to BC > ", () => {
      rl.close();
      resolve();
    });
  });

  await context.storageState({ path: AUTH_STATE_PATH });
  console.log(`\n✅ Session saved to ${AUTH_STATE_PATH}`);
  console.log("   You can now run: npm run monitor\n");

  await browser.close();
}

login().catch(console.error);
