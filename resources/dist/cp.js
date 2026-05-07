(() => {
  const BUTTON_GROUP_ID = 'section-tools-live-preview-buttons';
  const viteHost = window.location.hostname || '127.0.0.1';
  const vitePort = window.location.port || '5173';

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

  function getPublishStore() {
    return window.Statamic?.$store?.state?.publish?.base ?? null;
  }

  function cloneValue(value) {
    if (typeof structuredClone === 'function') {
      return structuredClone(value);
    }

    return JSON.parse(JSON.stringify(value));
  }

  function getSections() {
    const values = getPublishStore()?.values;

    if (!values) {
      return null;
    }

    return Array.isArray(values.sections) ? [...values.sections] : [];
  }

  function isPagesEntryScreen() {
    const isPagesCollectionRoute = window.location.pathname.includes('/collections/pages');
    const hasSectionsInPublishState = Array.isArray(getPublishStore()?.values?.sections);

    return isPagesCollectionRoute && hasSectionsInPublishState;
  }

  function setSections(nextSections) {
    const publishStore = getPublishStore();

    if (!publishStore?.values) {
      return;
    }

    window.Statamic.$store.dispatch('publish/base/setValues', {
      ...publishStore.values,
      sections: nextSections,
    });
  }

  function uid(prefix = 'st') {
    const random = Math.random().toString(36).slice(2, 8);
    return `${prefix}${Date.now().toString(36)}${random}`;
  }

  function createQuoteSet() {
    const sections = getSections() ?? [];
    const quoteTemplate = sections.find((section) => section?.type === 'quote');

    const quote = quoteTemplate ? cloneValue(quoteTemplate) : {
      id: uid('cpq'),
      type: 'quote',
      enabled: true,
      text: 'Test-Zitat aus Live Preview',
      author: 'CP Test',
    };

    quote.id = uid('cpq');
    quote.type = 'quote';
    quote.enabled = typeof quote.enabled === 'boolean' ? quote.enabled : true;
    quote.text = 'Test-Zitat aus Live Preview';
    quote.author = 'CP Test';

    return quote;
  }

  function insertQuoteAsSecondSection() {
    const sections = getSections();

    if (!sections) {
      window.Statamic.$toast.error('Publish state wurde nicht gefunden.');
      return;
    }

    sections.splice(Math.min(1, sections.length), 0, createQuoteSet());
    setSections(sections);

    window.Statamic.$toast.success('Zitat als zweiter Abschnitt eingefuegt.');
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

    [sections[1], sections[2]] = [sections[2], sections[1]];
    setSections(sections);

    window.Statamic.$toast.success('Abschnitte 2 und 3 wurden getauscht.');
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

    const cloned = cloneValue(sections[2]);
    cloned.id = uid('cps');

    sections.splice(3, 0, cloned);
    setSections(sections);

    window.Statamic.$toast.success('Abschnitt 3 wurde geklont und eingefuegt.');
  }

  function createButton(label, onClick) {
    const button = document.createElement('button');

    button.type = 'button';
    button.className = 'btn';
    button.textContent = label;
    button.addEventListener('click', onClick);

    return button;
  }

  function createButtonGroup() {
    const wrapper = document.createElement('div');

    wrapper.id = BUTTON_GROUP_ID;
    wrapper.style.display = 'flex';
    wrapper.style.gap = '0.5rem';

    wrapper.appendChild(createButton('Quote +', insertQuoteAsSecondSection));
    wrapper.appendChild(createButton('Swap 2<->3', swapSections2And3));
    wrapper.appendChild(createButton('Clone 3 +1', cloneThirdSectionAfterwards));

    return wrapper;
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
    mountButtons();
    unmountButtonsWhenOutOfScope();
  }

  window.Statamic.booting(() => {
    console.info('[SectionTools] Statamic.booting fired');

    syncButtons();

    const observer = new MutationObserver(() => {
      syncButtons();
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
    });
  });
})();
