/**
 * Section Tools – Steps tile build test
 *
 * Builds a tiles section with a single "steps" tile and verifies:
 *   - section created
 *   - steps replicator has 3 items, each with type:"step"
 *   - each step has non-empty title and text
 *   - step items have _id (required for Statamic meta lookup)
 *   - no browser console errors (including Statamic vendor render errors)
 */

import { chromium } from 'playwright';
import { readFileSync } from 'fs';

const CP_URL    = 'http://plastischechirurgie-frankfurt.test/cp';
const ENTRY_URL = `${CP_URL}/collections/pages/entries/50f8e858-8ca5-41f6-aee4-d11a792ab737`;
const EMAIL     = 'playwright@test.local';
const PASS      = 'PlaywrightTest123!';
const PANEL_ID  = 'section-tools-floating-panel';

const DOC_HTML = readFileSync(
  '/home/vadim/Desktop/html/laravel/plastischechirurgie-frankfurt/steps-build-test.html',
  'utf8'
);

let passed = 0, failed = 0;
function ok(label, cond, detail = '') {
  if (cond) { console.log(`  ✓  ${label}`); passed++; }
  else       { console.error(`  ✗  ${label}${detail ? ': ' + detail : ''}`); failed++; }
}

async function run() {
  console.log('\n=== Section Tools – Steps tile build test ===\n');

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
  const stepsTile = tiles.find((t) => t.type === 'steps');
  console.log('\n── Tile count:', tiles.length, '| steps tile found:', !!stepsTile);
  ok('steps tile present', !!stepsTile);

  // Deep structure checks on the steps replicator
  const steps = stepsTile?.steps ?? [];
  console.log('── steps array length:', steps.length);
  ok('steps array is non-empty', steps.length > 0, `got ${steps.length}`);
  ok('steps has 3 items', steps.length === 3, `got ${steps.length}`);

  console.log('\n── Per-step structure:');
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    console.log(`   step[${i}]:`, JSON.stringify(s)?.slice(0, 150));
    ok(`step[${i}] has type:"step"`, s?.type === 'step', `type="${s?.type}"`);
    ok(`step[${i}] has _id`, typeof s?._id === 'string' && s._id.length > 0, `_id=${JSON.stringify(s?._id)}`);
    ok(`step[${i}] title is non-empty string`, typeof s?.title === 'string' && s.title.length > 0, `title=${JSON.stringify(s?.title)}`);
    ok(`step[${i}] text is non-empty string`, typeof s?.text === 'string' && s.text.length > 0, `text=${JSON.stringify(s?.text)}`);
  }

  // Steps tile top-level fields
  ok('steps tile headline is string', typeof stepsTile?.headline === 'string', JSON.stringify(stepsTile?.headline));
  ok('steps tile headline not empty', (stepsTile?.headline?.length ?? 0) > 0);

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
