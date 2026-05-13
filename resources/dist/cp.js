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
import { getPublishStore as libGetPublishStore, getSections as libGetSections } from './section-tools-lib';

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

  function isPagesEntryScreen() {
    const isPagesCollectionRoute = window.location.pathname.includes('/collections/pages');
    const hasSectionsInPublishState = Array.isArray(libGetPublishStore(window.Statamic)?.values?.sections);

    return isPagesCollectionRoute && hasSectionsInPublishState;
  }

  window.SectionTools = window.SectionTools ?? {};
  window.SectionTools.logSectionById = logSectionById;
  window.SectionTools.logBlueprintById = logSectionBlueprintById;
  window.SectionTools.logPageBrief = logPageBrief;
  window.SectionTools.searchAssets = searchAssets;

  function syncButtons() {
    syncSectionToolsUi({
      isInScope: isPagesEntryScreen,
      panelStorageKey,
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
