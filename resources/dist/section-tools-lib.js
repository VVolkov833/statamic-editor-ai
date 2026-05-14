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

      const typeTemplate = sectionsMeta.new?.[section?.type];
      sectionsMeta.existing[id] = templateId
        ? cloneValue(sectionsMeta.existing[templateId])
        : typeTemplate
          ? cloneValue(typeTemplate)
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

export function commitField(statamic, handle, value) {
  if (handle === 'sections') return setSections(statamic, value);

  const s = statamic ?? window.Statamic;
  const moduleNames = getPublishModulesWithSections(s);
  if (!moduleNames.length) return false;

  let applied = false;
  for (const moduleName of moduleNames) {
    try {
      s.$store.commit(`publish/${moduleName}/setFieldValue`, { handle, value });
      s.$store.dispatch(`publish/${moduleName}/setFieldValue`, { handle, value });
      applied = true;
    } catch {}
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

// ── BRIEF BUILDER ─────────────────────────────────────────────────────────

function cleanDisplay(display) {
  if (typeof display !== 'string') return '';
  // Strip trailing handle annotations: " _ [text]", " [accordion_image]", etc.
  return display.replace(/\s*[_-]?\s*\[[\w_]+\]\s*$/, '').trim();
}

function plainOneLiner(value) {
  if (value === null || value === undefined) return null;
  const text = String(value)
    .replace(/<[^>]*>/g, '')
    .replace(/\r?\n|\r/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text || null;
}

function resolveOptionLabel(key, options) {
  if (key === null || key === undefined || key === '') return null;
  const candidate = String(key);

  if (Array.isArray(options)) {
    for (const opt of options) {
      if (!opt || typeof opt !== 'object') continue;
      const optKey = String(opt.key ?? opt.value ?? opt.handle ?? opt.id ?? '');
      if (optKey === candidate) {
        return String(opt.value ?? opt.label ?? opt.key ?? candidate);
      }
    }
  } else if (options && typeof options === 'object') {
    if (Object.prototype.hasOwnProperty.call(options, candidate)) {
      return String(options[candidate]) || candidate;
    }
  }

  return candidate;
}

function resolveOptionValue(rawValue, options) {
  if (rawValue === null || rawValue === undefined || rawValue === '') return null;

  if (Array.isArray(rawValue)) {
    const labels = rawValue.map((v) => resolveOptionLabel(v, options)).filter(Boolean);
    return labels.length > 0 ? labels.join(', ') : null;
  }

  return resolveOptionLabel(rawValue, options);
}

function assetBriefValue(raw) {
  if (!raw) return null;
  if (typeof raw === 'string') {
    const parts = raw.split('/');
    return parts[parts.length - 1] || raw;
  }
  if (typeof raw === 'object') {
    const path = raw.url || raw.path || raw.id;
    if (typeof path === 'string') {
      const parts = path.split('/');
      return parts[parts.length - 1] || path;
    }
  }
  return null;
}

function pmNodesToText(nodes) {
  if (!Array.isArray(nodes)) return '';
  return nodes.map((node) => {
    if (!node || typeof node !== 'object') return '';
    if (node.type === 'text') return node.text || '';
    if (node.type === 'hardBreak') return ' ';
    if (Array.isArray(node.content)) return pmNodesToText(node.content);
    return '';
  }).join('').replace(/\s+/g, ' ').trim();
}

function briefBard(nodes, setConfigs) {
  if (!Array.isArray(nodes) || nodes.length === 0) return null;

  const segments = [];
  const textBuffer = [];

  function flushText() {
    const text = textBuffer.splice(0).join(' ').replace(/\s+/g, ' ').trim();
    if (text) segments.push({ type: 'text', value: text });
  }

  for (const node of nodes) {
    if (node.type === 'set') {
      flushText();
      const setValues = node.attrs?.values ?? {};
      const setType = setValues.type;
      const setConfig = setType ? setConfigs[setType] : null;

      const segment = { type: 'set', set_type: setType };
      const display = cleanDisplay(setConfig?.display);
      if (display) segment.display = display;

      const fields = briefFieldsFromConfig(setValues, setConfig?.fields ?? [], setConfigs);
      if (Object.keys(fields).length > 0) segment.fields = fields;

      segments.push(segment);
    } else {
      const text = pmNodesToText([node]);
      if (text) textBuffer.push(text);
    }
  }

  flushText();

  return segments.length > 0 ? segments : null;
}

const SKIP_TYPES = new Set(['spacer', 'revealer', 'section', 'code', 'width', 'icon', 'html']);
const TEXT_TYPES = new Set(['text', 'textarea', 'markdown', 'yaml', 'slug', 'hidden']);
const OPTION_TYPES = new Set(['select', 'radio', 'button_group', 'dictionary']);

function briefSingleField(handle, rawValue, fieldConfig, setConfigs) {
  if (rawValue === null || rawValue === undefined || rawValue === '' || rawValue === false) return null;

  const type = fieldConfig?.type ?? '';

  if (SKIP_TYPES.has(type)) return null;

  if (['integer', 'float'].includes(type)) {
    return typeof rawValue === 'number' && rawValue !== 0 ? rawValue : null;
  }

  if (TEXT_TYPES.has(type)) {
    return plainOneLiner(rawValue);
  }

  // video field stores a YouTube/external URL as a string
  if (type === 'video') {
    return typeof rawValue === 'string' ? rawValue : null;
  }

  if (type === 'bard') {
    return briefBard(Array.isArray(rawValue) ? rawValue : [], setConfigs);
  }

  // Detect unlabeled content arrays (bard or replicator without explicit type declaration)
  if (type === '' && Array.isArray(rawValue) && rawValue.length > 0) {
    const first = rawValue[0];
    if (first && typeof first === 'object') {
      const PM_NODE_TYPES = new Set(['paragraph', 'heading', 'set', 'bulletList', 'orderedList', 'blockquote', 'hardBreak', 'horizontalRule', 'codeBlock', 'image']);
      if (PM_NODE_TYPES.has(first.type)) {
        return briefBard(rawValue, setConfigs);
      }
      if (typeof first.type === 'string' && (first._id !== undefined || first.id !== undefined)) {
        const items = rawValue
          .filter((item) => item && typeof item === 'object')
          .map((item) => briefReplicatorItem(item, setConfigs))
          .filter(Boolean);
        return items.length > 0 ? items : null;
      }
    }
  }

  if (OPTION_TYPES.has(type)) {
    return resolveOptionValue(rawValue, fieldConfig?.options);
  }

  if (type === 'range') {
    return typeof rawValue === 'number' ? rawValue : null;
  }

  if (type === 'checkbox') {
    if (Array.isArray(rawValue) && fieldConfig?.options) {
      return resolveOptionValue(rawValue, fieldConfig.options);
    }
    return rawValue ? true : null;
  }

  if (type === 'toggle') {
    return (rawValue === true || rawValue === 1) ? true : null;
  }

  if (type === 'color') {
    return typeof rawValue === 'string' ? rawValue : null;
  }

  if (type === 'date') {
    return typeof rawValue === 'string' ? rawValue : null;
  }

  if (type === 'link') {
    if (typeof rawValue === 'string') return rawValue || null;
    if (rawValue && typeof rawValue === 'object') {
      return rawValue.url || rawValue.href || rawValue.value || null;
    }
    return null;
  }

  if (type === 'assets') {
    const arr = Array.isArray(rawValue) ? rawValue : [rawValue];
    const files = arr.map(assetBriefValue).filter(Boolean);
    return files.length > 0 ? files : null;
  }

  if (type === 'entries') {
    const arr = Array.isArray(rawValue) ? rawValue : [rawValue];
    if (arr.length === 0) return null;
    return arr.map((e) => {
      if (!e) return null;
      if (typeof e === 'string') return e;
      return e.slug || e.id || e.handle || String(e);
    }).filter(Boolean);
  }

  if (type === 'terms') {
    const arr = Array.isArray(rawValue) ? rawValue : [rawValue];
    return arr.length > 0 ? arr.join(', ') : null;
  }

  if (type === 'replicator') {
    if (!Array.isArray(rawValue) || rawValue.length === 0) return null;
    const items = rawValue
      .filter((item) => item && typeof item === 'object')
      .map((item) => briefReplicatorItem(item, setConfigs))
      .filter(Boolean);
    return items.length > 0 ? items : null;
  }

  if (type === 'grid') {
    if (!Array.isArray(rawValue) || rawValue.length === 0) return null;
    const rowFields = fieldConfig?.fields ?? [];
    const rows = rawValue
      .filter((row) => row && typeof row === 'object')
      .map((row) => briefFieldsFromConfig(row, rowFields, setConfigs))
      .filter((row) => Object.keys(row).length > 0);
    return rows.length > 0 ? rows : null;
  }

  if (type === 'group') {
    if (!rawValue || typeof rawValue !== 'object') return null;
    const grouped = briefFieldsFromConfig(rawValue, fieldConfig?.fields ?? [], setConfigs);
    return Object.keys(grouped).length > 0 ? grouped : null;
  }

  // Scalar fallbacks
  if (typeof rawValue === 'boolean') return rawValue || null;
  if (typeof rawValue === 'number') return rawValue !== 0 ? rawValue : null;
  if (typeof rawValue === 'string') return plainOneLiner(rawValue);

  return null;
}

function briefFieldsFromConfig(values, fieldEntries, setConfigs) {
  const result = {};
  if (!values || typeof values !== 'object') return result;

  if (Array.isArray(fieldEntries) && fieldEntries.length > 0) {
    for (const entry of fieldEntries) {
      const handle = entry?.handle;
      if (!handle) continue;

      const fieldConfig = (entry?.field && typeof entry.field === 'object')
        ? { ...entry.field, ...(entry.config ?? {}) }
        : { ...(entry.config ?? {}) };

      const rawValue = values[handle];
      const brief = briefSingleField(handle, rawValue, fieldConfig, setConfigs);
      if (brief !== null && brief !== undefined) {
        result[handle] = brief;
      }
    }
  } else {
    // Fallback: heuristic walk when no field config is available
    for (const [handle, rawValue] of Object.entries(values)) {
      if (['_id', 'id', 'type', 'enabled', 'key'].includes(handle)) continue;
      const brief = briefSingleField(handle, rawValue, {}, setConfigs);
      if (brief !== null && brief !== undefined) {
        result[handle] = brief;
      }
    }
  }

  return result;
}

function briefReplicatorItem(item, setConfigs) {
  if (!item || typeof item !== 'object') return null;

  const setType = item.type;
  const setConfig = setType ? setConfigs[setType] : null;
  const display = cleanDisplay(setConfig?.display);

  const fields = briefFieldsFromConfig(item, setConfig?.fields ?? [], setConfigs);

  // Spread fields first so metadata keys always win over any same-named field handles
  const result = { ...fields, type: setType };
  const id = item._id ?? item.id;
  if (id) result._id = id;
  if (display) result.display = display;
  if (item.enabled === false) result.enabled = false;

  return result;
}

function collectBriefSetConfigs(node, map) {
  if (!node || typeof node !== 'object') return;

  if (Array.isArray(node)) {
    node.forEach((item) => collectBriefSetConfigs(item, map));
    return;
  }

  // Case 1: node carries handle as an explicit property (e.g. resolved blueprint field entries)
  if (
    typeof node.handle === 'string' &&
    Array.isArray(node.fields) &&
    Object.prototype.hasOwnProperty.call(node, 'display') &&
    !map[node.handle]
  ) {
    map[node.handle] = { display: node.display, fields: node.fields };
  }

  for (const [key, value] of Object.entries(node)) {
    if (!value || typeof value !== 'object') continue;

    // Case 2: Statamic stores sets as key-value maps where the key IS the handle.
    // Identify set-config objects by having a string display and a fields array but no handle property.
    if (
      !Array.isArray(value) &&
      typeof value.display === 'string' &&
      Array.isArray(value.fields) &&
      typeof value.handle === 'undefined' &&
      !map[key]
    ) {
      map[key] = { display: value.display, fields: value.fields };
    }

    collectBriefSetConfigs(value, map);
  }
}

function getBriefSetConfigs(blueprint) {
  const map = {};
  collectBriefSetConfigs(blueprint, map);
  return map;
}

function getMainTabFields(blueprint) {
  if (!blueprint || typeof blueprint !== 'object') return [];

  const tabs = blueprint.tabs;
  if (!tabs || typeof tabs !== 'object') return [];

  // Prefer tab named 'main', else use the first tab
  const tab = tabs.main ?? Object.values(tabs)[0];
  if (!tab) return [];

  const fields = [];
  for (const section of (Array.isArray(tab.sections) ? tab.sections : [])) {
    for (const field of (Array.isArray(section.fields) ? section.fields : [])) {
      if (field?.handle) fields.push(field);
    }
  }

  return fields;
}

export function buildSectionBrief(section, options = {}) {
  if (!section || typeof section !== 'object') return null;
  const s = options.statamic ?? window.Statamic;
  const publishStore = getPublishStore(s);
  const setConfigs = getBriefSetConfigs(publishStore?.blueprint);
  return briefReplicatorItem(section, setConfigs);
}

export function buildPageBrief(values, options = {}) {
  const s = options.statamic ?? window.Statamic;
  const publishStore = getPublishStore(s);
  const blueprint = publishStore?.blueprint;
  const setConfigs = getBriefSetConfigs(blueprint);
  const mainFields = getMainTabFields(blueprint);

  const sourceValues = values ?? publishStore?.values ?? {};
  if (!sourceValues || typeof sourceValues !== 'object') return null;

  // Build a field-config lookup from blueprint for type-aware processing
  const fieldConfigByHandle = {};
  for (const entry of mainFields) {
    const h = entry?.handle;
    if (!h) continue;
    fieldConfigByHandle[h] = (entry?.field && typeof entry.field === 'object')
      ? { ...entry.field, ...(entry.config ?? {}) }
      : { ...(entry.config ?? {}) };
  }

  // Blueprint fields first, then guarantee core content handles are always included
  const CORE_HANDLES = ['title', 'header', 'sections'];
  const seen = new Set();
  const handlesToProcess = [
    ...mainFields.map((e) => e?.handle).filter(Boolean),
    ...CORE_HANDLES.filter((h) => sourceValues[h] !== undefined),
  ].filter((h) => {
    if (seen.has(h)) return false;
    seen.add(h);
    return true;
  });

  const brief = {};

  for (const handle of handlesToProcess) {
    const rawValue = sourceValues[handle];
    if (rawValue === undefined) continue;
    const fieldConfig = fieldConfigByHandle[handle] ?? {};
    const value = briefSingleField(handle, rawValue, fieldConfig, setConfigs);
    if (value !== null && value !== undefined) {
      brief[handle] = value;
    }
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
