/**
 * Section Tools – AI deep nesting test
 *
 * Tests AI assistant on section types and nesting depths not covered by ai-field-coverage.mjs.
 * Runs across 3 entries, each adding unique section types or nesting scenarios.
 *
 * ── Entry 1: asiatische-lid-op.md ────────────────────────────────────────────
 * Adds: media_listing, tabs_filter, sets embedded inside tile bard text
 *
 *   media_listing  mf2ialut — youtube item mf2iaon8 (headline + video URL)
 *   tiles          m5upqvmu — tile m5uprn1e has a {buttons} set in its bard text
 *   tabs_filter    m6qu5bo1 — 5 filter tabs with labels "A→B", "A→C", …
 *
 * ── Entry 2: home.md ─────────────────────────────────────────────────────────
 * Adds: tile with TWO embedded sets (badges_in_text + buttons) — depth-3 read
 *
 *   tiles  mei9zbpu — tile mei9zfhl has badges_in_text and buttons sets in bard
 *
 * ── Entry 3: unser-team.md ───────────────────────────────────────────────────
 * Adds: team section (inline nested entries, not replicator references)
 *
 *   team  mejqnlvx — 2 team members (Marilena Ackermann, Lisa Schoch)
 */

import { chromium } from 'playwright';

const CP_URL = 'http://plastischechirurgie-frankfurt.test/cp';
const EMAIL  = 'playwright@test.local';
const PASS   = 'PlaywrightTest123!';
const PANEL_ID = 'section-tools-floating-panel';

const ENTRIES = {
  asiatische: '71a83be8-f2cb-4bb0-ba9a-04df80c14183',
  home:       '05ab021b-a407-4b86-a676-ea4935379362',
  team:       '5ec1a880-a69d-4d0c-9e67-69d16979503e',
};

// Section / item IDs in asiatische-lid-op.md
const AID = {
  media_listing:  'mf2ialut',
  media_youtube:  'mf2iaon8',
  tiles_section:  'm5upqvmu',
  tile_with_set:  'm5uprn1e',   // type=text; bard text contains a buttons set (align=center)
  tabs_filter:    'm6qu5bo1',   // 5 tabs, labels: "A→B" "A→C" "A→D" …
};

// Section / item IDs in home.md
const HID = {
  tiles_section:     'mei9zbpu',
  tile_multi_sets:   'mei9zfhl',  // bard has badges_in_text + buttons sets
};

// Section ID in unser-team.md
const TID = {
  team_section: 'mejqnlvx',
};

let passed = 0, failed = 0;
function ok(label, cond, detail = '') {
  if (cond) { console.log(`  ✓  ${label}`); passed++; }
  else       { console.error(`  ✗  ${label}${detail ? ': ' + detail : ''}`); failed++; }
}

// ── Shared helpers ────────────────────────────────────────────────────────────

async function chat(page, message, { timeoutMs = 75_000 } = {}) {
  const textarea = page.locator(`#${PANEL_ID} textarea[placeholder*="Ask"]`);
  const sendBtn  = page.locator(`#${PANEL_ID} button.btn-primary:has-text("Send")`);

  await textarea.fill(message);
  await sendBtn.click();

  await page.waitForFunction(
    (id) => document.querySelector(`#${id} textarea`)?.disabled === true,
    PANEL_ID, { timeout: 5_000 }
  ).catch(() => {});

  await page.waitForFunction(
    (id) => document.querySelector(`#${id} textarea`)?.disabled === false,
    PANEL_ID, { timeout: timeoutMs }
  );

  return page.evaluate((id) => {
    const panel   = document.getElementById(id);
    const history = panel?.querySelector('div[style*="overflow-y"]');
    if (!history) return '';
    return Array.from(history.children)
      .filter((el) => !el.dataset.technical)
      .map((el) => el.innerText?.trim())
      .filter(Boolean)
      .join('\n---\n');
  }, PANEL_ID);
}

async function toolLog(page) {
  return page.evaluate((id) => {
    const panel   = document.getElementById(id);
    const history = panel?.querySelector('div[style*="overflow-y"]');
    if (!history) return '';
    return Array.from(history.querySelectorAll('[data-technical]'))
      .map((el) => el.innerText?.trim())
      .join('\n');
  }, PANEL_ID);
}

const lastMsg = (r) => r.split('\n---\n').at(-1) ?? '';

/** Read a top-level section by _id from the active Vuex publish module. */
async function vuexSection(page, id) {
  return page.evaluate((id) => {
    const pub = window.Statamic?.$store?.state?.publish ?? {};
    const mod = Object.values(pub).find((m) => Array.isArray(m?.values?.sections));
    return (mod?.values?.sections ?? []).find((s) => (s._id ?? s.id) === id) ?? null;
  }, id);
}

/** Navigate to an entry edit page and wait for the panel and brief to be ready. */
async function gotoEntry(page, entryId) {
  const url = `${CP_URL}/collections/pages/entries/${entryId}`;
  await page.goto(url);
  await page.waitForFunction(() => {
    const pub = window.Statamic?.$store?.state?.publish ?? {};
    return Object.values(pub).some((m) => m?.values && Object.keys(m.values).length > 0);
  }, { timeout: 30_000 });
  await page.waitForSelector(`#${PANEL_ID}`, { timeout: 10_000 });
  await page.waitForTimeout(3_000); // let blueprint pre-warm fetch complete
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function run() {
  console.log('\n=== Section Tools – AI deep nesting test ===\n');

  const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--no-sandbox'] });
  const page    = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  // Login
  await page.goto(`${CP_URL}/auth/login`);
  await page.fill('input[name="email"]', EMAIL);
  await page.fill('input[name="password"]', PASS);
  await Promise.all([page.waitForNavigation({ timeout: 15_000 }), page.click('button[type="submit"]')]);
  if (page.url().includes('/auth/')) { console.error('Login failed'); await browser.close(); process.exit(1); }
  console.log('Logged in ✓\n');

  // ============================================================================
  // ENTRY 1 – asiatische-lid-op.md
  // Section types: media_listing, tabs_filter, tiles with embedded bard sets
  // ============================================================================
  console.log('════ Entry 1: asiatische-lid-op.md ════\n');
  await gotoEntry(page, ENTRIES.asiatische);
  console.log('Entry loaded ✓\n');

  // T1: media_listing — youtube item (video URL + headline)
  // Tests: nested replicator inside a non-standard section type; video field type
  console.log('── T1: Read media_listing youtube item ──');
  const r1 = await chat(
    page,
    'What is the headline and video URL of the YouTube item in the media listing section?'
  );
  console.log('  reply:', lastMsg(r1).slice(0, 180));
  ok('T1: headline mentions "Lid-OP"', /lid.?op/i.test(r1));
  ok('T1: YouTube URL present in reply', /youtube\.com|youtu\.be/i.test(r1));

  // T2: tabs_filter — label list (scalar labels on nested tab items)
  // Tests: reading a nested replicator where items have only simple scalar fields
  console.log('\n── T2: Read tabs_filter labels ──');
  const r2 = await chat(
    page,
    'How many tabs are in the tabs_filter section, and what are their labels? List them.'
  );
  console.log('  reply:', lastMsg(r2).slice(0, 200));
  ok('T2: 5 tabs counted', /5\s*(tabs?|filter)/i.test(r2) || (r2.match(/A[⟶→]/g) ?? []).length >= 3);
  ok('T2: labels contain arrow notation (A→B)', /A[⟶→]B|A[⟶→]C/i.test(r2));

  // T3: Read set embedded inside tile bard text (depth 3: section → tile → bard set)
  // The tile m5uprn1e has a {buttons} set node inside its text bard field.
  // Tests: AI reading deeply nested bard structure
  console.log('\n── T3: Read set embedded in tile bard text ──');
  const r3 = await chat(
    page,
    `In the tiles section (_id ${AID.tiles_section}), look at tile _id ${AID.tile_with_set}. ` +
    'Its bard text contains an embedded set. What type is that set and what is its current align value?'
  );
  const log3 = await toolLog(page);
  console.log('  reply:', lastMsg(r3).slice(0, 180));
  console.log('  tool log (last 200):', log3.slice(-200) || '(none)');
  ok('T3: identifies buttons set type', /buttons/i.test(r3));
  ok('T3: reads align value (center or left)', /center|left/i.test(r3));

  // T4: UPDATE set embedded in tile bard (depth-3 mutation — net-zero)
  // AI must: get_item(tile) → read full bard JSON → modify buttons set align → update_item(tile, {text: ...})
  // This is the deepest write test: modifying a field inside a ProseMirror set node inside a tile.
  console.log('\n── T4: Update embedded set field in tile bard (net-zero) ──');

  // Read current align from Vuex
  const tileBefore = await page.evaluate((ids) => {
    const pub = window.Statamic?.$store?.state?.publish ?? {};
    const mod = Object.values(pub).find((m) => Array.isArray(m?.values?.sections));
    const sec = (mod?.values?.sections ?? []).find((s) => (s._id ?? s.id) === ids.tiles_section);
    const tile = (sec?.tiles ?? []).find((t) => (t._id ?? t.id) === ids.tile_with_set);
    const bard = tile?.text ?? [];
    const setNode = bard.find((n) => n?.type === 'set' && n?.attrs?.values?.type === 'buttons');
    return { align: setNode?.attrs?.values?.align ?? null };
  }, AID);
  const originalAlign = tileBefore.align;
  const newAlign = originalAlign === 'center' ? 'left' : 'center';
  console.log(`  align before: ${originalAlign} → will set to: ${newAlign}`);

  const r4a = await chat(
    page,
    `In tile _id ${AID.tile_with_set} of the tiles section, the bard text has a buttons set node. ` +
    `Change its align value from "${originalAlign}" to "${newAlign}". ` +
    'Use get_item to read the tile first, then update_item with the modified text array.',
    { timeoutMs: 90_000 }
  );
  const log4a = await toolLog(page);
  console.log('  reply:', lastMsg(r4a).slice(0, 120));
  const tileAfterChange = await page.evaluate((ids) => {
    const pub = window.Statamic?.$store?.state?.publish ?? {};
    const mod = Object.values(pub).find((m) => Array.isArray(m?.values?.sections));
    const sec = (mod?.values?.sections ?? []).find((s) => (s._id ?? s.id) === ids.tiles_section);
    const tile = (sec?.tiles ?? []).find((t) => (t._id ?? t.id) === ids.tile_with_set);
    const bard = tile?.text ?? [];
    const setNode = bard.find((n) => n?.type === 'set' && n?.attrs?.values?.type === 'buttons');
    return { align: setNode?.attrs?.values?.align ?? null };
  }, AID);
  console.log('  align in Vuex after change:', tileAfterChange.align);
  ok('T4a: buttons set align changed in Vuex', tileAfterChange.align === newAlign, String(tileAfterChange.align));
  ok('T4a: AI used get_item to read tile', log4a.includes('get_item'));
  ok('T4a: AI used update_item to apply change', log4a.includes('update_item'));

  // Restore original align value
  const r4b = await chat(
    page,
    `Restore the buttons set align in tile _id ${AID.tile_with_set} back to "${originalAlign}". ` +
    'Use get_item first, then update_item.',
    { timeoutMs: 90_000 }
  );
  const tileRestored = await page.evaluate((ids) => {
    const pub = window.Statamic?.$store?.state?.publish ?? {};
    const mod = Object.values(pub).find((m) => Array.isArray(m?.values?.sections));
    const sec = (mod?.values?.sections ?? []).find((s) => (s._id ?? s.id) === ids.tiles_section);
    const tile = (sec?.tiles ?? []).find((t) => (t._id ?? t.id) === ids.tile_with_set);
    const bard = tile?.text ?? [];
    const setNode = bard.find((n) => n?.type === 'set' && n?.attrs?.values?.type === 'buttons');
    return { align: setNode?.attrs?.values?.align ?? null };
  }, AID);
  console.log('  align in Vuex after restore:', tileRestored.align);
  ok('T4b: buttons set align restored in Vuex', tileRestored.align === originalAlign, String(tileRestored.align));

  // ============================================================================
  // ENTRY 2 – home.md
  // Tile with TWO embedded sets in its bard text (badges_in_text + buttons)
  // ============================================================================
  console.log('\n════ Entry 2: home.md ════\n');
  await gotoEntry(page, ENTRIES.home);
  console.log('Entry loaded ✓\n');

  // T5: Read tile with multiple embedded bard sets — depth-3, multiple set types
  console.log('── T5: Read tile with multiple embedded sets ──');
  const r5 = await chat(
    page,
    `In the tiles section (_id ${HID.tiles_section}), tile _id ${HID.tile_multi_sets} has ` +
    'multiple embedded sets in its bard text. What are the types of all embedded sets in that tile?'
  );
  console.log('  reply:', lastMsg(r5).slice(0, 200));
  ok('T5: identifies badges_in_text set', /badges.?in.?text|badge/i.test(r5));
  ok('T5: identifies buttons set', /buttons/i.test(r5));

  // T6: Add a new tile to the tiles section, then delete it (net-zero)
  // Tests: adding a nested replicator item (tile inside tiles) and deleting it
  console.log('\n── T6: Add + delete tile inside tiles section (net-zero) ──');
  const tilesBefore = await page.evaluate((id) => {
    const pub = window.Statamic?.$store?.state?.publish ?? {};
    const mod = Object.values(pub).find((m) => Array.isArray(m?.values?.sections));
    const sec = (mod?.values?.sections ?? []).find((s) => (s._id ?? s.id) === id);
    return (sec?.tiles ?? []).length;
  }, HID.tiles_section);
  console.log('  tiles before:', tilesBefore);

  await chat(
    page,
    `Add a new text tile to the tiles section (_id ${HID.tiles_section}). ` +
    'Set its text to a simple paragraph saying "Playwright test tile."',
    { timeoutMs: 90_000 }
  );
  const tilesAfterAdd = await page.evaluate((id) => {
    const pub = window.Statamic?.$store?.state?.publish ?? {};
    const mod = Object.values(pub).find((m) => Array.isArray(m?.values?.sections));
    const sec = (mod?.values?.sections ?? []).find((s) => (s._id ?? s.id) === id);
    return sec?.tiles ?? [];
  }, HID.tiles_section);
  ok('T6a: new tile added', tilesAfterAdd.length === tilesBefore + 1,
    `${tilesBefore} → ${tilesAfterAdd.length}`);

  const newTileId = tilesAfterAdd.at(-1)?._id ?? tilesAfterAdd.at(-1)?.id;
  console.log('  new tile id:', newTileId);

  await chat(
    page,
    `Delete the tile with _id "${newTileId}" from the tiles section.`,
    { timeoutMs: 90_000 }
  );
  const tilesAfterDelete = await page.evaluate((id) => {
    const pub = window.Statamic?.$store?.state?.publish ?? {};
    const mod = Object.values(pub).find((m) => Array.isArray(m?.values?.sections));
    const sec = (mod?.values?.sections ?? []).find((s) => (s._id ?? s.id) === id);
    return (sec?.tiles ?? []).length;
  }, HID.tiles_section);
  console.log('  tiles after delete:', tilesAfterDelete);
  ok('T6b: tile deleted (count restored)', tilesAfterDelete === tilesBefore,
    `expected ${tilesBefore}, got ${tilesAfterDelete}`);

  // ============================================================================
  // ENTRY 3 – unser-team.md
  // team section — inline nested entries (not a standard Statamic replicator)
  // ============================================================================
  console.log('\n════ Entry 3: unser-team.md ════\n');
  await gotoEntry(page, ENTRIES.team);
  console.log('Entry loaded ✓\n');

  // T7: Read team section inline entries (names + roles)
  console.log('── T7: Read team section entries (names + roles) ──');
  const r7 = await chat(
    page,
    'Who are the team members listed in the team section? Give me each person\'s name and role.'
  );
  console.log('  reply:', lastMsg(r7).slice(0, 200));
  ok('T7: mentions Marilena Ackermann', /marilena/i.test(r7));
  ok('T7: mentions Lisa Schoch', /lisa/i.test(r7));
  ok('T7: mentions the role (Empfang)', /empfang/i.test(r7));

  // T8: Update a team member's description text (nested bard field on inline entry)
  console.log('\n── T8: Update team member bard text (nested inline entry) ──');
  const r8 = await chat(
    page,
    'In the team section, find the team member named "Lisa Schoch" and use get_item to read her entry. ' +
    'Then update her text field to a paragraph saying "Playwright test: Lisa Schoch – Empfang."',
    { timeoutMs: 90_000 }
  );
  const log8 = await toolLog(page);
  console.log('  reply:', lastMsg(r8).slice(0, 120));
  const lisaEntry = await page.evaluate((teamId) => {
    const pub = window.Statamic?.$store?.state?.publish ?? {};
    const mod = Object.values(pub).find((m) => Array.isArray(m?.values?.sections));
    const sec = (mod?.values?.sections ?? []).find((s) => (s._id ?? s.id) === teamId);
    return (sec?.entries ?? []).find((e) => e.title === 'Lisa Schoch') ?? null;
  }, TID.team_section);
  const lisaText = JSON.stringify(lisaEntry?.text ?? '');
  console.log('  Lisa text in Vuex:', lisaText.slice(0, 120));
  ok('T8: Lisa\'s text updated (contains Playwright)', /playwright/i.test(lisaText));
  ok('T8: AI used get_item', log8.includes('get_item'));
  ok('T8: AI used update_item', log8.includes('update_item'));

  // ── Summary ──────────────────────────────────────────────────────────────────
  await browser.close();
  console.log(`\n${'─'.repeat(50)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run().catch((err) => {
  console.error('\nUnhandled error:', err.message);
  console.error(err.stack);
  process.exit(1);
});
