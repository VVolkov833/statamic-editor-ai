/**
 * Section Tools – Focused build issues test
 *
 * Tests only the sections that had known bugs:
 *  - accordion: headline (textarea), entries (grid field), bard answer text
 *  - call_to_action: text (textarea not bard), buttons (replicator)
 *
 * Uses mini-build-test.html — 2 sections only, much cheaper than the full build test.
 */

import { chromium } from 'playwright';
import { readFileSync } from 'fs';

const CP_URL    = 'http://plastischechirurgie-frankfurt.test/cp';
const ENTRY_URL = `${CP_URL}/collections/pages/entries/50f8e858-8ca5-41f6-aee4-d11a792ab737`;
const EMAIL     = 'playwright@test.local';
const PASS      = 'PlaywrightTest123!';
const PANEL_ID  = 'section-tools-floating-panel';

const DOC_HTML  = readFileSync(
  '/home/vadim/Desktop/html/laravel/plastischechirurgie-frankfurt/mini-build-test.html',
  'utf8'
);

let passed = 0, failed = 0;
function ok(label, cond, detail = '') {
  if (cond) { console.log(`  ✓  ${label}`); passed++; }
  else       { console.error(`  ✗  ${label}${detail ? ': ' + detail : ''}`); failed++; }
}

async function run() {
  console.log('\n=== Section Tools – Build issues test (accordion + CTA) ===\n');

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

  // Switch to Document tab
  await page.evaluate((id) => {
    const panel = document.getElementById(id);
    const btns = Array.from(panel?.querySelectorAll('button') ?? []);
    btns.find((b) => b.textContent.trim().toUpperCase() === 'DOCUMENT')?.click();
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
    if (!vm) return 'no editor vm found in DOM';
    try { vm.editor.commands.setContent(html, false); return 'ok'; }
    catch (e) { return 'setContent error: ' + e.message; }
  }, DOC_HTML);

  ok('Bard content set', contentSet === 'ok', contentSet);

  // Click Build page
  console.log('Clicking "Build page"…');
  await page.locator(`#${PANEL_ID} button.btn-primary:has-text("Build")`).click();

  await page.waitForFunction(
    (id) => document.querySelector(`#${id} button.btn-primary`)?.disabled === true ||
             document.querySelector(`#${id} textarea`)?.disabled === true,
    PANEL_ID, { timeout: 10_000 }
  ).catch(() => {});

  console.log('Waiting for AI to finish (up to 5 min)…');
  await page.waitForFunction(
    (id) => { const btn = document.querySelector(`#${id} button.btn-primary`); return btn && !btn.disabled; },
    PANEL_ID, { timeout: 300_000 }
  );
  console.log('\nAI finished.\n');

  // Tool call summary
  const toolLog = await page.evaluate((id) => {
    const techMsgs = Array.from(document.getElementById(id)?.querySelectorAll('[data-technical]') ?? []);
    return techMsgs.map((el) => el.innerText?.trim()).join('\n');
  }, PANEL_ID);
  const toolNames = {};
  for (const m of toolLog.matchAll(/^→ (\w+)\(/gm)) {
    toolNames[m[1]] = (toolNames[m[1]] ?? 0) + 1;
  }
  console.log('── Tools used:', JSON.stringify(toolNames));
  console.log('── Errors:', toolLog.includes('"error"') ? 'YES' : 'none');

  // Read sections from Vuex
  const sections = await page.evaluate(() => {
    const pub = window.Statamic?.$store?.state?.publish ?? {};
    const mod = Object.values(pub).find((m) => Array.isArray(m?.values?.sections));
    return (mod?.values?.sections ?? []);
  });

  console.log('\n── Sections:', sections.map(s => s.type).join(', '));

  // ── Accordion checks ──────────────────────────────────────────────────────
  const accordion = sections.find(s => s.type === 'accordion');
  console.log('\n── Accordion raw:', JSON.stringify(accordion ?? null, null, 2).slice(0, 800));

  ok('accordion section created', !!accordion);
  ok('accordion.headline is a non-empty string',
     typeof accordion?.headline === 'string' && accordion.headline.length > 0,
     JSON.stringify(accordion?.headline));
  ok('accordion.entries is an array with 2+ rows',
     Array.isArray(accordion?.entries) && accordion.entries.length >= 2,
     `entries.length=${accordion?.entries?.length}`);
  ok('accordion.entries[0].title is set',
     typeof accordion?.entries?.[0]?.title === 'string' && accordion.entries[0].title.length > 0,
     JSON.stringify(accordion?.entries?.[0]?.title));
  ok('accordion.entries[0].text is bard array',
     Array.isArray(accordion?.entries?.[0]?.text) && accordion.entries[0].text.length > 0,
     `text.length=${accordion?.entries?.[0]?.text?.length}`);

  // ── CTA checks ────────────────────────────────────────────────────────────
  const cta = sections.find(s => s.type === 'call_to_action');
  console.log('\n── CTA raw:', JSON.stringify(cta ?? null, null, 2).slice(0, 600));

  ok('call_to_action section created', !!cta);
  ok('cta.text is a plain string (not "[object Object]")',
     typeof cta?.text === 'string' && !cta.text.includes('[object'),
     JSON.stringify(cta?.text)?.slice(0, 80));
  ok('cta.buttons is a non-empty array',
     Array.isArray(cta?.buttons) && cta.buttons.length > 0,
     `buttons.length=${cta?.buttons?.length}`);
  ok('cta.buttons[0].type is a button type string',
     typeof cta?.buttons?.[0]?.type === 'string' && cta.buttons[0].type.startsWith('button_'),
     JSON.stringify(cta?.buttons?.[0]?.type));

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
