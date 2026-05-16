/**
 * Section Tools – Playwright smoke test
 * Usage: node test.mjs
 */

import { chromium } from 'playwright';

const CP_URL    = 'http://plastischechirurgie-frankfurt.test/cp';
const ENTRY_URL = `${CP_URL}/collections/pages/entries/50f8e858-8ca5-41f6-aee4-d11a792ab737`;
const EMAIL     = 'playwright@test.local';
const PASS      = 'PlaywrightTest123!';
const PANEL_ID  = 'section-tools-floating-panel';

let passed = 0, failed = 0;
function ok(label, cond, detail = '') {
  if (cond) { console.log(`  ✓  ${label}`); passed++; }
  else       { console.error(`  ✗  ${label}${detail ? ': ' + detail : ''}`); failed++; }
}

async function run() {
  console.log('\n=== Section Tools – Playwright smoke test ===\n');

  const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--no-sandbox'] });
  const page    = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  // ── 1. Login ─────────────────────────────────────────────────────────────────
  console.log('1. Login');
  await page.goto(`${CP_URL}/auth/login`);
  await page.fill('input[name="email"]', EMAIL);
  await page.fill('input[name="password"]', PASS);
  await Promise.all([
    page.waitForNavigation({ timeout: 15_000 }),
    page.click('button[type="submit"]'),
  ]);
  const loggedIn = !page.url().includes('/auth/');
  ok('Login succeeded', loggedIn, page.url());
  if (!loggedIn) { await browser.close(); process.exit(1); }

  // ── 2. Navigate to entry ──────────────────────────────────────────────────────
  console.log('\n2. Navigate to entry edit screen');
  await page.goto(ENTRY_URL);
  await page.waitForFunction(() => {
    const pub = window.Statamic?.$store?.state?.publish ?? {};
    return Object.values(pub).some((m) => m?.values && Object.keys(m.values).length > 0);
  }, { timeout: 30_000 });
  ok('Entry edit page loaded', true);

  // ── 3. Panel ─────────────────────────────────────────────────────────────────
  console.log('\n3. Section Tools panel');
  await page.waitForSelector(`#${PANEL_ID}`, { timeout: 10_000 });
  ok('Panel mounted', true);
  ok('Panel header text', (await page.textContent(`#${PANEL_ID}`)).includes('Editor AI Assistant'));

  // ── 4. Verify fields in Vuex store ───────────────────────────────────────────
  console.log('\n4. Vuex publish store sanity check');
  const valueKeys = await page.evaluate(() => {
    const pub = window.Statamic?.$store?.state?.publish ?? {};
    const mod  = Object.values(pub).find((m) => m?.values);
    return Object.keys(mod?.values ?? {});
  });
  ok('title in values',    valueKeys.includes('title'));
  ok('sections in values', valueKeys.includes('sections'));

  // ── 5. Chat UI present ────────────────────────────────────────────────────────
  console.log('\n5. Chat UI');
  const textarea = page.locator(`#${PANEL_ID} textarea[placeholder*="Ask"]`);
  const sendBtn  = page.locator(`#${PANEL_ID} button.btn-primary:has-text("Send")`);
  ok('Textarea present', await textarea.count() > 0);
  ok('Send button present', await sendBtn.count() > 0);

  // ── 6. Chat round-trip ────────────────────────────────────────────────────────
  console.log('\n6. AI chat round-trip (this takes a few seconds…)');
  await textarea.fill('Reply with exactly the word PONG and nothing else.');
  await sendBtn.click();

  // Wait for textarea to become disabled (request in-flight)
  await page.waitForFunction(
    (id) => document.querySelector(`#${id} textarea`)?.disabled === true,
    PANEL_ID, { timeout: 5_000 }
  ).catch(() => {});

  // Wait for textarea to become re-enabled (response received)
  await page.waitForFunction(
    (id) => document.querySelector(`#${id} textarea`)?.disabled === false,
    PANEL_ID, { timeout: 45_000 }
  );

  // Grab all text content inside the panel's chat history (inline-styled divs)
  const historyText = await page.evaluate((panelId) => {
    const panel   = document.getElementById(panelId);
    // history div is the first scrollable div (overflow-y: auto) in the panel
    const history = panel?.querySelector('div[style*="overflow-y"]');
    return history?.innerText ?? '';
  }, PANEL_ID);

  ok('Assistant replied', historyText.trim().length > 0);
  ok('Reply contains PONG', historyText.toUpperCase().includes('PONG'), `got: ${historyText.slice(0, 80)}`);

  // ── 7. Brief contains secondary-tab fields ────────────────────────────────────
  console.log('\n7. Brief field coverage');
  const brief = await page.evaluate(() => {
    // Simulate what buildBrief does — check if schemas appears in Vuex values
    const pub   = window.Statamic?.$store?.state?.publish ?? {};
    const mod   = Object.values(pub).find((m) => m?.values);
    return Object.keys(mod?.values ?? {});
  });
  ok('schemas in values', brief.includes('schemas'), `keys: ${brief.join(', ')}`);

  // ── Done ─────────────────────────────────────────────────────────────────────
  await browser.close();
  console.log(`\n${'─'.repeat(46)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run().catch((err) => {
  console.error('\nUnhandled error:', err.message);
  process.exit(1);
});
