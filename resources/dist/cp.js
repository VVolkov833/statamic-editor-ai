import {
  insertQuoteAsSecondSection as libInsertQuoteAsSecondSection,
  swapSections2And3 as libSwapSections2And3,
  cloneThirdSectionAfterwards as libCloneThirdSectionAfterwards,
  getPublishStore as libGetPublishStore,
  getSections as libGetSections,
  buildPageBrief,
} from './section-tools-lib';
import { syncSectionToolsUi, persistPanelPositionOnResize } from './section-tools-panel';

(() => {
  const BUTTON_GROUP_ID = 'section-tools-live-preview-buttons';
  const PANEL_ID = 'section-tools-floating-panel';
  const PANEL_HANDLE_ID = 'section-tools-floating-panel-handle';
  const PANEL_MARGIN = 16;
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

  function getPublishModulesWithSections() {
    const publish = window.Statamic?.$store?.state?.publish;
    if (!publish) {
      return [];
    }

    return Object.entries(publish)
      .filter(([, moduleState]) => Array.isArray(moduleState?.values?.sections))
      .map(([moduleName]) => moduleName);
  }

  function getPublishStore() {
    const moduleNames = getPublishModulesWithSections();
    if (moduleNames.length > 0) {
      return window.Statamic?.$store?.state?.publish?.[moduleNames[0]] ?? null;
    }

    return window.Statamic?.$store?.state?.publish?.base ?? null;
  }

  function cloneValue(value) {
    if (typeof structuredClone === 'function') {
      return structuredClone(value);
    }

    return JSON.parse(JSON.stringify(value));
  }

  function getSections() {
    return libGetSections(window.Statamic);
  }

  function isPagesEntryScreen() {
    const isPagesCollectionRoute = window.location.pathname.includes('/collections/pages');
    const hasSectionsInPublishState = Array.isArray(libGetPublishStore(window.Statamic)?.values?.sections);

    return isPagesCollectionRoute && hasSectionsInPublishState;
  }

  function setSections(nextSections) {
    const moduleNames = getPublishModulesWithSections();
    if (moduleNames.length === 0) {
      return false;
    }

    let applied = false;

    for (const moduleName of moduleNames) {
      const moduleState = window.Statamic?.$store?.state?.publish?.[moduleName];
      if (!moduleState?.values) {
        continue;
      }

      const safeSections = Array.isArray(nextSections) ? [...nextSections] : [];
      const previousSections = Array.isArray(moduleState.values.sections)
        ? moduleState.values.sections
        : [];
      const nextValues = {
        ...moduleState.values,
        sections: safeSections,
      };

      try {
        window.Statamic.$store.commit(`publish/${moduleName}/setFieldValue`, {
          handle: 'sections',
          value: safeSections,
        });
        window.Statamic.$store.dispatch(`publish/${moduleName}/setFieldValue`, {
          handle: 'sections',
          value: safeSections,
        });
        applied = true;
      } catch {
        // Keep trying setValues and other modules.
      }

      try {
        window.Statamic.$store.commit(`publish/${moduleName}/setValues`, nextValues);
        window.Statamic.$store.dispatch(`publish/${moduleName}/setValues`, nextValues);

        const nextMeta = syncSectionsMeta(moduleState.meta, previousSections, safeSections);
        if (nextMeta) {
          window.Statamic.$store.commit(`publish/${moduleName}/setMeta`, nextMeta);
          window.Statamic.$store.dispatch(`publish/${moduleName}/setMeta`, nextMeta);
        }

        applied = true;
      } catch {
        // Keep trying other modules.
      }
    }

    return applied;
  }

  function uid() {
    const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let value = '';

    for (let i = 0; i < 8; i += 1) {
      value += alphabet[Math.floor(Math.random() * alphabet.length)];
    }

    return value;
  }

  function getSectionId(section) {
    return section?._id ?? section?.id ?? section?.key ?? null;
  }

  function getNodeId(node) {
    return node?._id ?? node?.id ?? node?.key ?? node?.attrs?.id ?? null;
  }

  function buildDefaultPreview(section) {
    if (section?.type === 'quote') {
      return {
        text: section?.text ?? null,
        author: section?.author ?? null,
        _: null,
      };
    }

    return { _: null };
  }

  function syncSectionsMeta(meta, previousSections, nextSections) {
    if (!meta?.sections || typeof meta.sections !== 'object') {
      return meta;
    }

    const nextMeta = cloneValue(meta);
    const sectionsMeta = nextMeta.sections;

    sectionsMeta.existing = sectionsMeta.existing ?? {};
    sectionsMeta.previews = sectionsMeta.previews ?? {};

    const previousById = new Map((previousSections ?? [])
      .map((section) => [getSectionId(section), section])
      .filter(([id]) => Boolean(id)));

    const existingIds = Object.keys(sectionsMeta.existing);

    for (const section of nextSections) {
      const id = getSectionId(section);
      if (!id) {
        continue;
      }

      if (!sectionsMeta.existing[id]) {
        const templateId = existingIds.find((candidateId) => {
          const candidateSection = previousById.get(candidateId);
          return candidateSection?.type === section?.type;
        }) ?? null;

        sectionsMeta.existing[id] = templateId
          ? cloneValue(sectionsMeta.existing[templateId])
          : { _: '_' };
      }

      if (!sectionsMeta.previews[id]) {
        const templateId = existingIds.find((candidateId) => {
          const candidateSection = previousById.get(candidateId);
          return candidateSection?.type === section?.type && sectionsMeta.previews[candidateId];
        }) ?? null;

        sectionsMeta.previews[id] = templateId
          ? cloneValue(sectionsMeta.previews[templateId])
          : buildDefaultPreview(section);
      }

      if (Array.isArray(sectionsMeta.collapsed) && !sectionsMeta.collapsed.includes(id)) {
        sectionsMeta.collapsed.push(id);
      }
    }

    return nextMeta;
  }

  function assignFreshSectionIdentity(section) {
    const nextId = uid();

    // Replicator items are keyed internally by `_id` in CP state.
    section._id = nextId;

    // Remove alternative identity keys to avoid mixed-shape items.
    if ('id' in section) {
      delete section.id;
    }

    if ('key' in section) {
      delete section.key;
    }
  }

  function createQuoteSet() {
    const sections = getSections() ?? [];
    const quoteTemplate = sections.find((section) => section?.type === 'quote');

    const quote = quoteTemplate ? cloneValue(quoteTemplate) : {
      _id: uid(),
      type: 'quote',
      enabled: true,
      text: 'Test-Zitat aus Live Preview',
      author: 'CP Test',
    };

    assignFreshSectionIdentity(quote);
    quote.type = 'quote';
    quote.enabled = typeof quote.enabled === 'boolean' ? quote.enabled : true;
    quote.text = 'Test-Zitat aus Live Preview';
    quote.author = 'CP Test';

    return quote;
  }

  function pushUndoSnapshot() {
    const sections = getSections();

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
    const sections = getSections();

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
    const sections = getSections();

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

    if (setSections(previousSections)) {
      window.Statamic.$toast.success('Letzte Mutation wurde rueckgaengig gemacht.');
      return;
    }

    // Restore history entry when applying snapshot fails.
    mutationHistory.push(previousSections);
    window.Statamic.$toast.error('Undo fehlgeschlagen.');
  }

  function getSectionIdAtIndex(index) {
    const sections = getSections();
    if (!sections || sections.length <= index) {
      return null;
    }

    return getSectionId(sections[index]) ?? null;
  }

  function logSectionById(sectionId) {
    const sections = getSections();

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

    console.log(
      `[SectionTools] Element blueprint (id: ${sectionId}, type: ${sectionType}, path: ${match.path.join(' > ')}):`,
      JSON.stringify(setConfig, null, 2),
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

  window.SectionTools = window.SectionTools ?? {};
  window.SectionTools.logSectionById = logSectionById;
  window.SectionTools.logBlueprintById = logSectionBlueprintById;

  function createButton(label, onClick) {
    const button = document.createElement('button');

    button.type = 'button';
    button.className = 'btn';
    button.textContent = label;
    button.addEventListener('click', onClick);

    return button;
  }

  function appendDefaultActionButtons(container) {
    container.appendChild(createButton('Quote +', insertQuoteAsSecondSection));
    container.appendChild(createButton('Swap 2<->3', swapSections2And3));
    container.appendChild(createButton('Clone 3 +1', cloneThirdSectionAfterwards));
  }

  function createButtonGroup() {
    const wrapper = document.createElement('div');

    wrapper.id = BUTTON_GROUP_ID;
    wrapper.style.display = 'flex';
    wrapper.style.gap = '0.5rem';

    appendDefaultActionButtons(wrapper);

    return wrapper;
  }

  function createPanelGroup() {
    const wrapper = document.createElement('div');
    wrapper.style.display = 'flex';
    wrapper.style.gap = '6px';
    wrapper.style.flexWrap = 'wrap';

    appendDefaultActionButtons(wrapper);

    return wrapper;
  }

  function readPanelPosition() {
    try {
      const raw = window.localStorage.getItem(panelStorageKey);
      if (!raw) {
        return null;
      }

      const parsed = JSON.parse(raw);
      if (typeof parsed?.x !== 'number' || typeof parsed?.y !== 'number') {
        return null;
      }

      return parsed;
    } catch {
      return null;
    }
  }

  function writePanelPosition(position) {
    try {
      window.localStorage.setItem(panelStorageKey, JSON.stringify(position));
    } catch {
      // Ignore storage quota/privacy failures.
    }
  }

  function getClampedPosition(panel, position) {
    const maxX = Math.max(PANEL_MARGIN, window.innerWidth - panel.offsetWidth - PANEL_MARGIN);
    const maxY = Math.max(PANEL_MARGIN, window.innerHeight - panel.offsetHeight - PANEL_MARGIN);

    return {
      x: Math.min(Math.max(PANEL_MARGIN, position.x), maxX),
      y: Math.min(Math.max(PANEL_MARGIN, position.y), maxY),
    };
  }

  function applyPanelPosition(panel, position) {
    const next = getClampedPosition(panel, position);
    panel.style.left = `${next.x}px`;
    panel.style.top = `${next.y}px`;
    return next;
  }

  function getDefaultPanelPosition(panel) {
    return getClampedPosition(panel, {
      x: window.innerWidth - panel.offsetWidth - 24,
      y: 88,
    });
  }

  function makePanelDraggable(panel, handle) {
    let pointerId = null;
    let deltaX = 0;
    let deltaY = 0;

    handle.addEventListener('pointerdown', (event) => {
      pointerId = event.pointerId;
      const rect = panel.getBoundingClientRect();
      deltaX = event.clientX - rect.left;
      deltaY = event.clientY - rect.top;
      handle.setPointerCapture(pointerId);
      document.body.style.userSelect = 'none';
    });

    handle.addEventListener('pointermove', (event) => {
      if (event.pointerId !== pointerId) {
        return;
      }

      applyPanelPosition(panel, {
        x: event.clientX - deltaX,
        y: event.clientY - deltaY,
      });
    });

    function finishDrag(event) {
      if (event.pointerId !== pointerId) {
        return;
      }

      pointerId = null;
      document.body.style.userSelect = '';
      writePanelPosition({
        x: panel.offsetLeft,
        y: panel.offsetTop,
      });
    }

    handle.addEventListener('pointerup', finishDrag);
    handle.addEventListener('pointercancel', finishDrag);
  }

  function createFloatingPanel() {
    const panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.style.position = 'fixed';
    panel.style.zIndex = '2000';
    panel.style.background = 'var(--bg, #fff)';
    panel.style.border = '1px solid rgba(0, 0, 0, 0.12)';
    panel.style.borderRadius = '10px';
    panel.style.boxShadow = '0 8px 24px rgba(0, 0, 0, 0.16)';
    panel.style.padding = '8px';
    panel.style.display = 'flex';
    panel.style.flexDirection = 'column';
    panel.style.gap = '8px';

    const handle = document.createElement('div');
    handle.id = PANEL_HANDLE_ID;
    handle.textContent = 'Editor AI Assistant';
    handle.style.fontSize = '12px';
    handle.style.fontWeight = '600';
    handle.style.cursor = 'move';
    handle.style.padding = '2px 4px';
    handle.style.color = 'var(--text, #111)';

    panel.appendChild(handle);
    panel.appendChild(createPanelGroup());
    makePanelDraggable(panel, handle);

    return panel;
  }

  function mountFloatingPanel() {
    if (!isPagesEntryScreen() || document.getElementById(PANEL_ID)) {
      return;
    }

    const panel = createFloatingPanel();
    document.body.appendChild(panel);

    const savedPosition = readPanelPosition();
    const initial = savedPosition ?? getDefaultPanelPosition(panel);
    const applied = applyPanelPosition(panel, initial);

    if (!savedPosition) {
      writePanelPosition(applied);
    }
  }

  function unmountFloatingPanelWhenOutOfScope() {
    if (isPagesEntryScreen()) {
      return;
    }

    const panel = document.getElementById(PANEL_ID);
    if (panel) {
      panel.remove();
    }
  }

  function mountButtons() {
    if (!isPagesEntryScreen()) {
      return;
    }

    const livePreviewHeader = document.querySelector('.live-preview-header');

    if (!livePreviewHeader || document.getElementById(BUTTON_GROUP_ID)) {
      return;
    }

    const group = createButtonGroup();
    const controls = livePreviewHeader.querySelector('.flex.items-center');
    const closeButton = controls?.querySelector('.btn-close');

    if (controls && closeButton) {
      controls.insertBefore(group, closeButton);
      return;
    }

    if (controls) {
      controls.appendChild(group);
      return;
    }

    livePreviewHeader.appendChild(group);
  }

  function unmountButtonsWhenOutOfScope() {
    if (isPagesEntryScreen()) {
      return;
    }

    const group = document.getElementById(BUTTON_GROUP_ID);
    if (group) {
      group.remove();
    }
  }

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
