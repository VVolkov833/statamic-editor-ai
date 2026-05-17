import {
  insertQuoteAsSecondSection,
  swapSections2And3,
  cloneThirdSectionAfterwards,
  undoLastMutation,
} from './section-tools-mutations';
import {
  logSectionById,
  logSectionBlueprintById,
  logSection2,
  logSection2Blueprint,
  logPageBrief,
  searchAssets,
  logAssetSearch,
} from './section-tools-queries';
import { syncSectionToolsUi, persistPanelPositionOnResize, togglePanelVisibility } from './section-tools-panel';
import { getPublishStore as libGetPublishStore, buildPageBrief as libBuildPageBrief } from './section-tools-lib';

(() => {
  const viteHost = window.location.hostname || '127.0.0.1';
  const vitePort = window.location.port || '5173';
  const panelStorageKey = `section-tools-panel-position:${window.Statamic?.user?.id ?? 'anon'}`;
  let uiSyncQueued = false;

  // Some live-preview iframe reload paths evaluate an untransformed Vite client.
  if (typeof globalThis.__HMR_CONFIG_NAME__ === 'undefined') {
    globalThis.__HMR_CONFIG_NAME__ = 'app';
  }

  if (typeof globalThis.__BASE__ === 'undefined') {
    globalThis.__BASE__ = '/';
  }

  if (typeof globalThis.__SERVER_HOST__ === 'undefined') {
    globalThis.__SERVER_HOST__ = `${viteHost}:${vitePort}`;
  }

  if (typeof globalThis.__HMR_PROTOCOL__ === 'undefined') {
    globalThis.__HMR_PROTOCOL__ = window.location.protocol === 'https:' ? 'wss' : 'ws';
  }

  if (typeof globalThis.__HMR_HOSTNAME__ === 'undefined') {
    globalThis.__HMR_HOSTNAME__ = viteHost;
  }

  if (typeof globalThis.__HMR_PORT__ === 'undefined') {
    globalThis.__HMR_PORT__ = vitePort;
  }

  if (typeof globalThis.__HMR_BASE__ === 'undefined') {
    globalThis.__HMR_BASE__ = '/';
  }

  if (typeof globalThis.__HMR_DIRECT_TARGET__ === 'undefined') {
    globalThis.__HMR_DIRECT_TARGET__ = `${viteHost}:${vitePort}${globalThis.__HMR_BASE__}`;
  }

  if (typeof globalThis.__WS_TOKEN__ === 'undefined') {
    globalThis.__WS_TOKEN__ = 'dev';
  }

  window.__sectionToolsLoaded = true;
  console.info('[SectionTools] cp.js loaded', window.location.pathname);

  // Blueprint cache: keyed by "collection/blueprint", value is {fields, sets} from PHP endpoint.
  const blueprintCache = {};

  function getCollectionFromPath(pathname) {
    const parts = pathname.split('/');
    const idx = parts.indexOf('collections');
    return idx >= 0 ? (parts[idx + 1] ?? null) : null;
  }

  function fetchBlueprintData(collection, blueprint) {
    const cacheKey = `${collection}/${blueprint}`;
    if (blueprintCache[cacheKey] !== undefined) return;
    blueprintCache[cacheKey] = null; // mark as in-flight

    const cpRoot = window.Statamic?.$config?.get('cp_root') ?? '/cp';
    const xsrf = document.cookie.match(/(?:^|;\s*)XSRF-TOKEN=([^;]+)/)?.[1] ?? '';
    fetch(`${cpRoot}/section-tools/blueprint?collection=${encodeURIComponent(collection)}&blueprint=${encodeURIComponent(blueprint)}`, {
      headers: { 'X-XSRF-TOKEN': decodeURIComponent(xsrf) },
    })
      .then((r) => r.json())
      .then((data) => { blueprintCache[cacheKey] = data; })
      .catch(() => { blueprintCache[cacheKey] = { fields: {}, sets: {} }; });
  }

  function getBlueprintData() {
    const store = libGetPublishStore(window.Statamic);
    const bpName = store?.blueprint?.handle ?? 'default';
    const collection = getCollectionFromPath(window.location.pathname);
    if (!collection) return null;
    const cacheKey = `${collection}/${bpName}`;
    fetchBlueprintData(collection, bpName);
    return blueprintCache[cacheKey] ?? null;
  }

  function buildBrief() {
    const bpData = getBlueprintData();
    const store = libGetPublishStore(window.Statamic);
    const extraFields = { ...(bpData?.fields ?? {}) };
    // Backfill from _root_field on set definitions — covers replicator fields in secondary
    // blueprint tabs even when the async fetch hasn't completed yet (bpData null).
    if (bpData?.sets) {
      for (const setDef of Object.values(bpData.sets)) {
        const rf = setDef._root_field;
        if (rf && !extraFields[rf]) extraFields[rf] = { type: 'replicator' };
      }
    }
    // Backfill from Vuex values — catches scalar fields in secondary tabs (e.g. meta_title
    // in SEO tab) that have values but aren't in the active blueprint or bpData yet.
    const values = store?.values ?? {};
    for (const [handle, val] of Object.entries(values)) {
      if (!extraFields[handle]) {
        extraFields[handle] = Array.isArray(val) ? { type: 'replicator' } : {};
      }
    }
    return libBuildPageBrief(null, { extraFields });
  }

  function isEntryEditScreen() {
    const isCollectionsRoute = window.location.pathname.includes('/collections/');
    const store = libGetPublishStore(window.Statamic);
    const hasValues = store?.values != null && typeof store.values === 'object';
    return isCollectionsRoute && hasValues;
  }

  window.SectionTools = window.SectionTools ?? {};
  window.SectionTools.logSectionById = logSectionById;
  window.SectionTools.logBlueprintById = logSectionBlueprintById;
  window.SectionTools.logPageBrief = logPageBrief;
  window.SectionTools.searchAssets = searchAssets;
  window.SectionTools.togglePanel = () => togglePanelVisibility(panelStorageKey);

  const TOPBAR_BTN_ID = 'section-tools-topbar-btn';
  const LP_BTN_ID = 'section-tools-lp-btn';

  // Inject toggle button into the Statamic global header (only on entry edit screens).
  function injectTopBarButton() {
    const existing = document.getElementById(TOPBAR_BTN_ID);
    if (!isEntryEditScreen()) {
      if (existing) existing.remove();
      return;
    }
    if (existing) return;

    const headLink = document.querySelector('.global-header .head-link');
    if (!headLink) return;

    const btn = document.createElement('button');
    btn.id = TOPBAR_BTN_ID;
    btn.type = 'button';
    btn.className = 'global-header-icon-button hidden md:block';
    btn.setAttribute('aria-label', 'AI Assistant');
    btn.title = 'AI Assistant';
    // Chat bubble icon
    btn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>`;
    btn.addEventListener('click', () => togglePanelVisibility(panelStorageKey));

    // Insert before the dark-mode-toggle (first utility button)
    const darkModeEl = headLink.querySelector('dark-mode-toggle');
    if (darkModeEl) {
      headLink.insertBefore(btn, darkModeEl);
    } else {
      headLink.prepend(btn);
    }
  }

  // Inject toggle button into the live-preview header bar (covers the global top bar in LP mode).
  function injectLivePreviewButton() {
    if (document.getElementById(LP_BTN_ID)) return;

    const lpHeader = document.querySelector('.live-preview-header');
    if (!lpHeader) return;

    const flexRow = lpHeader.querySelector('.flex.items-center');
    if (!flexRow) return;

    const btn = document.createElement('button');
    btn.id = LP_BTN_ID;
    btn.type = 'button';
    btn.className = 'btn';
    btn.style.cssText = 'margin-left:8px;display:inline-flex;align-items:center;gap:4px';
    btn.setAttribute('aria-label', 'Toggle AI Assistant');
    btn.title = 'Toggle AI Assistant';
    btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg> AI`;
    btn.addEventListener('click', () => togglePanelVisibility(panelStorageKey));

    const closeBtn = flexRow.querySelector('.btn-close');
    if (closeBtn) {
      flexRow.insertBefore(btn, closeBtn);
    } else {
      flexRow.appendChild(btn);
    }
  }

  function syncButtons() {
    syncSectionToolsUi({
      isInScope: isEntryEditScreen,
      panelStorageKey,
      getBrief: buildBrief,
      getBlueprintData,
      actions: {
        onQuote: insertQuoteAsSecondSection,
        onSwap: swapSections2And3,
        onClone: cloneThirdSectionAfterwards,
        onUndo: undoLastMutation,
        onLogSection2: logSection2,
        onLogSection2Blueprint: logSection2Blueprint,
        onLogPageBrief: logPageBrief,
        onSearchAssets: logAssetSearch,
      },
    });
    injectTopBarButton();
    injectLivePreviewButton();
  }

  function scheduleUiSync() {
    if (uiSyncQueued) {
      return;
    }

    uiSyncQueued = true;
    window.requestAnimationFrame(() => {
      uiSyncQueued = false;
      syncButtons();
    });
  }

  window.Statamic.booting(() => {
    console.info('[SectionTools] Statamic.booting fired');

    syncButtons();

    // Pre-warm blueprint cache so data is ready before the first AI message.
    if (isEntryEditScreen()) getBlueprintData();

    window.addEventListener('resize', () => {
      persistPanelPositionOnResize(panelStorageKey);
    });

    const observer = new MutationObserver(() => {
      scheduleUiSync();
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
    });
  });
})();
