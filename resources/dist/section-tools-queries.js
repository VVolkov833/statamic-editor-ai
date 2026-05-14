import {
  getPublishStore as libGetPublishStore,
  getSections as libGetSections,
  getSectionId,
  buildPageBrief,
} from './section-tools-lib';

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

export function simplifyBlueprintNode(node) {
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

export function getSectionIdAtIndex(index) {
  const sections = libGetSections(window.Statamic);
  if (!sections || sections.length <= index) {
    return null;
  }

  return getSectionId(sections[index]) ?? null;
}

export function logSectionById(sectionId) {
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

export function logSectionBlueprintById(sectionId) {
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

export function logSection2() {
  const id = getSectionIdAtIndex(1);
  if (!id) {
    console.warn('[SectionTools] No section at index 2.');
    return;
  }

  logSectionById(id);
}

export function logSection2Blueprint() {
  const id = getSectionIdAtIndex(1);
  if (!id) {
    console.warn('[SectionTools] No section at index 2.');
    return;
  }

  logSectionBlueprintById(id);
}

export function logPageBrief() {
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

export async function searchAssets(query) {
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

export function logAssetSearch() {
  searchAssets('Oberschenkel');
}

export function extractBlueprintSets(blueprint) {
  const sets = {};

  function traverse(node, ancestorSetHandle) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach((item) => traverse(item, ancestorSetHandle)); return; }
    if (
      typeof node.handle === 'string' &&
      typeof node.display === 'string' &&
      node.type == null &&
      Array.isArray(node.fields) &&
      node.fields.length > 0
    ) {
      const entry = {
        display: node.display,
        handle: node.handle,
        fields: node.fields
          .filter((f) => f && typeof f.handle === 'string')
          .map((f) => {
            const slim = { handle: f.handle };
            const t = f.type ?? f.component ?? '';
            if (t) slim.type = t;
            if (f.display) slim.display = f.display;
            if (f.required) slim.required = true;
            if (typeof f.max_files === 'number') slim.max_files = f.max_files;
            if (f.options) slim.options = f.options;
            if (f.character_limit) slim.character_limit = f.character_limit;
            return slim;
          }),
      };
      if (ancestorSetHandle) entry._parent_set = ancestorSetHandle;
      sets[node.handle] = entry;
      // Traverse this set's fields with this set as the ancestor, so nested set types
      // inherit _parent_set = this set's handle.
      node.fields.forEach((field) => traverse(field, node.handle));
      return;
    }
    Object.values(node).forEach((v) => traverse(v, ancestorSetHandle));
  }

  traverse(blueprint, null);
  return sets;
}

export async function fetchAssetsForAI(query) {
  const cpRoot = window.Statamic?.$config?.get('cp_root') ?? '/cp';
  const res = await fetch(
    `${cpRoot}/section-tools/assets/search?query=${encodeURIComponent(query)}`,
    { headers: { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' } },
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}
