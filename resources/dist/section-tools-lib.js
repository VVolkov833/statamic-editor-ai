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

function getReplicatorSetConfigs(fieldConfig) {
  const sets = fieldConfig?.sets;
  if (!sets || typeof sets !== 'object') {
    return {};
  }

  const map = {};

  Object.values(sets).forEach((group) => {
    const groupSets = group?.sets;
    if (!groupSets || typeof groupSets !== 'object') {
      return;
    }

    Object.entries(groupSets).forEach(([setHandle, setConfig]) => {
      if (!map[setHandle]) {
        map[setHandle] = {
          display: setConfig?.display,
          fields: Array.isArray(setConfig?.fields) ? setConfig.fields : [],
        };
      }
    });
  });

  return map;
}

function extractUrlFromAssetValue(value) {
  if (!value || typeof value !== 'object') {
    return null;
  }

  if (typeof value.url === 'string' && value.url.trim()) {
    return value.url.trim();
  }

  if (typeof value.permalink === 'string' && value.permalink.trim()) {
    return value.permalink.trim();
  }

  if (typeof value.path === 'string' && value.path.trim()) {
    const path = value.path.trim();
    return path.startsWith('/') ? path : `/${path}`;
  }

  return null;
}

function findAssetUrlById(node, id) {
  function walk(value, depth = 0) {
    if (!value || depth > 7) {
      return null;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        const found = walk(item, depth + 1);
        if (found) {
          return found;
        }
      }

      return null;
    }

    if (typeof value !== 'object') {
      return null;
    }

    if (Object.prototype.hasOwnProperty.call(value, id)) {
      const maybeUrl = extractUrlFromAssetValue(value[id]);
      if (maybeUrl) {
        return maybeUrl;
      }
    }

    const maybeDirectUrl = extractUrlFromAssetValue(value);
    if (maybeDirectUrl && (value.id === id || value._id === id || value.handle === id)) {
      return maybeDirectUrl;
    }

    for (const nested of Object.values(value)) {
      const found = walk(nested, depth + 1);
      if (found) {
        return found;
      }
    }

    return null;
  }

  return walk(node);
}

function extractAssetUrls(value, context) {
  if (!value) {
    return [];
  }

  const items = Array.isArray(value) ? value : [value];
  const urls = [];

  for (const item of items) {
    if (typeof item === 'string') {
      if (item.startsWith('http://') || item.startsWith('https://') || item.startsWith('/')) {
        urls.push(item);
        continue;
      }

      const resolved = findAssetUrlById(context.publishMeta, item)
        || findAssetUrlById(context.statamic?.$store?.state, item);

      if (resolved) {
        urls.push(resolved);
      } else if (item.trim()) {
        // Keep unresolved asset IDs visible so assigned assets are still represented.
        urls.push(item.trim());
      }

      continue;
    }

    const url = extractUrlFromAssetValue(item);
    if (url) {
      urls.push(url);
    }
  }

  return [...new Set(urls)];
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

function findEntryPreviewById(meta, entryId) {
  function walk(node, depth = 0) {
    if (!node || depth > 8) {
      return null;
    }

    if (Array.isArray(node)) {
      for (const item of node) {
        const found = walk(item, depth + 1);
        if (found) {
          return found;
        }
      }

      return null;
    }

    if (typeof node !== 'object') {
      return null;
    }

    if (Object.prototype.hasOwnProperty.call(node, entryId)) {
      return node[entryId];
    }

    for (const value of Object.values(node)) {
      const found = walk(value, depth + 1);
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

function normalizeScalarValue(value) {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === 'string') {
    const normalized = value.trim();
    return normalized ? normalized : null;
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }

  return null;
}

function toPlainText(value) {
  if (value === null || value === undefined) {
    return null;
  }

  const text = String(value)
    .replace(/<[^>]*>/g, ' ')
    .replace(/["'`´“”„«»]/g, '')
    .replace(/\r?\n|\r/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return text || null;
}

function getOptionLabel(option, raw) {
  if (!option) {
    return null;
  }

  const candidate = String(raw);

  if (typeof option === 'string') {
    return option === candidate ? option : null;
  }

  if (option && typeof option === 'object') {
    if (Object.prototype.hasOwnProperty.call(option, candidate)) {
      return toPlainText(option[candidate]);
    }

    const optionKey = option.key ?? option.value ?? option.handle ?? option.id;
    if (optionKey !== undefined && String(optionKey) === candidate) {
      return toPlainText(option.value ?? option.label ?? option.title ?? optionKey);
    }
  }

  return null;
}

function resolveOptionValue(rawValue, fieldConfig) {
  if (rawValue === null || rawValue === undefined || rawValue === '' || rawValue === false) {
    return null;
  }

  const options = fieldConfig?.options;
  const optionList = Array.isArray(options)
    ? options
    : (options && typeof options === 'object' ? [options] : []);

  if (Array.isArray(rawValue)) {
    const labels = rawValue
      .map((item) => {
        if (item === null || item === undefined || item === '' || item === false) {
          return null;
        }

        const found = optionList
          .map((option) => getOptionLabel(option, item))
          .find(Boolean);

        return found ?? toPlainText(item);
      })
      .filter(Boolean);

    return labels.length > 0 ? labels.join(' ') : null;
  }

  const found = optionList
    .map((option) => getOptionLabel(option, rawValue))
    .find(Boolean);

  return found ?? toPlainText(rawValue);
}

function flattenToPlainText(value, seen = new Set()) {
  if (value === null || value === undefined || value === '' || value === false) {
    return '';
  }

  if (typeof value === 'string' || typeof value === 'number') {
    return toPlainText(value) ?? '';
  }

  if (typeof value === 'boolean') {
    return value ? 'true' : '';
  }

  if (Array.isArray(value)) {
    return value
      .map((item) => flattenToPlainText(item, seen))
      .filter(Boolean)
      .join(' ')
      .trim();
  }

  if (typeof value === 'object') {
    if (seen.has(value)) {
      return '';
    }

    seen.add(value);

    const text = Object.entries(value)
      .filter(([key]) => !['_id', 'id', 'type', 'enabled', 'display'].includes(key))
      .map(([, nested]) => flattenToPlainText(nested, seen))
      .filter(Boolean)
      .join(' ')
      .trim();

    seen.delete(value);
    return text;
  }

  return '';
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

function buildButtonItemData(item, context) {
  if (!item || typeof item !== 'object') {
    return null;
  }

  const type = item.type;
  const buttonConfig = context.setConfigs[type] ?? null;
  const label = buttonConfig?.display || humanizeHandle(type);

  return {
    type,
    label,
    title: typeof item.title === 'string' && item.title.trim() ? item.title.trim() : null,
    link: typeof item.link === 'string' && item.link.trim() ? item.link.trim() : null,
    url: typeof item.url === 'string' && item.url.trim() ? item.url.trim() : null,
  };
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
  if (!tile || typeof tile !== 'object') {
    return null;
  }

  const brief = { type: tile.type, _id: tile._id };
  const tileConfig = tile.type ? context.setConfigs[tile.type] : null;
  const tileFields = buildFieldsBrief(tile, tileConfig?.fields, context);
  const tileText = toPlainText(flattenToPlainText(tileFields));
  const tileFallbackText = toPlainText(extractFallbackObjectText(tile, context));

  if (Object.keys(tileFields).length > 0) {
    brief.fields = tileFields;
  }

  if (tileText) {
    brief.text = tileText;
  } else if (tileFallbackText) {
    brief.text = tileFallbackText;
  } else if (Array.isArray(tile.text) && tile.text.length > 0) {
    brief.text = toPlainText(extractProseMirrorText(tile.text, context));
  }

  return brief;
}

function extractFallbackObjectText(value, context) {
  if (!value || typeof value !== 'object') {
    return null;
  }

  if (Array.isArray(value)) {
    const parts = value
      .map((item) => {
        if (typeof item === 'string') {
          return item.trim();
        }

        if (Array.isArray(item)) {
          return extractProseMirrorText(item, context);
        }

        if (item && typeof item === 'object') {
          return extractFallbackObjectText(item, context);
        }

        return null;
      })
      .filter(Boolean);

    return parts.length > 0 ? parts.join(' ') : null;
  }

  const parts = [];

  Object.entries(value).forEach(([key, nested]) => {
    if (['_id', 'id', 'type', 'enabled'].includes(key)) {
      return;
    }

    if (Array.isArray(nested)) {
      if (nested.length > 0 && nested[0] && typeof nested[0] === 'object' && nested[0].type === 'paragraph') {
        const text = extractProseMirrorText(nested, context);
        if (text) {
          parts.push(text);
        }
        return;
      }

      const urls = extractAssetUrls(nested, context);
      if (urls.length > 0) {
        parts.push(urls.join(' '));
        return;
      }

      const nestedText = extractFallbackObjectText(nested, context);
      if (nestedText) {
        parts.push(nestedText);
      }

      return;
    }

    if (nested && typeof nested === 'object') {
      const nestedText = extractFallbackObjectText(nested, context);
      if (nestedText) {
        parts.push(nestedText);
      }
      return;
    }

    if (/(title|headline|text|content|author|name|url|link)/i.test(key)) {
      const scalar = normalizeScalarValue(nested);
      if (scalar !== null) {
        parts.push(String(scalar));
      }
    }
  });

  return parts.length > 0 ? parts.join(' ') : null;
}

function extractTableText(value) {
  if (!value) {
    return null;
  }

  const lines = [];

  const consumeRow = (row) => {
    if (Array.isArray(row)) {
      const line = row
        .map((cell) => (cell === null || cell === undefined ? '' : String(cell).trim()))
        .filter(Boolean)
        .join(' | ');

      if (line) {
        lines.push(line);
      }
      return;
    }

    if (row && typeof row === 'object') {
      const line = Object.values(row)
        .map((cell) => (cell === null || cell === undefined ? '' : String(cell).trim()))
        .filter(Boolean)
        .join(' | ');

      if (line) {
        lines.push(line);
      }
    }
  };

  if (Array.isArray(value)) {
    value.forEach(consumeRow);
  } else if (typeof value === 'object') {
    const rows = Array.isArray(value.rows)
      ? value.rows
      : (Array.isArray(value.data) ? value.data : []);
    rows.forEach(consumeRow);
  }

  return lines.length > 0 ? lines.join('\n') : null;
}

function extractFieldValue(handle, rawValue, fieldConfig, context) {
  const fieldType = typeof fieldConfig?.type === 'string' ? fieldConfig.type : '';
  const fieldDisplay = fieldConfig?.display ?? humanizeHandle(handle);

  if (rawValue === null || rawValue === undefined || rawValue === '' || rawValue === false) {
    return null;
  }

  // Skip these field types entirely (except code which gets a note)
  if (['code', 'revealer', 'width', 'icon', 'float', 'integer', 'collections', 'navs', 'structures', 'taxonomies', 'taxonomy_terms', 'user_groups', 'user_roles', 'users', 'array', 'entries', 'sites', 'form'].includes(fieldType)) {
    return null;
  }

  // Text-like fields -> plain single-line text.
  if (fieldType === 'bard' || (Array.isArray(rawValue) && rawValue[0]?.type === 'paragraph')) {
    return toPlainText(extractProseMirrorText(rawValue, context));
  }

  // Markdown -> strip to plain text
  if (fieldType === 'markdown' && typeof rawValue === 'string') {
    return toPlainText(rawValue.replace(/[#*_`\[\]()]/g, ' '));
  }

  // Text -> plain text
  if (fieldType === 'text' && typeof rawValue === 'string') {
    return toPlainText(rawValue);
  }

  // Textarea -> plain text
  if (fieldType === 'textarea' && typeof rawValue === 'string') {
    return toPlainText(rawValue);
  }

  // Table -> sequential plain text
  if (fieldType === 'table') {
    return toPlainText(extractTableText(rawValue));
  }

  // Color → as plain text
  if (fieldType === 'color' && typeof rawValue === 'string') {
    return toPlainText(rawValue);
  }

  // Date → as plain text
  if (fieldType === 'date' && typeof rawValue === 'string') {
    return toPlainText(rawValue);
  }

  // Hidden → print value or default
  if (fieldType === 'hidden') {
    const value = rawValue ?? fieldConfig?.default;
    return toPlainText(value);
  }

  // HTML → if not script/style, plain text
  if (fieldType === 'html' && typeof rawValue === 'string') {
    const isScript = /^<\s*(script|style)\b/i.test(rawValue);
    if (isScript) {
      return null;
    }

    return toPlainText(rawValue);
  }

  // YAML → plain text
  if (fieldType === 'yaml' && typeof rawValue === 'string') {
    return toPlainText(rawValue);
  }

  // Video → URL/value text
  if (fieldType === 'video' && typeof rawValue === 'string') {
    return toPlainText(rawValue);
  }

  // Link -> include available text/url parts.
  if (fieldType === 'link') {
    if (typeof rawValue === 'string') {
      return toPlainText(rawValue);
    }

    if (rawValue && typeof rawValue === 'object') {
      const parts = [
        rawValue.title,
        rawValue.text,
        rawValue.url,
        rawValue.href,
        rawValue.value,
      ]
        .filter((part) => typeof part === 'string' && part.trim())
        .map((part) => part.trim());

      return parts.length > 0 ? toPlainText([...new Set(parts)].join(' ')) : null;
    }
  }

  // Option-like fields -> selected option content.
  if (['select', 'radio', 'button_group', 'dictionary', 'range'].includes(fieldType)) {
    return resolveOptionValue(rawValue, fieldConfig);
  }

  // Checkbox/Toggle -> print value label when enabled/selected.
  if (fieldType === 'toggle') {
    return rawValue ? fieldDisplay : null;
  }

  if (fieldType === 'checkbox') {
    if (Array.isArray(rawValue)) {
      return resolveOptionValue(rawValue, fieldConfig);
    }

    return rawValue ? fieldDisplay : null;
  }

  // Assets -> keep resolved values.
  if (fieldType === 'assets' || handle === 'medium') {
    const urls = extractAssetUrls(rawValue, context);
    return urls.length > 0 ? toPlainText(urls.join(' ')) : null;
  }

  if (fieldType === 'replicator' && Array.isArray(rawValue)) {
    const replicatorSetConfigs = getReplicatorSetConfigs(fieldConfig);
    const merged = rawValue
      .map((item) => {
        if (!item || typeof item !== 'object') {
          return null;
        }

        const setType = item.type;
        const setConfig = setType ? replicatorSetConfigs[setType] : null;
        const nested = buildFieldsBrief(item, setConfig?.fields, context);
        return flattenToPlainText(nested);
      })
      .filter(Boolean)
      .join(' ');

    return toPlainText(merged);
  }

  if (fieldType === 'group' && rawValue && typeof rawValue === 'object') {
    const nested = buildFieldsBrief(rawValue, fieldConfig?.fields, context);
    return toPlainText(flattenToPlainText(nested));
  }

  if (fieldType === 'grid' && Array.isArray(rawValue)) {
    const rows = rawValue
      .map((row) => {
        if (!row || typeof row !== 'object') {
          return null;
        }

        const nested = buildFieldsBrief(row, fieldConfig?.fields, context);
        return flattenToPlainText(nested);
      })
      .filter(Boolean);

    return rows.length > 0 ? toPlainText(rows.join(' ')) : null;
  }

  if (Array.isArray(rawValue)) {
    const assets = extractAssetUrls(rawValue, context);
    if (assets.length > 0) {
      return toPlainText(assets.join(' '));
    }

    return toPlainText(flattenToPlainText(rawValue));
  }

  if (rawValue && typeof rawValue === 'object') {
    const nested = buildFieldsBrief(rawValue, fieldConfig?.fields, context);
    if (Object.keys(nested).length > 0) {
      return toPlainText(flattenToPlainText(nested));
    }

    return toPlainText(extractFallbackObjectText(rawValue, context));
  }

  return toPlainText(normalizeScalarValue(rawValue));
}

function buildFieldsBrief(values, fieldEntries, context) {
  if (!values || typeof values !== 'object') {
    return {};
  }

  const result = {};

  if (Array.isArray(fieldEntries) && fieldEntries.length > 0) {
    fieldEntries.forEach((fieldEntry) => {
      const handle = fieldEntry?.handle;
      if (!handle) {
        return;
      }

      const fieldConfig = fieldEntry?.field && typeof fieldEntry.field === 'object'
        ? { ...fieldEntry.field, ...(fieldEntry?.config ?? {}) }
        : { ...(fieldEntry?.config ?? {}) };

      const value = extractFieldValue(handle, values[handle], fieldConfig, context);
      if (value !== null) {
        result[handle] = value;
      }
    });
  }

  if (Object.keys(result).length === 0) {
    Object.entries(values).forEach(([handle, value]) => {
      if (['_id', 'id', 'type', 'enabled'].includes(handle)) {
        return;
      }

      const extracted = extractFieldValue(handle, value, {}, context);
      if (extracted !== null) {
        result[handle] = extracted;
      }
    });
  }

  return result;
}

function buildItemBrief(item, context, configMap = null) {
  if (!item || typeof item !== 'object') {
    return null;
  }

  const itemType = item.type;
  const itemConfig = (configMap && itemType ? configMap[itemType] : null)
    ?? (itemType ? context.setConfigs[itemType] : null)
    ?? null;

  const brief = {
    type: itemType,
    _id: item._id,
  };

  if (itemConfig?.display) {
    brief.display = itemConfig.display;
  }

  const fieldConfigs = Array.isArray(itemConfig?.fields) ? itemConfig.fields : [];
  const extractedFields = {};

  if (Array.isArray(item.tiles) && !brief.tiles) {
    brief.tiles = item.tiles.map((tile) => buildTileBrief(tile, context));
  }

  if (item.type === 'medium') {
    const mediumUrls = item.medium && Array.isArray(item.medium)
      ? extractAssetUrls(item.medium, context)
      : [];

    if (mediumUrls.length > 0) {
      brief.medium_url = mediumUrls[0];
      if (mediumUrls.length > 1) {
        brief.medium_urls = mediumUrls;
      }
    }
  }

  for (const fieldEntry of fieldConfigs) {
    const handle = fieldEntry?.handle;
    if (!handle) {
      continue;
    }

    const fieldConfig = fieldEntry?.field && typeof fieldEntry.field === 'object'
      ? { ...fieldEntry.field, ...(fieldEntry?.config ?? {}) }
      : { ...(fieldEntry?.config ?? {}) };
    const value = extractFieldValue(handle, item[handle], fieldConfig, context);

    if (value === null) {
      continue;
    }

    extractedFields[handle] = value;
  }

  if (Object.keys(extractedFields).length > 0) {
    brief.fields = extractedFields;
  }

  const textFromFields = toPlainText(flattenToPlainText(extractedFields));

  // Avoid duplicate output: when structured fields exist, do not add a second text summary.
  if (Object.keys(extractedFields).length === 0) {
    if (textFromFields) {
      brief.text = textFromFields;
    } else {
      const fallbackText = toPlainText(extractFallbackObjectText(item, context));
      if (fallbackText) {
        brief.text = fallbackText;
      }
    }
  }

  return brief;
}

export function buildSectionBrief(section, options = {}) {
  if (!section || typeof section !== 'object') {
    return null;
  }

  const context = {
    statamic: options.statamic ?? window.Statamic,
    publishMeta: options.publishMeta ?? getPublishStore(options.statamic)?.meta ?? null,
    setConfigs: options.setConfigs ?? getSetConfigs(options.statamic),
    showFieldPreviews: options.showFieldPreviews ?? true,
  };

  return buildItemBrief(section, context);
}

export function buildPageBrief(values, options = {}) {
  const sourceValues = values ?? getPublishStore(options.statamic)?.values ?? null;
  if (!sourceValues || typeof sourceValues !== 'object') {
    return null;
  }

  const context = {
    statamic: options.statamic ?? window.Statamic,
    publishMeta: options.publishMeta ?? getPublishStore(options.statamic)?.meta ?? null,
    setConfigs: options.setConfigs ?? getSetConfigs(options.statamic),
    showFieldPreviews: options.showFieldPreviews ?? true,
  };

  const headerItems = Array.isArray(sourceValues.header) ? sourceValues.header : [];
  const sections = Array.isArray(sourceValues.sections) ? sourceValues.sections : [];

  return {
    title: typeof sourceValues.title === 'string' ? sourceValues.title : null,
    header: headerItems.map((item, index) => ({
      index,
      ...buildItemBrief(item, context),
    })),
    sectionCount: sections.length,
    sections: sections.map((section, index) => ({
      index,
      ...buildItemBrief(section, context),
    })),
  };
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
