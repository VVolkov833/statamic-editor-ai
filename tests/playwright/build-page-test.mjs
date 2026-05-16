/**
 * Section Tools – Build page (Document tab) test
 *
 * Pastes the botox-build-test.html document into the Document tab's bard editor,
 * clicks "Build page", and observes what the AI does — which tool calls it makes,
 * which sections get created, and where it fails or hits max rounds.
 *
 * Run AFTER npm run build. Uses botox.md (does NOT save — reload without saving to restore).
 */

import { chromium } from 'playwright';
import { readFileSync } from 'fs';

const CP_URL    = 'http://plastischechirurgie-frankfurt.test/cp';
const ENTRY_URL = `${CP_URL}/collections/pages/entries/50f8e858-8ca5-41f6-aee4-d11a792ab737`;
const EMAIL     = 'playwright@test.local';
const PASS      = 'PlaywrightTest123!';
const PANEL_ID  = 'section-tools-floating-panel';

const DOC_HTML  = readFileSync(
  '/home/vadim/Desktop/html/laravel/plastischechirurgie-frankfurt/botox-build-test.html',
  'utf8'
);

let passed = 0, failed = 0;
function ok(label, cond, detail = '') {
  if (cond) { console.log(`  ✓  ${label}`); passed++; }
  else       { console.error(`  ✗  ${label}${detail ? ': ' + detail : ''}`); failed++; }
}

async function run() {
  console.log('\n=== Section Tools – Build page test ===\n');

  const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--no-sandbox'] });
  const page    = await browser.newPage({ viewport: { width: 1440, height: 900 } });

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

  const sectionsBefore = await page.evaluate(() => {
    const pub = window.Statamic?.$store?.state?.publish ?? {};
    const mod = Object.values(pub).find((m) => Array.isArray(m?.values?.sections));
    return (mod?.values?.sections ?? []).length;
  });
  console.log(`Sections before build: ${sectionsBefore}`);

  // ── Switch to Document tab ────────────────────────────────────────────────
  await page.evaluate((id) => {
    const panel = document.getElementById(id);
    // Find the "Document" tab button by text
    const btns = Array.from(panel?.querySelectorAll('button') ?? []);
    btns.find((b) => b.textContent.trim().toUpperCase() === 'DOCUMENT')?.click();
  }, PANEL_ID);

  // Wait for the bard editor container to appear
  await page.waitForSelector(`#${PANEL_ID} .st-doc-bard`, { timeout: 8_000 });
  await page.waitForTimeout(500);

  // ── Set bard content ─────────────────────────────────────────────────────
  // We need to interact with the ProseMirror (Tiptap) editor inside the bard component.
  const contentSet = await page.evaluate((html) => {
    const docBard = document.querySelector('.st-doc-bard');
    if (!docBard) return 'no .st-doc-bard found';

    // Walk DOM to find a Vue instance that has a Tiptap editor with setContent
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
    if (!vm) return 'no editor vm found in DOM';
    try {
      vm.editor.commands.setContent(html, false);
      return 'ok';
    } catch (e) {
      return 'setContent error: ' + e.message;
    }
  }, DOC_HTML);

  console.log(`Set bard content: ${contentSet}`);
  ok('Bard content set', contentSet === 'ok', contentSet);

  // Verify the bard got some content (check ProseMirror has text)
  const bardHasContent = await page.evaluate(() => {
    const pm = document.querySelector('.st-doc-bard .ProseMirror');
    return (pm?.textContent?.trim().length ?? 0) > 50;
  });
  ok('Bard editor has content', bardHasContent);

  // ── Click Build page ──────────────────────────────────────────────────────
  console.log('\nClicking "Build page"…');
  const buildBtn = page.locator(`#${PANEL_ID} button.btn-primary:has-text("Build")`);
  await buildBtn.click();

  // After clicking Build, the panel switches to Chat tab automatically.
  // Wait for the Send button to become disabled (AI in flight)
  await page.waitForFunction(
    (id) => document.querySelector(`#${id} button.btn-primary`)?.disabled === true ||
             document.querySelector(`#${id} textarea`)?.disabled === true,
    PANEL_ID, { timeout: 10_000 }
  ).catch(() => console.log('  (in-flight indicator not detected — may have finished instantly)'));

  // Wait for the AI to finish — up to 10 minutes (build needs many rounds)
  console.log('Waiting for AI to finish building (up to 10 min)…');
  await page.waitForFunction(
    (id) => {
      const btn = document.querySelector(`#${id} button.btn-primary`);
      return btn && !btn.disabled;
    },
    PANEL_ID, { timeout: 600_000 }
  );

  console.log('\nAI finished.\n');

  // ── Collect results ───────────────────────────────────────────────────────
  const result = await page.evaluate((id) => {
    const panel   = document.getElementById(id);
    const history = panel?.querySelector('div[style*="overflow-y"]');
    if (!history) return { reply: '', toolLog: '', roundCount: 0 };

    const msgs     = Array.from(history.children).filter((el) => !el.dataset.technical);
    const techMsgs = Array.from(history.querySelectorAll('[data-technical]'));

    const reply    = msgs.map((el) => el.innerText?.trim()).filter(Boolean).join('\n---\n');
    const toolLog  = techMsgs.map((el) => el.innerText?.trim()).join('\n');
    const roundCount = (toolLog.match(/^→/gm) ?? []).length;

    return { reply, toolLog, roundCount };
  }, PANEL_ID);

  const lastReply = result.reply.split('\n---\n').at(-1) ?? '';
  console.log('── Final AI reply ──');
  console.log(lastReply.slice(0, 400));
  console.log('\n── Tool call count:', result.roundCount);

  // Count unique tool names used
  const toolNames = {};
  for (const m of result.toolLog.matchAll(/^→ (\w+)\(/gm)) {
    toolNames[m[1]] = (toolNames[m[1]] ?? 0) + 1;
  }
  console.log('── Tools used:', JSON.stringify(toolNames));

  // Check for known issues
  const hitMaxRounds = lastReply.includes('[max steps reached]');
  const hasErrors    = result.toolLog.includes('"error"');
  console.log('\n── Flags:');
  console.log(`  hitMaxRounds: ${hitMaxRounds}`);
  console.log(`  hasErrors: ${hasErrors}`);

  if (hasErrors) {
    console.log('\n── Error lines from tool log:');
    result.toolLog.split('\n').filter((l) => l.includes('"error"')).slice(0, 10)
      .forEach((l) => console.log('  ', l.slice(0, 200)));
  }

  // ── Check Vuex sections ───────────────────────────────────────────────────
  const sectionsAfter = await page.evaluate(() => {
    const pub = window.Statamic?.$store?.state?.publish ?? {};
    const mod = Object.values(pub).find((m) => Array.isArray(m?.values?.sections));
    return (mod?.values?.sections ?? []).map((s) => ({ type: s.type, id: s._id ?? s.id }));
  });
  console.log('\n── Sections after build:');
  sectionsAfter.forEach((s, i) => console.log(`  [${i}] ${s.type}  ${s.id}`));

  ok('AI added at least one new section', sectionsAfter.length > 0);
  ok('AI did not hit max rounds', !hitMaxRounds);
  ok('No tool errors', !hasErrors);

  // Check expected section types (header is a top-level field, not in sections array)
  const types = sectionsAfter.map((s) => s.type);
  for (const t of ['quote', 'tiles', 'table', 'text', 'tabs_numbers', 'accordion', 'call_to_action', 'contact_form', 'verified']) {
    ok(`Section type "${t}" created`, types.includes(t));
  }

  const detail = await page.evaluate(() => {
    const pub = window.Statamic?.$store?.state?.publish ?? {};
    const mod = Object.values(pub).find((m) => Array.isArray(m?.values?.sections));
    const secs = mod?.values?.sections ?? [];

    // Quote: text must be a plain string
    const quote = secs.find((s) => s.type === 'quote');

    // Tiles: first tiles section should have medium tile with asset
    const tiles = secs.find((s) => s.type === 'tiles');
    const tilesList = tiles?.tiles ?? [];
    const mediumTile = tilesList.find((t) => t.type === 'medium');

    // Table rows
    const table = secs.find((s) => s.type === 'table');
    const tableGroups = table?.table ?? [];
    const rows = tableGroups[0]?.rows ?? [];

    // Accordion entries (grid field)
    const accordion = secs.find((s) => s.type === 'accordion');

    // Contact form type
    const contactForm = secs.find((s) => s.type === 'contact_form');

    // Header (top-level replicator field, not in sections)
    const header = (mod?.values?.header ?? []);
    const headerItem = header[0];

    // Verified image
    const verified = secs.find((s) => s.type === 'verified');

    return {
      quoteText: quote?.text,
      tilesCount: tilesList.length,
      tilesTypes: tilesList.map((t) => t.type),
      mediumAsset: mediumTile?.medium?.[0] ?? null,
      tableGroups: tableGroups.length,
      tableRows: rows.length,
      tableFirstLabel: rows[0]?.label ?? null,
      accordionHeadline: accordion?.headline,
      accordionEntries: (accordion?.entries ?? []).length,
      accordionFirstTitle: accordion?.entries?.[0]?.title ?? null,
      contactFormType: contactForm?.contact_form_type,
      headerMedium: headerItem?.medium ?? null,
      headerType: headerItem?.type ?? null,
      verifiedImage: verified?.image?.[0] ?? null,
    };
  });

  console.log('\n── Detail:', JSON.stringify(detail, null, 2));

  ok('quote.text is a plain string', typeof detail?.quoteText === 'string' && !String(detail?.quoteText ?? '').startsWith('['), String(detail?.quoteText).slice(0, 60));
  ok('tiles has medium tile', detail?.tilesTypes?.includes('medium'));
  ok('medium tile has asset', !!detail?.mediumAsset);
  ok('table has rows populated', (detail?.tableRows ?? 0) >= 2);
  ok('table rows have label', !!detail?.tableFirstLabel);
  ok('accordion.headline is plain string', typeof detail?.accordionHeadline === 'string' && detail.accordionHeadline.length > 0, String(detail?.accordionHeadline ?? '').slice(0,40));
  ok('accordion has entries', (detail?.accordionEntries ?? 0) >= 2);
  ok('accordion.entries[0].title is set', !!detail?.accordionFirstTitle);
  ok('contact_form.contact_form_type is valid ("contact" or "recall")', ['contact','recall'].includes(detail?.contactFormType), String(detail?.contactFormType));
  ok('header item type is "header"', detail?.headerType === 'header', String(detail?.headerType));
  ok('header has medium image', !!detail?.headerMedium, String(detail?.headerMedium));
  ok('verified has image', !!detail?.verifiedImage, String(detail?.verifiedImage));

  await browser.close();
  console.log(`\n${'─'.repeat(50)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error('\nUnhandled error:', err.message);
  console.error(err.stack);
  process.exit(1);
});
