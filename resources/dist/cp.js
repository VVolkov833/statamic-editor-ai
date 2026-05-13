import {
  insertQuoteAsSecondSection as libInsertQuoteAsSecondSection,
  swapSections2And3 as libSwapSections2And3,
  cloneThirdSectionAfterwards as libCloneThirdSectionAfterwards,
  getPublishStore as libGetPublishStore,
  getSections as libGetSections,
  setSections,
  getSectionId,
  cloneValue,
  buildPageBrief,
} from './section-tools-lib';
import { syncSectionToolsUi, persistPanelPositionOnResize } from './section-tools-panel';

(() => {
  const MAX_UNDO_STEPS = 10;
  const viteHost = window.location.hostname || '127.0.0.1';
  const vitePort = window.location.port || '5173';
  const panelStorageKey = `section-tools-panel-position:${window.Statamic?.user?.id ?? 'anon'}`;
  const mutationHistory = [];
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

  function pushUndoSnapshot() {
    const sections = libGetSections(window.Statamic);

    if (!sections) {
      return false;
    }

    mutationHistory.push(cloneValue(sections));

    if (mutationHistory.length > MAX_UNDO_STEPS) {
      mutationHistory.shift();
    }

    return true;
  }

  function popUndoSnapshot() {
    return mutationHistory.pop() ?? null;
  }

  function insertQuoteAsSecondSection() {
    if (!pushUndoSnapshot()) {
      window.Statamic.$toast.error('Publish state wurde nicht gefunden.');
      return;
    }

    if (libInsertQuoteAsSecondSection(window.Statamic)) {
      window.Statamic.$toast.success('Zitat als zweiter Abschnitt eingefuegt.');
    } else {
      popUndoSnapshot();
      window.Statamic.$toast.error('Aktualisierung fehlgeschlagen.');
    }
  }

  function swapSections2And3() {
    const sections = libGetSections(window.Statamic);

    if (!sections) {
      window.Statamic.$toast.error('Publish state wurde nicht gefunden.');
      return;
    }

    if (sections.length < 3) {
      window.Statamic.$toast.warning('Mindestens 3 Abschnitte benoetigt.');
      return;
    }

    if (!pushUndoSnapshot()) {
      window.Statamic.$toast.error('Publish state wurde nicht gefunden.');
      return;
    }

    if (libSwapSections2And3(window.Statamic)) {
      window.Statamic.$toast.success('Abschnitte 2 und 3 wurden getauscht.');
    } else {
      popUndoSnapshot();
      window.Statamic.$toast.error('Aktualisierung fehlgeschlagen.');
    }
  }

  function cloneThirdSectionAfterwards() {
    const sections = libGetSections(window.Statamic);

    if (!sections) {
      window.Statamic.$toast.error('Publish state wurde nicht gefunden.');
      return;
    }

    if (sections.length < 3) {
      window.Statamic.$toast.warning('Mindestens 3 Abschnitte benoetigt.');
      return;
    }

    if (!pushUndoSnapshot()) {
      window.Statamic.$toast.error('Publish state wurde nicht gefunden.');
      return;
    }

    if (libCloneThirdSectionAfterwards(window.Statamic)) {
      window.Statamic.$toast.success('Abschnitt 3 wurde geklont und eingefuegt.');
    } else {
      popUndoSnapshot();
      window.Statamic.$toast.error('Aktualisierung fehlgeschlagen.');
    }
  }

  function undoLastMutation() {
    if (mutationHistory.length === 0) {
      return;
    }

    const previousSections = popUndoSnapshot();
    if (!previousSections) {
      return;
    }

    if (setSections(window.Statamic, previousSections)) {
      window.Statamic.$toast.success('Letzte Mutation wurde rueckgaengig gemacht.');
      return;
    }

    // Restore history entry when applying snapshot fails.
    mutationHistory.push(previousSections);
    window.Statamic.$toast.error('Undo fehlgeschlagen.');
  }

  function getSectionIdAtIndex(index) {
    const sections = libGetSections(window.Statamic);
    if (!sections || sections.length <= index) {
      return null;
    }

    return getSectionId(sections[index]) ?? null;
  }

  function logSectionById(sectionId) {
    const sections = libGetSections(window.Statamic);

    if (!sections) {
      window.Statamic.$toast.error('Publish state wurde nicht gefunden.');
      return;
    }

    const section = sections.find((s) => getSectionId(s) === sectionId);
    if (!section) {
      console.warn(`[SectionTools] Section with id "${sectionId}" not found.`);
      return;
    }

    console.log(`[SectionTools] Section (id: ${sectionId}):`, JSON.stringify(section, null, 2));
  }

  function getNodeId(node) {
    return node?._id ?? node?.id ?? node?.key ?? node?.attrs?.id ?? null;
  }

  function findElementById(node, targetId, path = []) {
    if (!node || typeof node !== 'object') {
      return null;
    }

    if (getNodeId(node) === targetId) {
      return { element: node, path };
    }

    if (Array.isArray(node)) {
      for (let index = 0; index < node.length; index += 1) {
        const found = findElementById(node[index], targetId, [...path, index]);
        if (found) {
          return found;
        }
      }

      return null;
    }

    for (const [key, value] of Object.entries(node)) {
      const found = findElementById(value, targetId, [...path, key]);
      if (found) {
        return found;
      }
    }

    return null;
  }

  function getBlueprintHandleForElement(element) {
    if (!element || typeof element !== 'object') {
      return null;
    }

    if (element.type === 'set' && typeof element?.attrs?.values?.type === 'string') {
      return element.attrs.values.type;
    }

    return typeof element.type === 'string' ? element.type : null;
  }

  function simplifyBlueprintNode(node) {
    if (node == null) {
      return undefined;
    }

    if (Array.isArray(node)) {
      const simplifiedItems = node
        .map((item) => simplifyBlueprintNode(item))
        .filter((item) => item !== undefined);

      return simplifiedItems.length > 0 ? simplifiedItems : undefined;
    }

    if (typeof node !== 'object') {
      return undefined;
    }

    const simplified = {};

    if (typeof node.display === 'string') simplified.display = node.display;
    if (typeof node.handle === 'string') simplified.handle = node.handle;
    if (typeof node.type === 'string') simplified.type = node.type;
    if (typeof node.input_type === 'string') simplified.input_type = node.input_type;
    if (Object.prototype.hasOwnProperty.call(node, 'placeholder') && node.placeholder != null && node.placeholder !== '') {
      simplified.placeholder = node.placeholder;
    }
    if (typeof node.component === 'string') simplified.component = node.component;
    if (typeof node.prefix === 'string' && node.prefix !== '') simplified.prefix = node.prefix;
    if (node.required === true) simplified.required = true;
    if (Object.prototype.hasOwnProperty.call(node, 'default') && node.default != null && node.default !== '') {
      simplified.default = node.default;
    }
    if (typeof node.character_limit === 'number' && node.character_limit > 0) {
      simplified.character_limit = node.character_limit;
    }

    if (Array.isArray(node.options) && node.options.length > 0) {
      simplified.options = node.options;
    } else if (
      node.options
      && typeof node.options === 'object'
      && !Array.isArray(node.options)
      && Object.keys(node.options).length > 0
    ) {
      simplified.options = node.options;
    }

    const isAssetsField = node.type === 'assets' || node.component === 'assets';
    if (isAssetsField) {
      if (typeof node.max_files === 'number' && node.max_files > 0) {
        simplified.max_files = node.max_files;
      }

      if (typeof node.container === 'string' && node.container !== '') {
        simplified.container = node.container;
      }
    }

    const simplifiedFields = simplifyBlueprintNode(node.fields);
    if (simplifiedFields !== undefined) {
      simplified.fields = simplifiedFields;
    }

    const simplifiedSets = simplifyBlueprintNode(node.sets);
    if (simplifiedSets !== undefined) {
      simplified.sets = simplifiedSets;
    }

    if (Object.keys(simplified).length > 0) {
      return simplified;
    }

    const nested = Object.entries(node)
      .map(([key, value]) => [key, simplifyBlueprintNode(value)])
      .filter(([, value]) => value !== undefined);

    if (nested.length > 0) {
      return Object.fromEntries(nested);
    }

    return undefined;
  }

  function logSection2() {
    const id = getSectionIdAtIndex(1);
    if (!id) {
      console.warn('[SectionTools] No section at index 2.');
      return;
    }

    logSectionById(id);
  }

  function logPageBrief() {
    const publishStore = libGetPublishStore(window.Statamic);
    const values = publishStore?.values;

    if (!values) {
      window.Statamic.$toast.error('Publish state wurde nicht gefunden.');
      return;
    }

    const pageBrief = buildPageBrief(values, {
      statamic: window.Statamic,
      publishMeta: publishStore?.meta,
    });

    if (!pageBrief) {
      window.Statamic.$toast.error('Page brief konnte nicht erstellt werden.');
      return;
    }

    console.log('[SectionTools] Page brief:', JSON.stringify(pageBrief, null, 2));
  }

  function logSectionBlueprintById(sectionId) {
    const publishStore = libGetPublishStore(window.Statamic);

    const values = publishStore?.values;
    if (!values) {
      window.Statamic.$toast.error('Publish state wurde nicht gefunden.');
      return;
    }

    const match = findElementById(values, sectionId);
    if (!match) {
      console.warn(`[SectionTools] Element with id "${sectionId}" not found.`);
      return;
    }

    const sectionType = getBlueprintHandleForElement(match.element);
    if (!sectionType) {
      console.warn(`[SectionTools] Element "${sectionId}" has no blueprint handle/type.`);
      return;
    }

    const blueprint = publishStore?.blueprint;
    if (!blueprint) {
      window.Statamic.$toast.error('Page blueprint wurde nicht gefunden.');
      return;
    }

    function findSetConfig(node) {
      // Statamic CP serializes sets as arrays of objects with explicit `handle` properties
      // (via Sets::preProcessConfig). Walk the whole tree and match by handle.
      if (!node || typeof node !== 'object') {
        return null;
      }

      if (Array.isArray(node)) {
        for (const item of node) {
          const found = findSetConfig(item);
          if (found) return found;
        }
        return null;
      }

      if (
        typeof node.handle === 'string' &&
        node.handle === sectionType &&
        Array.isArray(node.fields) &&
        Object.prototype.hasOwnProperty.call(node, 'display')
      ) {
        return node;
      }

      for (const value of Object.values(node)) {
        const found = findSetConfig(value);
        if (found) return found;
      }

      return null;
    }

    const setConfig = findSetConfig(blueprint);

    if (!setConfig) {
      console.warn(`[SectionTools] No blueprint entry for type "${sectionType}".`);
      return;
    }

    const compactSetConfig = simplifyBlueprintNode(setConfig) ?? {};

    console.log(
      `[SectionTools] Element blueprint (id: ${sectionId}, type: ${sectionType}, path: ${match.path.join(' > ')}):`,
      JSON.stringify(compactSetConfig, null, 2),
    );
  }

  function logSection2Blueprint() {
    const id = getSectionIdAtIndex(1);
    if (!id) {
      console.warn('[SectionTools] No section at index 2.');
      return;
    }

    logSectionBlueprintById(id);
  }

  async function searchAssets(query) {
    const cpRoot = window.Statamic?.$config?.get('cp_root') ?? '/cp';
    const token = document.querySelector('meta[name="csrf-token"]')?.getAttribute('content') ?? '';

    try {
      const res = await fetch(
        `${cpRoot}/section-tools/assets/search?query=${encodeURIComponent(query)}`,
        {
          headers: {
            Accept: 'application/json',
            'X-CSRF-TOKEN': token,
            'X-Requested-With': 'XMLHttpRequest',
          },
        },
      );

      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const results = await res.json();
      console.log(`[SectionTools] Asset search ("${query}"):`, JSON.stringify(results, null, 2));
    } catch (err) {
      console.error('[SectionTools] Asset search error:', err);
      window.Statamic.$toast.error('Asset-Suche fehlgeschlagen.');
    }
  }

  function logAssetSearch() {
    searchAssets('Oberschenkel');
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

  function runUiSync() {
    syncButtons();
  }

  function scheduleUiSync() {
    if (uiSyncQueued) {
      return;
    }

    uiSyncQueued = true;
    window.requestAnimationFrame(() => {
      uiSyncQueued = false;
      runUiSync();
    });
  }

  window.Statamic.booting(() => {
    console.info('[SectionTools] Statamic.booting fired');

    runUiSync();

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
