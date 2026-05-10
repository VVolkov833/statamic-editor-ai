function getStatamic(statamic) {
  return statamic ?? window.Statamic;
}

export function cloneValue(value) {
  if (typeof structuredClone === 'function') {
    return structuredClone(value);
  }

  return JSON.parse(JSON.stringify(value));
}

export function uid() {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let value = '';

  for (let i = 0; i < 8; i += 1) {
    value += alphabet[Math.floor(Math.random() * alphabet.length)];
  }

  return value;
}

export function getSectionId(section) {
  return section?._id ?? section?.id ?? section?.key ?? null;
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

export function getPublishModulesWithSections(statamic) {
  const s = getStatamic(statamic);
  const publish = s?.$store?.state?.publish;
  if (!publish) {
    return [];
  }

  return Object.entries(publish)
    .filter(([, moduleState]) => Array.isArray(moduleState?.values?.sections))
    .map(([moduleName]) => moduleName);
}

export function getPublishStore(statamic) {
  const s = getStatamic(statamic);
  const moduleNames = getPublishModulesWithSections(s);
  if (moduleNames.length > 0) {
    return s?.$store?.state?.publish?.[moduleNames[0]] ?? null;
  }

  return s?.$store?.state?.publish?.base ?? null;
}

export function getSections(statamic) {
  const values = getPublishStore(statamic)?.values;

  if (!values) {
    return null;
  }

  return Array.isArray(values.sections) ? [...values.sections] : [];
}

export function syncSectionsMeta(meta, previousSections, nextSections) {
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

export function setSections(statamic, nextSections) {
  const s = getStatamic(statamic);
  const moduleNames = getPublishModulesWithSections(s);
  if (moduleNames.length === 0) {
    return false;
  }

  let applied = false;

  for (const moduleName of moduleNames) {
    const moduleState = s?.$store?.state?.publish?.[moduleName];
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
      s.$store.commit(`publish/${moduleName}/setFieldValue`, {
        handle: 'sections',
        value: safeSections,
      });
      s.$store.dispatch(`publish/${moduleName}/setFieldValue`, {
        handle: 'sections',
        value: safeSections,
      });
      applied = true;
    } catch {
      // Keep trying setValues and other modules.
    }

    try {
      s.$store.commit(`publish/${moduleName}/setValues`, nextValues);
      s.$store.dispatch(`publish/${moduleName}/setValues`, nextValues);

      const nextMeta = syncSectionsMeta(moduleState.meta, previousSections, safeSections);
      if (nextMeta) {
        s.$store.commit(`publish/${moduleName}/setMeta`, nextMeta);
        s.$store.dispatch(`publish/${moduleName}/setMeta`, nextMeta);
      }

      applied = true;
    } catch {
      // Keep trying other modules.
    }
  }

  return applied;
}

export function assignFreshSectionIdentity(section) {
  const nextId = uid();

  section._id = nextId;

  if ('id' in section) {
    delete section.id;
  }

  if ('key' in section) {
    delete section.key;
  }
}

export function createQuoteSet(statamic) {
  const sections = getSections(statamic) ?? [];
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

export function addSection(statamic, section, position) {
  const sections = getSections(statamic);
  if (!sections) {
    return false;
  }

  const targetIndex = Number.isInteger(position)
    ? Math.min(Math.max(0, position), sections.length)
    : sections.length;

  sections.splice(targetIndex, 0, section);
  return setSections(statamic, sections);
}

export function swapSections(statamic, firstId, secondId) {
  const sections = getSections(statamic);
  if (!sections) {
    return false;
  }

  const firstIndex = sections.findIndex((section) => getSectionId(section) === firstId);
  const secondIndex = sections.findIndex((section) => getSectionId(section) === secondId);

  if (firstIndex < 0 || secondIndex < 0) {
    return false;
  }

  [sections[firstIndex], sections[secondIndex]] = [sections[secondIndex], sections[firstIndex]];
  return setSections(statamic, sections);
}

export function cloneSection(statamic, sectionId, insertAfter = true) {
  const sections = getSections(statamic);
  if (!sections) {
    return false;
  }

  const sourceIndex = sections.findIndex((section) => getSectionId(section) === sectionId);
  if (sourceIndex < 0) {
    return false;
  }

  const cloned = cloneValue(sections[sourceIndex]);
  assignFreshSectionIdentity(cloned);

  sections.splice(insertAfter ? sourceIndex + 1 : sourceIndex, 0, cloned);
  return setSections(statamic, sections);
}

export function insertQuoteAsSecondSection(statamic) {
  return addSection(statamic, createQuoteSet(statamic), 1);
}

export function swapSections2And3(statamic) {
  const sections = getSections(statamic);
  if (!sections || sections.length < 3) {
    return false;
  }

  const firstId = getSectionId(sections[1]);
  const secondId = getSectionId(sections[2]);

  if (!firstId || !secondId) {
    return false;
  }

  return swapSections(statamic, firstId, secondId);
}

function humanizeHandle(value) {
  if (!value || typeof value !== 'string') {
    return '';
  }

  return value
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function collectSetConfigs(node, map) {
  if (!node || typeof node !== 'object') {
    return;
  }

  if (Array.isArray(node)) {
    node.forEach((item) => collectSetConfigs(item, map));
    return;
  }

  const looksLikeSetConfig = typeof node.handle === 'string'
    && Array.isArray(node.fields)
    && Object.prototype.hasOwnProperty.call(node, 'display');

  if (looksLikeSetConfig && !map[node.handle]) {
    map[node.handle] = {
      display: node.display,
      fields: node.fields,
    };
  }

  for (const value of Object.values(node)) {
    collectSetConfigs(value, map);
  }
}

function getSetConfigs(statamic) {
  const blueprint = getPublishStore(statamic)?.blueprint;
  const map = {};

  collectSetConfigs(blueprint, map);

  return map;
}

function findPreviewBySetId(meta, setId) {
  function walk(node) {
    if (!node || typeof node !== 'object') {
      return null;
    }

    if (Array.isArray(node)) {
      for (const item of node) {
        const found = walk(item);
        if (found) {
          return found;
        }
      }

      return null;
    }

    if (node.previews && typeof node.previews === 'object' && node.previews[setId]) {
      return node.previews[setId];
    }

    for (const value of Object.values(node)) {
      const found = walk(value);
      if (found) {
        return found;
      }
    }

    return null;
  }

  return walk(meta);
}

function normalizePreviewValue(value) {
  if (['null', '[]', '{}', ''].includes(JSON.stringify(value))) {
    return null;
  }

  if (typeof value === 'string') {
    return value;
  }

  if (Array.isArray(value) && typeof value[0] === 'string') {
    return value.join(', ');
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }

  return JSON.stringify(value);
}

function buildSetPreviewText(previews, setConfig, showFieldPreviews = true) {
  if (!previews || typeof previews !== 'object') {
    return '';
  }

  const fieldConfigs = Array.isArray(setConfig?.fields) ? setConfig.fields : [];

  return Object.entries(previews)
    .filter(([handle]) => handle !== '_')
    .filter(([handle]) => {
      const config = fieldConfigs.find((field) => field?.handle === handle) ?? {};

      return config.replicator_preview === undefined
        ? showFieldPreviews
        : config.replicator_preview;
    })
    .map(([, value]) => normalizePreviewValue(value))
    .filter(Boolean)
    .join(' / ');
}

function buildButtonItemBrief(item, context) {
  if (!item || typeof item !== 'object') {
    return '';
  }

  const buttonType = item.type;
  const buttonConfig = context.setConfigs[buttonType] ?? null;
  const label = buttonConfig?.display || humanizeHandle(buttonType);

  if (buttonType === 'button_custom' && typeof item.title === 'string' && item.title.trim()) {
    return `${label} ${item.title.trim()}`;
  }

  return label;
}

function buildAccordionEntryBrief(entry, context) {
  if (!entry || typeof entry !== 'object') {
    return '';
  }

  const title = typeof entry.title === 'string' ? entry.title.trim() : '';
  const text = extractProseMirrorText(entry.text, context);

  return [title, text].filter(Boolean).join(' ');
}

function extractSetValueBrief(setType, values, context, setId) {
  if (!values || typeof values !== 'object') {
    return '';
  }

  const parts = [];

  if (setType === 'buttons' && Array.isArray(values.buttons)) {
    const buttonLabels = values.buttons
      .map((item) => buildButtonItemBrief(item, context))
      .filter(Boolean);

    if (buttonLabels.length > 0) {
      parts.push(buttonLabels.join(' '));
    }
  }

  if (setType === 'accordion' && Array.isArray(values.entries)) {
    const entryLabels = values.entries
      .map((entry) => buildAccordionEntryBrief(entry, context))
      .filter(Boolean);

    if (entryLabels.length > 0) {
      parts.push(entryLabels.join(' '));
    }
  }

  return parts.join(' ').trim();
}

function renderSetLabel(node, context) {
  const setType = node?.attrs?.values?.type;
  if (!setType) {
    return '';
  }

  const setConfig = context.setConfigs[setType] ?? null;
  const setDisplay = setConfig?.display || humanizeHandle(setType);
  const setId = node?.attrs?.id;
  const previews = setId ? findPreviewBySetId(context.publishMeta, setId) : null;
  const previewText = setType === 'accordion' ? '' : buildSetPreviewText(previews, setConfig, context.showFieldPreviews);
  const valueBrief = extractSetValueBrief(setType, node?.attrs?.values, context, setId);

  return [setDisplay, previewText, valueBrief].filter(Boolean).join(' ');
}

function extractProseMirrorText(nodes, context) {
  if (!Array.isArray(nodes)) {
    return '';
  }

  return nodes
    .map((node) => {
      if (node.type === 'text') {
        return node.text ?? '';
      }

      if (node.type === 'set') {
        return renderSetLabel(node, context);
      }

      const childText = extractProseMirrorText(node.content, context);

      if (node.type === 'listItem') {
        return `- ${childText}`;
      }

      return childText;
    })
    .filter(Boolean)
    .join(' ')
    .replace(/\s+([.,:;!?])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildTileBrief(tile, context) {
  const brief = { type: tile.type, _id: tile._id };

  if (Array.isArray(tile.text) && tile.text.length > 0) {
    brief.text = extractProseMirrorText(tile.text, context);
  }

  return brief;
}

export function buildSectionBrief(section, options = {}) {
  if (!section || typeof section !== 'object') {
    return null;
  }

  const context = {
    publishMeta: options.publishMeta ?? getPublishStore(options.statamic)?.meta ?? null,
    setConfigs: options.setConfigs ?? getSetConfigs(options.statamic),
    showFieldPreviews: options.showFieldPreviews ?? true,
  };

  const brief = { type: section.type, _id: section._id };

  if (Array.isArray(section.tiles)) {
    brief.tiles = section.tiles.map((tile) => buildTileBrief(tile, context));
  }

  if (Array.isArray(section.text)) {
    brief.text = extractProseMirrorText(section.text, context);
  }

  return brief;
}

export function cloneThirdSectionAfterwards(statamic) {
  const sections = getSections(statamic);
  if (!sections || sections.length < 3) {
    return false;
  }

  const targetId = getSectionId(sections[2]);
  if (!targetId) {
    return false;
  }

  return cloneSection(statamic, targetId, true);
}
