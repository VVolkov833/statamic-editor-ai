/**
 * Section Tools – AI chat interaction test
 *
 * Actually uses the chat panel the way a user would:
 *   1. Asks what the meta title is  → brief should surface it without get_field
 *   2. Asks to add a test schema    → AI should use add_item, not get_blueprint
 *   3. Verifies the schema item appeared in the DOM / Vuex
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

/** Type into the chat textarea and click Send; return the assistant reply text. */
async function chat(page, message, { timeoutMs = 60_000 } = {}) {
  const textarea = page.locator(`#${PANEL_ID} textarea[placeholder*="Ask"]`);
  const sendBtn  = page.locator(`#${PANEL_ID} button.btn-primary:has-text("Send")`);

  await textarea.fill(message);
  await sendBtn.click();

  // Wait for in-flight
  await page.waitForFunction(
    (id) => document.querySelector(`#${id} textarea`)?.disabled === true,
    PANEL_ID, { timeout: 5_000 }
  ).catch(() => {});

  // Wait for response
  await page.waitForFunction(
    (id) => document.querySelector(`#${id} textarea`)?.disabled === false,
    PANEL_ID, { timeout: timeoutMs }
  );

  // Read all non-technical messages from the history div, newest last
  return page.evaluate((id) => {
    const panel   = document.getElementById(id);
    const history = panel?.querySelector('div[style*="overflow-y"]');
    if (!history) return '';
    // Non-technical = not [data-technical]
    const msgs = Array.from(history.children).filter((el) => !el.dataset.technical);
    return msgs.map((el) => el.innerText?.trim()).filter(Boolean).join('\n---\n');
  }, PANEL_ID);
}

/** Read the technical log (tool calls) from the chat history */
async function technicalLog(page) {
  return page.evaluate((id) => {
    const panel   = document.getElementById(id);
    const history = panel?.querySelector('div[style*="overflow-y"]');
    if (!history) return '';
    return Array.from(history.querySelectorAll('[data-technical]'))
      .map((el) => el.innerText?.trim()).join('\n');
  }, PANEL_ID);
}

async function run() {
  console.log('\n=== Section Tools – AI chat interaction test ===\n');

  const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--no-sandbox'] });
  const page    = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  // ── Login ─────────────────────────────────────────────────────────────────────
  await page.goto(`${CP_URL}/auth/login`);
  await page.fill('input[name="email"]', EMAIL);
  await page.fill('input[name="password"]', PASS);
  await Promise.all([page.waitForNavigation({ timeout: 15_000 }), page.click('button[type="submit"]')]);
  if (page.url().includes('/auth/')) { console.error('Login failed'); await browser.close(); process.exit(1); }
  console.log('Logged in ✓\n');

  // ── Load entry ────────────────────────────────────────────────────────────────
  await page.goto(ENTRY_URL);
  await page.waitForFunction(() => {
    const pub = window.Statamic?.$store?.state?.publish ?? {};
    return Object.values(pub).some((m) => m?.values && Object.keys(m.values).length > 0);
  }, { timeout: 30_000 });
  await page.waitForSelector(`#${PANEL_ID}`, { timeout: 10_000 });
  // Give blueprint pre-warm fetch a moment to complete
  await page.waitForTimeout(3_000);
  console.log('Entry edit loaded ✓\n');

  // ─────────────────────────────────────────────────────────────────────────────
  // TEST 1: meta_title should appear in the brief without needing get_field
  // ─────────────────────────────────────────────────────────────────────────────
  console.log('── Test 1: meta_title in brief ──');
  const reply1 = await chat(page, 'What is the current value of the meta_title field? Answer in one sentence.');
  const log1   = await technicalLog(page);

  console.log('  AI reply:', reply1.split('\n---\n').at(-1)?.slice(0, 120));
  console.log('  Tool log:', log1.slice(0, 200) || '(none)');

  ok('AI mentions meta_title value in reply', /plastisch|frankfurt|dr\.?\s*yun/i.test(reply1));
  ok('AI did NOT need get_field to find meta_title', !log1.includes('get_field'));

  // ─────────────────────────────────────────────────────────────────────────────
  // TEST 2: adding a schema item should NOT require get_blueprint first
  // ─────────────────────────────────────────────────────────────────────────────
  console.log('\n── Test 2: add schema item ──');

  // Record how many schema items exist before
  const schemasBefore = await page.evaluate(() => {
    const pub = window.Statamic?.$store?.state?.publish ?? {};
    const mod = Object.values(pub).find((m) => m?.values?.schemas != null);
    return (mod?.values?.schemas ?? []).length;
  });
  console.log(`  schemas before: ${schemasBefore}`);

  const reply2 = await chat(
    page,
    'Add a new schema_set item to the schemas field with schema_json set to {"@type":"Test"}. ' +
    'Use the brief to find the field — do not call get_blueprint unless you truly cannot find the field there.',
    { timeoutMs: 90_000 }
  );
  const log2 = await technicalLog(page);

  console.log('  AI reply:', reply2.split('\n---\n').at(-1)?.slice(0, 160));
  console.log('  Tool log:', log2.slice(-400) || '(none)');

  const schemasAfter = await page.evaluate(() => {
    const pub = window.Statamic?.$store?.state?.publish ?? {};
    const mod = Object.values(pub).find((m) => m?.values?.schemas != null);
    return (mod?.values?.schemas ?? []).length;
  });
  console.log(`  schemas after: ${schemasAfter}`);

  ok('schemas count increased by 1', schemasAfter === schemasBefore + 1, `${schemasBefore} → ${schemasAfter}`);
  ok('AI did NOT call get_blueprint unnecessarily',
    !log2.includes('→ get_blueprint') ||
    // acceptable if it called get_blueprint AFTER already knowing the field (for type lookup)
    log2.indexOf('→ add_item') < log2.indexOf('→ get_blueprint'),
    'get_blueprint was called before add_item'
  );

  // ─────────────────────────────────────────────────────────────────────────────
  // TEST 3: the new schema item has schema_json set in Vuex
  // ─────────────────────────────────────────────────────────────────────────────
  console.log('\n── Test 3: schema_json value in Vuex ──');
  const latestSchema = await page.evaluate(() => {
    const pub = window.Statamic?.$store?.state?.publish ?? {};
    const mod = Object.values(pub).find((m) => m?.values?.schemas != null);
    const arr = mod?.values?.schemas ?? [];
    return arr[arr.length - 1] ?? null;
  });
  console.log('  Latest schema item:', JSON.stringify(latestSchema)?.slice(0, 200));
  ok('schema_json field is present on new item', latestSchema?.schema_json != null, JSON.stringify(latestSchema));
  // code field stores { code: "...", mode: "..." } in Vuex; fall back to plain string too
  const schemaCode = latestSchema?.schema_json?.code ?? latestSchema?.schema_json ?? '';
  ok('schema_json contains @type', String(schemaCode).includes('@type'));

  // ── Done ─────────────────────────────────────────────────────────────────────
  await browser.close();
  console.log(`\n${'─'.repeat(46)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run().catch((err) => {
  console.error('\nUnhandled error:', err.message);
  console.error(err.stack);
  process.exit(1);
});
