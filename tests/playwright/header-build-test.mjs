/**
 * Section Tools – Header build test
 *
 * Pastes header-build-test.html into the Document tab and clicks "Build page".
 * Verifies: type, image, H1 in text bard, button_book_page inside buttons bard set,
 * badges_group select value, and zero console errors.
 */

import { chromium } from 'playwright';
import { readFileSync } from 'fs';

const CP_URL    = 'http://plastischechirurgie-frankfurt.test/cp';
const ENTRY_URL = `${CP_URL}/collections/pages/entries/50f8e858-8ca5-41f6-aee4-d11a792ab737`;
const EMAIL     = 'playwright@test.local';
const PASS      = 'PlaywrightTest123!';
const PANEL_ID  = 'section-tools-floating-panel';

const DOC_HTML = readFileSync(
  '/home/vadim/Desktop/html/laravel/plastischechirurgie-frankfurt/header-build-test.html',
  'utf8'
);

let passed = 0, failed = 0;
function ok(label, cond, detail = '') {
  if (cond) { console.log(`  ✓  ${label}`); passed++; }
  else       { console.error(`  ✗  ${label}${detail ? ': ' + detail : ''}`); failed++; }
}

async function run() {
  console.log('\n=== Section Tools – Header build test ===\n');

  const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--no-sandbox'] });
  const page    = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  const consoleErrors = [];
  page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
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
  await page.waitForSelector(`#${PANEL_ID}`, { timeout: 10_000 });
  await page.waitForTimeout(3_000);
  console.log('Entry loaded ✓\n');
  consoleErrors.length = 0; // reset after page load noise

  // Switch to Document tab
  await page.evaluate((id) => {
    const panel = document.getElementById(id);
    Array.from(panel?.querySelectorAll('button') ?? [])
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

  // Click Build page
  console.log('Clicking "Build page"…');
  await page.locator(`#${PANEL_ID} button.btn-primary:has-text("Build")`).click();

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
  const toolErrors = toolLog.split('\n').filter((l) => l.includes('"error"'));
  if (toolErrors.length) console.log('── Tool errors:\n', toolErrors.join('\n'));

  // Read Vuex header state
  const h = await page.evaluate(() => {
    const pub  = window.Statamic?.$store?.state?.publish ?? {};
    const mod  = Object.values(pub).find((m) => m?.values != null);
    const item = (mod?.values?.header ?? [])[0] ?? null;
    if (!item) return null;

    const textArr        = Array.isArray(item.text) ? item.text : [];
    const hasH1          = textArr.some((n) => n?.type === 'heading' && n?.attrs?.level === 1);
    const buttonsSets    = textArr.filter((n) => n?.type === 'set' && n?.attrs?.values?.type === 'buttons');
    const bset           = buttonsSets[0]?.attrs?.values ?? null;
    const buttonItems    = bset?.buttons ?? [];

    return {
      type:            item.type,
      medium:          item.medium ?? [],
      textLength:      textArr.length,
      hasH1,
      buttonsSetsCount: buttonsSets.length,
      buttonsAlign:    bset?.align ?? null,
      buttonsItems:    buttonItems.map((b) => ({ type: b.type, _id: b._id })),
      badgesGroup:     item.badges_group,
    };
  });

  console.log('\n── Header:', JSON.stringify(h, null, 2));

  // Assertions
  ok('header item exists',                    !!h);
  ok('type is "header"',                      h?.type === 'header',                       String(h?.type));
  ok('medium is set',                         (h?.medium?.length ?? 0) > 0,               JSON.stringify(h?.medium));
  ok('medium uses assets:: prefix',           (h?.medium?.[0] ?? '').startsWith('assets::'), String(h?.medium?.[0]));
  ok('medium has correct image',              (h?.medium?.[0] ?? '').includes('istock_2157073168'), String(h?.medium?.[0]));
  ok('text bard has content',                 (h?.textLength ?? 0) > 0);
  ok('text bard has H1',                      h?.hasH1 === true);
  ok('text bard has buttons set',             (h?.buttonsSetsCount ?? 0) > 0);
  ok('buttons set has ≥1 button',             (h?.buttonsItems?.length ?? 0) > 0,         JSON.stringify(h?.buttonsItems));
  ok('button type is button_book_page',       (h?.buttonsItems ?? []).some((b) => b.type === 'button_book_page'), JSON.stringify(h?.buttonsItems));
  ok('badges_group is plain string',          typeof h?.badgesGroup === 'string',          JSON.stringify(h?.badgesGroup));
  ok('badges_group is "certificates_shortest"', h?.badgesGroup === 'certificates_shortest', String(h?.badgesGroup));

  // Console errors
  console.log('\n── Console errors:', consoleErrors.length);
  consoleErrors.forEach((e) => console.error('  ', e.slice(0, 200)));
  ok('no browser console errors',             consoleErrors.length === 0, `${consoleErrors.length} error(s)`);

  await browser.close();
  console.log(`\n${'─'.repeat(50)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((err) => { console.error('\nUnhandled error:', err.message, err.stack); process.exit(1); });
