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
import { syncSectionToolsUi, persistPanelPositionOnResize } from './section-tools-panel';
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
