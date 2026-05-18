import {
  getSections as libGetSections,
  getSectionId,
} from './section-tools-lib';


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
