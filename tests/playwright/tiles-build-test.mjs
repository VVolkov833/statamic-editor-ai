/**
 * Section Tools – Tiles section build test (all 10 tile types)
 *
 * Pastes tiles-build-test.html into the Document tab and clicks "clear and build".
 * Verifies: tiles section created, all 10 tile types present, key fields per type,
 * badges_group is a plain string (not object), no console errors.
 */

import { chromium } from 'playwright';
import { readFileSync } from 'fs';

const CP_URL    = 'http://plastischechirurgie-frankfurt.test/cp';
const ENTRY_URL = `${CP_URL}/collections/pages/entries/50f8e858-8ca5-41f6-aee4-d11a792ab737`;
const EMAIL     = 'playwright@test.local';
const PASS      = 'PlaywrightTest123!';
const PANEL_ID  = 'section-tools-floating-panel';

const DOC_HTML = readFileSync(
  '/home/vadim/Desktop/html/laravel/plastischechirurgie-frankfurt/tiles-build-test.html',
  'utf8'
);

const EXPECTED_TILE_TYPES = [
  'medium', 'text', 'quote', 'image_stack', 'anchor',
  'contact_compact', 'video_player', 'steps', 'icons', 'table',
];

let passed = 0, failed = 0;
function ok(label, cond, detail = '') {
  if (cond) { console.log(`  ✓  ${label}`); passed++; }
  else       { console.error(`  ✗  ${label}${detail ? ': ' + detail : ''}`); failed++; }
}

async function run() {
  console.log('\n=== Section Tools – Tiles section build test ===\n');

  const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--no-sandbox'] });
  const page    = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  const consoleErrors = [];
  // Ignore transient Vue render errors from Statamic's own vendor bundle (not our addon's code)
  const isStatamicVendorError = (text) => text.includes('vendor/statamic/cp/build/assets/app-');
  page.on('console', (msg) => {
    if (msg.type() === 'error' && !isStatamicVendorError(msg.text())) consoleErrors.push(msg.text());
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

  // Show panel (hidden by default since UI update)
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
  const toolErrors = toolLog.split('\n').filter((l) => l.includes('"error"'));
  if (toolErrors.length) console.log('── Tool errors:\n', toolErrors.slice(0, 10).join('\n'));

  // Read Vuex sections
  const sections = await page.evaluate(() => {
    const pub = window.Statamic?.$store?.state?.publish ?? {};
    const mod = Object.values(pub).find((m) => Array.isArray(m?.values?.sections));
    return mod?.values?.sections ?? [];
  });

  // Find tiles section
  const tilesSec = sections.find((s) => s.type === 'tiles');
  console.log('\n── Tiles section type:', tilesSec?.type ?? 'NOT FOUND');
  ok('tiles section created', !!tilesSec);

  const tiles = tilesSec?.tiles ?? [];
  console.log('── Tile count:', tiles.length);
  console.log('── Tile types:', tiles.map((t) => t.type).join(', '));
  ok(`all ${EXPECTED_TILE_TYPES.length} tiles created`, tiles.length === EXPECTED_TILE_TYPES.length, `got ${tiles.length}`);

  // All expected types present
  const actualTypes = new Set(tiles.map((t) => t.type));
  for (const type of EXPECTED_TILE_TYPES) {
    ok(`tile type "${type}" present`, actualTypes.has(type));
  }

  // Per-tile assertions — keyed by type
  const byType = {};
  for (const tile of tiles) byType[tile.type] = tile;

  console.log('\n── Per-tile field checks:');

  // medium — assets field handle is "medium", not "image"
  ok('medium: has media field', !!(byType.medium?.medium));

  // text
  ok('text: bard content is array', Array.isArray(byType.text?.text));
  ok('text: bard not empty', (byType.text?.text?.length ?? 0) > 0, String(byType.text?.text?.length));

  // quote
  ok('quote: text is string',  typeof byType.quote?.text === 'string',   JSON.stringify(byType.quote?.text)?.slice(0, 80));
  ok('quote: text not empty',  (byType.quote?.text?.length ?? 0) > 0);
  ok('quote: author is string', typeof byType.quote?.author === 'string', JSON.stringify(byType.quote?.author));
  ok('quote: author not empty', (byType.quote?.author?.length ?? 0) > 0);

  // image_stack — badges_group must be a plain string (select), not an object
  ok('image_stack: headline is string', typeof byType.image_stack?.headline === 'string');
  ok('image_stack: badges_group is plain string (not object)',
    typeof byType.image_stack?.badges_group === 'string',
    JSON.stringify(byType.image_stack?.badges_group)?.slice(0, 80));

  // anchor
  ok('anchor: title is string', typeof byType.anchor?.title === 'string');
  ok('anchor: title not empty', (byType.anchor?.title?.length ?? 0) > 0, String(byType.anchor?.title));

  // contact_compact
  ok('contact_compact: headline is string', typeof byType.contact_compact?.headline === 'string');
  ok('contact_compact: headline not empty', (byType.contact_compact?.headline?.length ?? 0) > 0);

  // video_player — field names may vary; check something asset-like exists
  const vp = byType.video_player ?? {};
  const vpHasPoster = !!(vp.poster_image ?? vp.poster ?? vp.image);
  const vpHasVideo  = !!(vp.video ?? vp.src ?? vp.video_src);
  ok('video_player: has poster asset', vpHasPoster, JSON.stringify(Object.keys(vp)));
  ok('video_player: has video asset',  vpHasVideo,  JSON.stringify(Object.keys(vp)));

  // steps
  ok('steps: headline is string', typeof byType.steps?.headline === 'string');
  ok('steps: steps is array', Array.isArray(byType.steps?.steps));
  ok('steps: 3 steps present', (byType.steps?.steps?.length ?? 0) === 3, `got ${byType.steps?.steps?.length}`);

  // icons
  ok('icons: icons is array', Array.isArray(byType.icons?.icons));
  ok('icons: 3 icon rows', (byType.icons?.icons?.length ?? 0) === 3, `got ${byType.icons?.icons?.length}`);

  // table
  ok('table: table field is array', Array.isArray(byType.table?.table));
  ok('table: has at least one section', (byType.table?.table?.length ?? 0) >= 1);
  const tableSection = byType.table?.table?.[0];
  ok('table: section has rows', Array.isArray(tableSection?.rows) && tableSection.rows.length > 0,
    `rows: ${JSON.stringify(tableSection?.rows?.length)}`);

  // Console errors
  console.log('\n── Console errors:', consoleErrors.length);
  consoleErrors.forEach((e) => console.error('  ', e.slice(0, 200)));
  ok('no browser console errors', consoleErrors.length === 0, `${consoleErrors.length} error(s)`);

  await browser.close();
  console.log(`\n${'─'.repeat(50)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((err) => { console.error('\nUnhandled error:', err.message, err.stack); process.exit(1); });
