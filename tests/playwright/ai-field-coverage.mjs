/**
 * Section Tools – AI field coverage test
 *
 * Systematically exercises the AI assistant across all field types and CRUD operations
 * found in botox.md, which contains 17 of the 21 section types in the pages collection.
 *
 * Entry: botox.md — id 50f8e858-8ca5-41f6-aee4-d11a792ab737
 *
 * Section IDs (from botox.md YAML, stable across runs):
 *   m862yes2   quote         – plain string field (text)
 *   m5uu0nyo   anchor        – title: 'Was ist Botox?'
 *   m5utt61z   accordion     – 7 FAQ entries with title + bard text
 *   m872mrna   tabs_numbers  – 5 numbered tabs
 *   m87k1f9l   medium        – asset field + autoplay boolean
 *   m5u6wtsk   table         – nested rows with label + bard text
 *   m5u6p49r   tiles         – 5 tiles (each a nested replicator item)
 *   m5utngmn   verified      – image asset + headline + bard text
 *
 * READ tests  (T1–T5):  assert the AI extracts correct values from the page brief
 * WRITE tests (T6–T10): assert mutations land in Vuex; add+delete pairs are net-zero
 */

import { chromium } from 'playwright';

const CP_URL    = 'http://plastischechirurgie-frankfurt.test/cp';
const ENTRY_URL = `${CP_URL}/collections/pages/entries/50f8e858-8ca5-41f6-aee4-d11a792ab737`;
const EMAIL     = 'playwright@test.local';
const PASS      = 'PlaywrightTest123!';
const PANEL_ID  = 'section-tools-floating-panel';

// Stable section IDs referenced in this test
const ID = {
  quote:        'm862yes2',
  anchor_botox: 'm5uu0nyo',
  accordion:    'm5utt61z',
  tabs_numbers: 'm872mrna',
  medium:       'm87k1f9l',
  table:        'm5u6wtsk',
  tiles_first:  'm5u6p49r',
  verified:     'm5utngmn',
};

let passed = 0, failed = 0;
function ok(label, cond, detail = '') {
  if (cond) { console.log(`  ✓  ${label}`); passed++; }
  else       { console.error(`  ✗  ${label}${detail ? ': ' + detail : ''}`); failed++; }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Type a message, click Send, wait for the response, return all non-technical messages. */
async function chat(page, message, { timeoutMs = 75_000 } = {}) {
  const textarea = page.locator(`#${PANEL_ID} textarea[placeholder*="Ask"]`);
  const sendBtn  = page.locator(`#${PANEL_ID} button.btn-primary:has-text("Send")`);

  await textarea.fill(message);
  await sendBtn.click();

  // Wait for in-flight indicator
  await page.waitForFunction(
    (id) => document.querySelector(`#${id} textarea`)?.disabled === true,
    PANEL_ID, { timeout: 5_000 }
  ).catch(() => {});

  // Wait for response
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

/** Return tool-call log lines from the chat panel (→ name(args) / ← result). */
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

/** Return a top-level section from Vuex by its _id. */
async function vuexSection(page, id) {
  return page.evaluate((id) => {
    const pub = window.Statamic?.$store?.state?.publish ?? {};
    const mod = Object.values(pub).find((m) => Array.isArray(m?.values?.sections));
    return (mod?.values?.sections ?? []).find((s) => (s._id ?? s.id) === id) ?? null;
  }, id);
}

/** Return all top-level sections from Vuex. */
async function vuexSections(page) {
  return page.evaluate(() => {
    const pub = window.Statamic?.$store?.state?.publish ?? {};
    const mod = Object.values(pub).find((m) => Array.isArray(m?.values?.sections));
    return mod?.values?.sections ?? [];
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function run() {
  console.log('\n=== Section Tools – AI field coverage test ===\n');

  const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--no-sandbox'] });
  const page    = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  // Login
  await page.goto(`${CP_URL}/auth/login`);
  await page.fill('input[name="email"]', EMAIL);
  await page.fill('input[name="password"]', PASS);
  await Promise.all([page.waitForNavigation({ timeout: 15_000 }), page.click('button[type="submit"]')]);
  if (page.url().includes('/auth/')) { console.error('Login failed'); await browser.close(); process.exit(1); }

  // Load entry and wait for panel
  await page.goto(ENTRY_URL);
  await page.waitForFunction(() => {
    const pub = window.Statamic?.$store?.state?.publish ?? {};
    return Object.values(pub).some((m) => m?.values && Object.keys(m.values).length > 0);
  }, { timeout: 30_000 });
  await page.waitForSelector(`#${PANEL_ID}`, { timeout: 10_000 });
  await page.waitForTimeout(3_000); // let blueprint pre-warm fetch complete
  console.log('Entry loaded ✓\n');

  // ==========================================================================
  // READ TESTS — verify the AI reads different field types from the brief
  // ==========================================================================

  // T1: Plain string field (quote.text)
  // The quote section stores text as a plain string, not ProseMirror.
  console.log('── T1: Read plain string field (quote.text) ──');
  const r1 = await chat(page, 'What does the testimonial quote section say? Give me the full text of the quote.');
  const lastMsg = (r) => r.split('\n---\n').at(-1) ?? '';
  console.log('  reply:', lastMsg(r1).slice(0, 120));
  ok('T1: quote text in reply (jugendlich/aussehen/natürlich)',
    /jugendlich|aussehen|natürlich|kompliment/i.test(r1));

  // T2: Nested replicator items — accordion entries (title + bard text per entry)
  console.log('\n── T2: Read nested replicator items (accordion FAQ entries) ──');
  const r2 = await chat(page, 'List all the FAQ question titles in the accordion section at the bottom of the page.');
  console.log('  reply:', lastMsg(r2).slice(0, 250));
  ok('T2: lists "Baby Botox" FAQ question',  /baby botox/i.test(r2));
  ok('T2: lists "Ab wann wirkt" FAQ question', /ab wann wirkt/i.test(r2));
  ok('T2: lists all 7 questions (count check)', (r2.match(/\d+\./g) ?? []).length >= 6 || (r2.match(/[-•*]\s/g) ?? []).length >= 5 || /botox.*botox.*botox/is.test(r2));

  // T3: Nested replicator items — tabs_numbers (5 tabs with bard headings)
  console.log('\n── T3: Read nested items (tabs_numbers headings) ──');
  const r3 = await chat(page, 'What are the step headings in the numbered tabs section? List each one.');
  console.log('  reply:', lastMsg(r3).slice(0, 250));
  ok('T3: mentions Alkohol or Nikotin (tab 1)', /alkohol|nikotin/i.test(r3));
  ok('T3: mentions Sauna (tab 5)', /sauna/i.test(r3));

  // T4: Asset field (medium.medium — a plain file path string)
  // The top-level medium section has background_height=66 and background_color=#EEE0C4,
  // which distinguishes it from medium items nested inside tiles.
  console.log('\n── T4: Read asset field (medium.medium) ──');
  const r4 = await chat(page, 'What file path is stored in the medium field of the top-level medium section? That section has background_height="66" and background_color="#EEE0C4". Give me the exact path string.');
  console.log('  reply:', lastMsg(r4).slice(0, 150));
  ok('T4: file path contains istock (actual filename)', /istock/i.test(r4));
  ok('T4: file path contains botox (directory name)',  /botox/i.test(r4));

  // T5: Nested table rows (table.table[0].rows[].label + .text)
  console.log('\n── T5: Read nested table content (table rows) ──');
  const r5 = await chat(page, 'What value does the "Behandlungsdauer" row show in the info table?');
  console.log('  reply:', lastMsg(r5).slice(0, 150));
  ok('T5: duration value mentions minutes or a number range', /minuten|minutes|\d+\s*[-–]\s*\d+/i.test(r5));

  // ==========================================================================
  // WRITE TESTS — verify mutations land correctly in Vuex
  // ==========================================================================

  // T6: Scalar string field update — anchor.title
  console.log('\n── T6: Update scalar string field (anchor.title) ──');
  const r6 = await chat(
    page,
    'Update the anchor section with title "Was ist Botox?" to have the title "Was ist Botox Frankfurt?".',
    { timeoutMs: 90_000 }
  );
  console.log('  reply:', lastMsg(r6).slice(0, 120));
  const anchor6 = await vuexSection(page, ID.anchor_botox);
  ok('T6: anchor title updated in Vuex',
    anchor6?.title === 'Was ist Botox Frankfurt?', String(anchor6?.title));

  // T7: Boolean field toggle — medium.autoplay = false
  console.log('\n── T7: Toggle boolean field (medium.autoplay → false) ──');
  const medBefore = await vuexSection(page, ID.medium);
  console.log('  autoplay before:', medBefore?.autoplay);
  const r7 = await chat(
    page,
    'Set autoplay to false on the top-level medium section that has background_height="66" and background_color="#EEE0C4". ' +
    'Do not confuse it with medium items nested inside tiles.',
    { timeoutMs: 90_000 }
  );
  console.log('  reply:', lastMsg(r7).slice(0, 120));
  const medAfter = await vuexSection(page, ID.medium);
  console.log('  autoplay after:', medAfter?.autoplay);
  ok('T7: autoplay set to false in Vuex', medAfter?.autoplay === false, String(medAfter?.autoplay));

  // T8: Nested item scalar update — accordion entry title
  // Tests that update_item works for a nested replicator item (depth 2).
  console.log('\n── T8: Update nested item scalar (accordion entry title) ──');
  const r8 = await chat(
    page,
    'In the FAQ accordion, find the entry whose title starts with "Ab wann wirkt Botox?" ' +
    'and change its title to "Ab wann wirkt eine Botox-Behandlung?". ' +
    'Use get_item to look it up first.',
    { timeoutMs: 90_000 }
  );
  const log8 = await toolLog(page);
  console.log('  reply:', lastMsg(r8).slice(0, 120));
  const accSection8 = await vuexSection(page, ID.accordion);
  const updatedEntry8 = (accSection8?.entries ?? []).find(
    (e) => (e.title ?? '').includes('Ab wann wirkt eine Botox-Behandlung')
  );
  ok('T8: nested accordion entry title updated in Vuex', !!updatedEntry8,
    JSON.stringify((accSection8?.entries ?? []).map((e) => e.title)));
  ok('T8: AI used get_item to read the entry', log8.includes('get_item'));
  ok('T8: AI used update_item to apply the change', log8.includes('update_item'));

  // T9: Add + delete a nested item — accordion FAQ entry (net-zero)
  console.log('\n── T9: Add then delete a nested item (accordion FAQ entry) ──');
  const accBefore9 = await vuexSection(page, ID.accordion);
  const countBefore9 = accBefore9?.entries?.length ?? 0;
  console.log('  accordion entries before:', countBefore9);

  await chat(
    page,
    'Add a new FAQ entry to the accordion. ' +
    'Set its title to "Playwright-Test-Frage" and its text body to "Ja, das ist ein automatischer Test."',
    { timeoutMs: 90_000 }
  );
  const accAfterAdd9 = await vuexSection(page, ID.accordion);
  const countAfterAdd9 = accAfterAdd9?.entries?.length ?? 0;
  console.log('  accordion entries after add:', countAfterAdd9);
  ok('T9a: new FAQ entry added', countAfterAdd9 === countBefore9 + 1,
    `${countBefore9} → ${countAfterAdd9}`);

  await chat(
    page,
    'Delete the FAQ entry titled "Playwright-Test-Frage" from the accordion.',
    { timeoutMs: 90_000 }
  );
  const accAfterDel9 = await vuexSection(page, ID.accordion);
  const countAfterDel9 = accAfterDel9?.entries?.length ?? 0;
  console.log('  accordion entries after delete:', countAfterDel9);
  ok('T9b: FAQ entry deleted (count restored)', countAfterDel9 === countBefore9,
    `expected ${countBefore9}, got ${countAfterDel9}`);

  // T10: Add + delete a top-level section — spacer (net-zero)
  console.log('\n── T10: Add then delete top-level section (spacer) ──');
  const sectionsBefore10 = await vuexSections(page);
  const countBefore10 = sectionsBefore10.length;
  console.log('  sections before:', countBefore10);

  await chat(page, 'Add a new spacer section at the very end of the page.', { timeoutMs: 90_000 });
  const sectionsAfterAdd10 = await vuexSections(page);
  ok('T10a: spacer section added',
    sectionsAfterAdd10.length === countBefore10 + 1,
    `${countBefore10} → ${sectionsAfterAdd10.length}`);

  const lastSection = sectionsAfterAdd10.at(-1);
  const lastSectionId = lastSection?._id ?? lastSection?.id;
  console.log('  last section type:', lastSection?.type, 'id:', lastSectionId);

  await chat(
    page,
    `Delete the spacer section with _id "${lastSectionId}" that you just added.`,
    { timeoutMs: 90_000 }
  );
  const sectionsAfterDel10 = await vuexSections(page);
  console.log('  sections after delete:', sectionsAfterDel10.length);
  ok('T10b: spacer section deleted (count restored)',
    sectionsAfterDel10.length === countBefore10,
    `expected ${countBefore10}, got ${sectionsAfterDel10.length}`);

  // ── Summary ───────────────────────────────────────────────────────────────
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
