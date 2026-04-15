import { chromium, Browser, Page, BrowserContext, FrameLocator } from "playwright";
import * as fs from "fs";
import * as path from "path";

// ─── Types ───────────────────────────────────────────────────────────────────

interface Rule {
  id: string;
  description: string;
  matchContains: string[];
  action: "requeue" | "manual" | "nshift";
  slackEmoji: string;
  allowedCustomerIds?: string[]; // kun for action: "nshift"
}

interface Settings {
  bcUrl: string;
  logPageUrl: string;
  postedShipmentPageUrl: string;
  slackChannelId: string;
  maxRetries: number;
  headless: boolean;
}

interface Config {
  rules: Rule[];
  settings: Settings;
}

interface LogEntry {
  rowkey: string;
  logNo: string;
  sourceRecord: string;
  status: string;
  message: string;
  outData: string;
  matchedRule: Rule | null;
}

interface RunResult {
  processed: number;
  requeued: number;
  manual: number;
  nshift: number;
  skipped: number;
  entries: Array<{ entry: LogEntry; action: string }>;
}

// ─── Config ──────────────────────────────────────────────────────────────────

const configPath = path.join(__dirname, "../config/rules.json");
const config: Config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
const { rules, settings } = config;

const AUTH_STATE_PATH = path.join(__dirname, "../.auth/bc-state.json");
const SLACK_WEBHOOK = process.env.SLACK_WEBHOOK_URL;
const isHeadless = process.env.HEADLESS !== "false";

// ─── Slack ───────────────────────────────────────────────────────────────────

async function postSlack(result: RunResult): Promise<void> {
  if (!SLACK_WEBHOOK && !process.env.SLACK_BOT_TOKEN) {
    console.log("No Slack config – skipping notification");
    return;
  }
  if (result.processed === 0) return;

  const lines: string[] = [];
  lines.push(`*BC Integrasjonslogg – automatisk retting*`);
  lines.push(`📊 Sjekket: ${result.processed} feilede jobber`);
  if (result.requeued > 0) lines.push(`🔄 Satt tilbake i kø: ${result.requeued}`);
  if (result.manual > 0) lines.push(`🔧 Manuelt behandlet: ${result.manual}`);
  if (result.nshift > 0) lines.push(`🚚 nShift markert sendt: ${result.nshift}`);
  if (result.skipped > 0) lines.push(`⚠️ Ikke matchet (krever manuell sjekk): ${result.skipped}`);

  if (result.entries.length > 0) {
    lines.push(``);
    lines.push(`*Detaljer:*`);
    for (const { entry, action } of result.entries) {
      const emoji = entry.matchedRule?.slackEmoji ?? "⚠️";
      lines.push(`${emoji} \`${entry.sourceRecord || entry.logNo}\` → ${action}`);
      if (entry.matchedRule) lines.push(`   _${entry.matchedRule.description}_`);
    }
  }

  const message = lines.join("\n");

  if (SLACK_WEBHOOK) {
    const res = await fetch(SLACK_WEBHOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: message }),
    });
    if (!res.ok) console.error("Slack webhook feil:", res.status);
    return;
  }

  const res = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
    },
    body: JSON.stringify({ channel: settings.slackChannelId, text: message }),
  });
  if (!res.ok) console.error("Slack API feil:", res.status);
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

async function loadOrCreateAuthState(browser: Browser): Promise<BrowserContext> {
  const authDir = path.dirname(AUTH_STATE_PATH);
  if (!fs.existsSync(authDir)) fs.mkdirSync(authDir, { recursive: true });

  if (fs.existsSync(AUTH_STATE_PATH)) {
    console.log("Bruker lagret auth state...");
    return browser.newContext({ storageState: AUTH_STATE_PATH });
  }

  console.log("\n⚠️  Ingen lagret sesjon. Kjør: npm run login\n");
  process.exit(1);
}

// ─── Match rule ───────────────────────────────────────────────────────────────

function matchRule(message: string): Rule | null {
  for (const rule of rules) {
    for (const pattern of rule.matchContains) {
      if (message.toLowerCase().includes(pattern.toLowerCase())) return rule;
    }
  }
  return null;
}

// ─── Ekstraher følgeseddelnummer fra feilmelding ──────────────────────────────

function extractShipmentNo(message: string): string | null {
  // Matcher f.eks. "Sales Shipment(s) F821649 to nShift"
  const match = message.match(/Sales Shipment\(s\)\s+([A-Z0-9-]+)\s+to/i);
  return match ? match[1] : null;
}

// ─── Ekstraher kundenummer fra Ut-data JSON ───────────────────────────────────

function extractCustomerId(outData: string): string | null {
  try {
    const parsed = JSON.parse(outData);
    // Støtter både array og objekt
    const obj = Array.isArray(parsed) ? parsed[0] : parsed;
    return obj?.customerId?.toString() || obj?.customer?.customerId?.toString() || null;
  } catch {
    // Prøv regex som fallback
    const match = outData.match(/"customerId"\s*:\s*"?(\d+)"?/);
    return match ? match[1] : null;
  }
}

// ─── BC iframe ───────────────────────────────────────────────────────────────

async function getBCFrame(page: Page): Promise<FrameLocator> {
  await page.waitForSelector("iframe.designer-client-frame", { timeout: 20000 });
  const frame = page.frameLocator("iframe.designer-client-frame");

  await Promise.race([
    frame.locator("tr[rowkey]").first().waitFor({ timeout: 20000 }),
    frame.locator("text=Det finnes ikke noe å vise").waitFor({ timeout: 20000 }),
    frame.locator("text=There is nothing to show").waitFor({ timeout: 20000 }),
  ]).catch(() => {});

  return frame;
}

// ─── Les loggoppføringer ──────────────────────────────────────────────────────

async function readLogEntries(page: Page): Promise<LogEntry[]> {
  await page.goto(settings.logPageUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(5000);

  const frame = await getBCFrame(page);

  const entries = await frame.locator("tr[rowkey]").evaluateAll((rows) => {
    return rows.map((row) => {
      const cells = Array.from(row.querySelectorAll("td"));
      const getText = (i: number) => (cells[i] as HTMLElement)?.innerText?.trim() || "";
      return {
        rowkey: row.getAttribute("rowkey") || "",
        logNo: getText(2),
        sourceRecord: getText(4),
        status: getText(29),
        message: getText(33),
        outData: getText(36), // Ut-data kolonnen
      };
    }).filter((r) => r.logNo);
  });

  return entries.map((e) => ({ ...e, matchedRule: matchRule(e.message) }));
}

// ─── Klikk action-knapp i BC ─────────────────────────────────────────────────

async function clickBCAction(frame: FrameLocator, actionLabels: string[]): Promise<boolean> {
  for (const label of actionLabels) {
    const btn = frame.locator(`button:has-text("${label}"), a:has-text("${label}"), [title="${label}"]`).first();
    if (await btn.count() > 0) {
      await btn.click();
      await frame.locator("body").waitFor();
      return true;
    }
  }
  return false;
}

// ─── Åpne rad i kortvisning ───────────────────────────────────────────────────

async function openRow(frame: FrameLocator, entry: LogEntry): Promise<boolean> {
  const link = frame.locator(`a[title="Åpne detaljer for Loggnr. ${entry.logNo}"]`).first();
  if (await link.count() === 0) {
    console.warn(`  ⚠️  Fant ikke "Åpne detaljer"-lenke for LogNo=${entry.logNo}`);
    return false;
  }
  await link.click();
  await frame.locator("text=Manuelt sjekket").first().waitFor({ timeout: 10000 }).catch(() => {});
  return true;
}

// ─── Sett rad tilbake i kø ────────────────────────────────────────────────────

async function requeueEntry(page: Page, entry: LogEntry): Promise<boolean> {
  try {
    const frame = await getBCFrame(page);
    const opened = await openRow(frame, entry);
    if (!opened) return false;

    const cardFrame = page.frameLocator("iframe.designer-client-frame");
    const found = await clickBCAction(cardFrame, [
      "Sett i kø", "Set to Queue", "Sett tilbake i kø", "Requeue", "Tilbake til kø",
    ]);

    if (!found) {
      console.warn(`  ⚠️  Fant ikke "Sett i kø"-knapp for LogNo=${entry.logNo}`);
      return false;
    }

    console.log(`  ✅ Requeued: ${entry.sourceRecord || entry.logNo}`);
    return true;
  } catch (err) {
    console.error(`  ❌ Feil ved requeue av ${entry.logNo}:`, err);
    return false;
  }
}

// ─── Sett rad som manuelt sjekket ────────────────────────────────────────────

async function markManual(page: Page, entry: LogEntry): Promise<boolean> {
  try {
    const frame = await getBCFrame(page);
    const opened = await openRow(frame, entry);
    if (!opened) return false;

    const cardFrame = page.frameLocator("iframe.designer-client-frame");
    const found = await clickBCAction(cardFrame, [
      "Manuelt sjekket",
      "Kontrolleres manuelt",
      "Manuelt behandlet",
      "Sett til manuell",
      "Manual",
    ]);

    if (!found) {
      console.warn(`  ⚠️  Fant ikke "Manuelt sjekket"-knapp for LogNo=${entry.logNo}`);
      return false;
    }

    console.log(`  ✅ Marked manual: ${entry.sourceRecord || entry.logNo}`);
    return true;
  } catch (err) {
    console.error(`  ❌ Feil ved manual-marking av ${entry.logNo}:`, err);
    return false;
  }
}

// ─── nShift: marker følgeseddel som sendt + logg som manuelt sjekket ──────────

async function handleNShift(page: Page, entry: LogEntry, rule: Rule): Promise<boolean> {
  try {
    // 1. Ekstraher følgeseddelnummer fra feilmelding
    const shipmentNo = extractShipmentNo(entry.message);
    if (!shipmentNo) {
      console.warn(`  ⚠️  Kunne ikke ekstrahere følgeseddelnummer fra melding`);
      return false;
    }

    console.log(`  🚚 nShift-feil: følgeseddel ${shipmentNo} – åpner Bokførte følgesedler`);

    // 2. Naviger til Bokførte følgesedler (listevisning)
    await page.goto(settings.postedShipmentPageUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(3000);

    const shipFrame = page.frameLocator("iframe.designer-client-frame");
    await shipFrame.locator("tr[rowkey]").first().waitFor({ timeout: 15000 }).catch(() => {});

    // 3. Les kundenummer fra raden som matcher følgeseddelnummeret (kolonne 5)
    const customerId = await shipFrame.locator("tr[rowkey]").evaluateAll((rows, sNo) => {
      for (const row of rows) {
        const cells = Array.from(row.querySelectorAll("td"));
        const no = (cells[2] as HTMLElement)?.innerText?.trim();
        if (no === sNo) {
          return (cells[5] as HTMLElement)?.innerText?.trim() || null;
        }
      }
      return null;
    }, shipmentNo).catch(() => null);

    if (!customerId) {
      console.warn(`  ⚠️  Kunne ikke lese kundenummer fra Bokførte følgesedler`);
      return false;
    }

    // 4. Sjekk om kunden er i tillatt liste
    const allowedIds = rule.allowedCustomerIds || [];
    if (!allowedIds.includes(customerId)) {
      console.log(`  ⏭️  Kundenummer ${customerId} er ikke i tillatt liste – hopper over`);
      return false;
    }

    console.log(`  ✅ Kunde ${customerId} er i tillatt liste – fortsetter`);

    // 5. Klikk "Åpne posten FXXXXXX" for å åpne kortvisningen
    const openBtn = shipFrame.locator(`button[title="Åpne posten ${shipmentNo}"], a[title="Åpne posten ${shipmentNo}"]`).first();
    if (await openBtn.count() === 0) {
      console.warn(`  ⚠️  Fant ikke "Åpne posten ${shipmentNo}"-knapp`);
      return false;
    }
    await openBtn.click();
    await page.waitForTimeout(2000);

    // 6. Sjekk om følgeseddelen allerede er markert som Sent to nShift
    const cardFrame = page.frameLocator("iframe.designer-client-frame");

    const alreadySent = await cardFrame.locator("text=Mark as NOT Sent to nShift").count() > 0;
    if (alreadySent) {
      console.log(`  ℹ️  Følgeseddel ${shipmentNo} er allerede markert som Sent to nShift – hopper over`);
    } else {
      const marked = await clickBCAction(cardFrame, [
        "Mark as Sent to nShift",
        "Merk som sendt til nShift",
      ]);
      if (!marked) {
        console.warn(`  ⚠️  Fant ikke "Mark as Sent to nShift"-knapp for ${shipmentNo}`);
        return false;
      }
      console.log(`  ✅ Følgeseddel ${shipmentNo} markert som Sent to nShift`);
    }

    // 7. Gå tilbake til integrasjonsloggen og sett raden til Manuelt sjekket
    await page.goto(settings.logPageUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(3000);

    const logFrame = await getBCFrame(page);

    // Klikk "Åpne detaljer for Loggnr. XXXXX" – samme lenke som i listevisningen
    const detailLink = logFrame.locator(`a[title="Åpne detaljer for Loggnr. ${entry.logNo}"]`).first();
    if (await detailLink.count() === 0) {
      console.warn(`  ⚠️  Fant ikke "Åpne detaljer"-lenke for LogNo=${entry.logNo}`);
      return false;
    }
    await detailLink.click();
    await page.waitForTimeout(2000);

    // Klikk "Manuelt sjekket" i kortvisningen
    const logCardFrame = page.frameLocator("iframe.designer-client-frame");
    const manuellySjekket = await clickBCAction(logCardFrame, ["Manuelt sjekket"]);

    if (!manuellySjekket) {
      console.warn(`  ⚠️  Fant ikke "Manuelt sjekket"-knapp for LogNo=${entry.logNo}`);
      return false;
    }

    console.log(`  ✅ LogNo ${entry.logNo} satt til Manuelt sjekket`);
    return true;

  } catch (err) {
    console.error(`  ❌ Feil ved nShift-håndtering av ${entry.logNo}:`, err);
    return false;
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("🚀 BC Oseberg Monitor starter...");
  console.log(`📋 Laster ${rules.length} regel(er) fra config`);

  const browser = await chromium.launch({ headless: isHeadless });
  const context = await loadOrCreateAuthState(browser);
  const page = await context.newPage();

  const result: RunResult = {
    processed: 0, requeued: 0, manual: 0, nshift: 0, skipped: 0, entries: [],
  };

  try {
    console.log("\n📖 Leser integrasjonslogg (feilede jobber)...");
    const entries = await readLogEntries(page);

    if (entries.length === 0) {
      console.log("✅ Ingen feilede jobber funnet.");
      await browser.close();
      return;
    }

    console.log(`\n🔍 Fant ${entries.length} feilede jobb(er):\n`);
    result.processed = entries.length;

    for (const entry of entries) {
      console.log(`  → LogNo ${entry.logNo} | ${entry.sourceRecord}`);
      console.log(`    Melding: ${entry.message.substring(0, 100)}`);

      if (!entry.matchedRule) {
        console.log(`    ⚠️  Ingen regel matchet – hopper over`);
        result.skipped++;
        result.entries.push({ entry, action: "⚠️ Ikke matchet – manuell sjekk" });
        continue;
      }

      console.log(`    📌 Regel: ${entry.matchedRule.id} → ${entry.matchedRule.action}`);

      let ok = false;

      if (entry.matchedRule.action === "requeue") {
        ok = await requeueEntry(page, entry);
        if (ok) { result.requeued++; result.entries.push({ entry, action: "Satt i kø" }); }
      } else if (entry.matchedRule.action === "manual") {
        ok = await markManual(page, entry);
        if (ok) { result.manual++; result.entries.push({ entry, action: "Manuelt behandlet" }); }
      } else if (entry.matchedRule.action === "nshift") {
        ok = await handleNShift(page, entry, entry.matchedRule);
        if (ok) { result.nshift++; result.entries.push({ entry, action: "nShift markert sendt + manuelt sjekket" }); }
      }

      // Tilbake til listen etter hver handling
      await page.goto(settings.logPageUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
      await page.waitForTimeout(2000);
    }

    await context.storageState({ path: AUTH_STATE_PATH });

  } catch (err) {
    console.error("❌ Uventet feil:", err);
    const url = page.url();
    if (url.includes("login.microsoftonline") || url.includes("login.live")) {
      console.log("⚠️  Sesjonen er utløpt. Kjør: npm run login");
      if (fs.existsSync(AUTH_STATE_PATH)) fs.unlinkSync(AUTH_STATE_PATH);
    }
  } finally {
    await browser.close();
  }

  console.log("\n─────────────────────────────────");
  console.log(`✅ Ferdig!`);
  console.log(`   Sjekket:        ${result.processed}`);
  console.log(`   Satt i kø:      ${result.requeued}`);
  console.log(`   Manuell:        ${result.manual}`);
  console.log(`   nShift rettet:  ${result.nshift}`);
  console.log(`   Ikke matchet:   ${result.skipped}`);
  console.log("─────────────────────────────────\n");

  await postSlack(result);
}

main().catch(console.error);
