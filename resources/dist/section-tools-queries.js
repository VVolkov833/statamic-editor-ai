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

// Build a map of setTypeHandle -> rootFieldHandle.
// Mirrors the same detection logic as extractBlueprintSets (handle + display + no type + fields[])
// but is scoped per top-level field so we know which root field each set type belongs to.
export function buildRootFieldMap(blueprint) {
  const result = {};
  function findSets(node, rootHandle, depth) {
    if (!node || typeof node !== 'object' || depth > 8) return;
    if (Array.isArray(node)) { node.forEach((item) => findSets(item, rootHandle, depth)); return; }
    if (
      typeof node.handle === 'string' &&
      typeof node.display === 'string' &&
      node.type == null &&
      Array.isArray(node.fields) &&
      node.fields.length > 0
    ) {
      result[node.handle] = rootHandle;
      node.fields.forEach((f) => findSets(f, rootHandle, depth + 1));
      return;
    }
    try { Object.values(node).forEach((v) => findSets(v, rootHandle, depth + 1)); } catch {}
  }
  try {
    const tabs = blueprint?.tabs;
    if (!tabs) return result;
    for (const tabKey of Object.keys(tabs)) {
      const tab = tabs[tabKey];
      for (const section of (tab?.sections ?? [])) {
        for (const fieldNode of (section?.fields ?? [])) {
          const handle = fieldNode?.handle;
          if (!handle) continue;
          findSets(fieldNode, handle, 0);
        }
      }
    }
  } catch {}
  return result;
}

// Returns an error object if `type` is not valid for `fieldHandle`, null if valid (or unknown).
export function validateSetTypeForField(blueprint, type, fieldHandle) {
  const rootFieldMap = buildRootFieldMap(blueprint);
  const correctField = rootFieldMap[type];
  const validTypes = Object.entries(rootFieldMap)
    .filter(([, f]) => f === fieldHandle)
    .map(([t]) => t);
  if (validTypes.length === 0) return null; // No blueprint info for this field — allow
  if (validTypes.includes(type)) return null; // Valid
  const suggestion = correctField ? ` Use parent: "${correctField}" instead.` : '';
  return {
    error: `Type "${type}" is not valid for field "${fieldHandle}".${suggestion} Valid types for "${fieldHandle}": [${validTypes.join(', ')}]`,
  };
}

export function extractBlueprintSets(blueprint) {
  // Build one level of the sets tree from a Vuex rawSets object.
  // Returns { setHandle: { display, handle, fields, sets? } }
  function extractSetsLevel(rawSets) {
    const result = {};
    if (!rawSets || typeof rawSets !== 'object' || Array.isArray(rawSets)) return result;

    for (const [key, config] of Object.entries(rawSets)) {
      if (!config || typeof config !== 'object') continue;

      // Statamic 4 group: has 'sets' but no 'fields' array
      if (config.sets && !(Array.isArray(config.fields) && config.fields.length > 0)) {
        Object.assign(result, extractSetsLevel(config.sets));
        continue;
      }

      // Set type: no type property, has non-empty fields array
      const isSetDef = config.type == null && Array.isArray(config.fields) && config.fields.length > 0;
      if (!isSetDef) {
        // Transparent wrapper — recurse into object values
        for (const v of Object.values(config)) {
          if (v && typeof v === 'object' && !Array.isArray(v)) Object.assign(result, extractSetsLevel(v));
        }
        continue;
      }

      const handle = typeof config.handle === 'string' ? config.handle : key;
      const fields = config.fields
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
        });

      const entry = { display: config.display ?? handle, handle, fields };

      // Find nested replicator/bard fields and recurse into their sets
      const nestedSets = {};
      for (const f of config.fields) {
        if (!f?.handle) continue;
        const ft = f.type ?? f.component ?? '';
        if ((ft === 'replicator' || ft === 'bard') && f.sets) {
          const nested = extractSetsLevel(f.sets);
          if (Object.keys(nested).length > 0) nestedSets[f.handle] = nested;
        }
      }
      if (Object.keys(nestedSets).length > 0) entry.sets = nestedSets;

      result[handle] = entry;
    }
    return result;
  }

  // Walk blueprint tabs to find root replicator/bard fields and build the tree.
  const tree = {};
  try {
    const tabs = blueprint?.tabs;
    if (!tabs) return tree;
    for (const tab of Object.values(tabs)) {
      for (const section of (tab?.sections ?? [])) {
        for (const fieldNode of (section?.fields ?? [])) {
          const handle = fieldNode?.handle;
          if (!handle) continue;
          const type = fieldNode?.type ?? fieldNode?.component ?? '';
          if ((type === 'replicator' || type === 'bard') && fieldNode.sets) {
            const level = extractSetsLevel(fieldNode.sets);
            if (Object.keys(level).length > 0) tree[handle] = level;
          }
        }
      }
    }
  } catch {}
  return tree;
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
