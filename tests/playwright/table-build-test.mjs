/**
 * Section Tools – Table tile build test
 *
 * Builds a tiles section with a single "table" tile and verifies:
 *   - tiles section created
 *   - table replicator has at least one section item with type:"section"
 *   - each section has a headline (string) and rows (grid array) with label fields
 *   - no browser console errors
 */

import { chromium } from 'playwright';
import { readFileSync } from 'fs';

const CP_URL    = 'http://plastischechirurgie-frankfurt.test/cp';
const ENTRY_URL = `${CP_URL}/collections/pages/entries/50f8e858-8ca5-41f6-aee4-d11a792ab737`;
const EMAIL     = 'playwright@test.local';
const PASS      = 'PlaywrightTest123!';
const PANEL_ID  = 'section-tools-floating-panel';

const DOC_HTML = readFileSync(
  '/home/vadim/Desktop/html/laravel/plastischechirurgie-frankfurt/table-build-test.html',
  'utf8'
);

let passed = 0, failed = 0;
function ok(label, cond, detail = '') {
  if (cond) { console.log(`  ✓  ${label}`); passed++; }
  else       { console.error(`  ✗  ${label}${detail ? ': ' + detail : ''}`); failed++; }
}

async function run() {
  console.log('\n=== Section Tools – Table tile build test ===\n');

  const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--no-sandbox'] });
  const page    = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  const consoleErrors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => consoleErrors.push(`PAGE ERROR: ${err.message}`));

  // Login
  await page.goto(`${CP_URL}/auth/login`);
  await page.fill('input[name="email"]', EMAIL);
  await page.fill('input[name="password"]', PASS);
  await Promise.all([page.waitForNavigation({ timeout: 15_000 }), page.click('button[type="submit"]')]);
  if (page.url().includes('/auth/')) { console.error('Login failed'); await browser.close(); process.exit(1); }

  // Load entry
  await page.goto(ENTRY_URL);
  await page.waitForFunction(() => {
    const pub = window.Statamic?.$store?.state?.publish ?? {};
    return Object.values(pub).some((m) => m?.values && Object.keys(m.values).length > 0);
  }, { timeout: 30_000 });
  await page.waitForSelector(`#${PANEL_ID}`, { state: 'attached', timeout: 10_000 });
  await page.waitForTimeout(3_000);
  console.log('Entry loaded ✓\n');
  consoleErrors.length = 0;

  // Show panel
  await page.evaluate(() => {
    const panel = document.getElementById('section-tools-floating-panel');
    if (panel && panel.style.display === 'none') window.SectionTools?.togglePanel?.();
  });
  await page.waitForFunction(() => {
    const p = document.getElementById('section-tools-floating-panel');
    return p && p.style.display !== 'none';
  }, { timeout: 5_000 });

  // Switch to Document tab
  await page.evaluate((id) => {
    Array.from(document.getElementById(id)?.querySelectorAll('button') ?? [])
      .find((b) => b.textContent.trim().toUpperCase() === 'DOCUMENT')?.click();
  }, PANEL_ID);
  await page.waitForSelector(`#${PANEL_ID} .st-doc-bard`, { timeout: 8_000 });
  await page.waitForTimeout(500);

  // Set bard content
  const contentSet = await page.evaluate((html) => {
    const docBard = document.querySelector('.st-doc-bard');
    if (!docBard) return 'no .st-doc-bard found';
    function findEditorVm(el, depth = 0) {
      if (depth > 20) return null;
      if (el?.__vue__?.editor?.commands?.setContent) return el.__vue__;
      for (const child of Array.from(el?.children ?? [])) {
        const found = findEditorVm(child, depth + 1);
        if (found) return found;
      }
      return null;
    }
    const vm = findEditorVm(docBard);
    if (!vm) return 'no editor vm found';
    try { vm.editor.commands.setContent(html, false); return 'ok'; }
    catch (e) { return 'setContent error: ' + e.message; }
  }, DOC_HTML);
  ok('Bard content set', contentSet === 'ok', contentSet);

  // Click "clear and build"
  console.log('Clicking "clear and build"…');
  await page.locator(`#${PANEL_ID} button.btn-primary:has-text("clear and build")`).click();

  await page.waitForFunction(
    (id) => {
      const btn = Array.from(document.querySelectorAll(`#${id} button.btn-primary`))
                       .find((b) => b.textContent.trim() === 'Send');
      return btn?.disabled === true || document.querySelector(`#${id} textarea`)?.disabled === true;
    },
    PANEL_ID, { timeout: 10_000 }
  ).catch(() => {});

  console.log('Waiting for AI to finish (up to 5 min)…');
  await page.waitForFunction(
    (id) => {
      const btn = Array.from(document.querySelectorAll(`#${id} button.btn-primary`))
                       .find((b) => b.textContent.trim() === 'Send');
      return btn && !btn.disabled;
    },
    PANEL_ID, { timeout: 300_000 }
  );
  console.log('\nAI finished.\n');

  // Tool summary
  const toolLog = await page.evaluate((id) => {
    return Array.from(document.getElementById(id)?.querySelectorAll('[data-technical]') ?? [])
                .map((el) => el.innerText?.trim()).join('\n');
  }, PANEL_ID);
  const toolNames = {};
  for (const m of toolLog.matchAll(/^→ (\w+)\(/gm)) toolNames[m[1]] = (toolNames[m[1]] ?? 0) + 1;
  console.log('── Tools used:', JSON.stringify(toolNames));
  console.log('── Tool log:\n' + toolLog.slice(0, 4000));

  // Read sections from Vuex
  const sections = await page.evaluate(() => {
    const pub = window.Statamic?.$store?.state?.publish ?? {};
    const mod = Object.values(pub).find((m) => Array.isArray(m?.values?.sections));
    return mod?.values?.sections ?? [];
  });

  // Find tiles section
  const tilesSec = sections.find((s) => s.type === 'tiles');
  ok('tiles section created', !!tilesSec);

  const tiles = tilesSec?.tiles ?? [];
  const tableTile = tiles.find((t) => t.type === 'table');
  console.log('\n── Tile count:', tiles.length, '| table tile found:', !!tableTile);
  ok('table tile present', !!tableTile);

  // Deep structure checks on the table replicator
  const tableSections = tableTile?.table ?? [];
  console.log('── table sections array length:', tableSections.length);
  ok('table sections array is non-empty', tableSections.length > 0, `got ${tableSections.length}`);

  console.log('\n── Per-section structure:');
  for (let i = 0; i < tableSections.length; i++) {
    const sec = tableSections[i];
    console.log(`   section[${i}]:`, JSON.stringify({ type: sec?.type, headline: sec?.headline, rowCount: sec?.rows?.length })?.slice(0, 150));
    ok(`section[${i}] has type:"section"`, sec?.type === 'section', `type="${sec?.type}"`);
    ok(`section[${i}] headline is string`, typeof sec?.headline === 'string', `headline=${JSON.stringify(sec?.headline)}`);
    ok(`section[${i}] headline not empty`, (sec?.headline?.length ?? 0) > 0, `headline="${sec?.headline}"`);

    const rows = sec?.rows ?? [];
    ok(`section[${i}] has rows array`, Array.isArray(rows), `rows=${JSON.stringify(rows)}`);
    ok(`section[${i}] has at least 1 row`, rows.length > 0, `got ${rows.length} rows`);

    for (let j = 0; j < rows.length; j++) {
      const row = rows[j];
      ok(`section[${i}] row[${j}] is not null`, row != null, `got ${JSON.stringify(row)}`);
      ok(`section[${i}] row[${j}] label exists`, typeof row?.label === 'string' || row?.label != null,
        `label=${JSON.stringify(row?.label)}`);
    }
  }

  // Console errors (no Statamic vendor filter — clean render is part of the fix)
  console.log('\n── Console errors:', consoleErrors.length);
  consoleErrors.forEach((e) => console.error('  ', e.slice(0, 250)));
  ok('no browser console errors', consoleErrors.length === 0, `${consoleErrors.length} error(s)`);

  await browser.close();
  console.log(`\n${'─'.repeat(50)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((err) => { console.error('\nUnhandled error:', err.message, err.stack); process.exit(1); });
