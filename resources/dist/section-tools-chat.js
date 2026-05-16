import { getPublishStore, uid, getPublishModuleNames, cloneValue, commitField } from './section-tools-lib.js';
import { simplifyBlueprintNode, fetchAssetsForAI, extractBlueprintSets, validateSetTypeForField, buildRootFieldMap } from './section-tools-queries.js';
import { pushUndoSnapshot } from './section-tools-mutations.js';

function injectNestedItemMeta(statamic, rootHandle, parentId, field, newItemId, type) {
  const publishStore = getPublishStore(statamic);
  const meta = publishStore?.meta;
  if (!meta) return;

  const rootFieldMeta = meta[rootHandle];
  if (!rootFieldMeta?.existing?.[parentId]) return;

  const parentMeta = rootFieldMeta.existing[parentId];
  const nestedFieldMeta = parentMeta[field];
  if (!nestedFieldMeta) return;

  const typeTemplate = nestedFieldMeta?.new?.[type];

  const updatedMeta = {
    ...meta,
    [rootHandle]: {
      ...rootFieldMeta,
      existing: {
        ...rootFieldMeta.existing,
        [parentId]: {
          ...parentMeta,
          [field]: {
            ...nestedFieldMeta,
            existing: {
              ...(nestedFieldMeta.existing ?? {}),
              [newItemId]: typeTemplate ? cloneValue(typeTemplate) : {},
            },
          },
        },
      },
    },
  };

  const moduleNames = getPublishModuleNames(statamic);
  for (const moduleName of moduleNames) {
    try {
      statamic.$store.commit(`publish/${moduleName}/setMeta`, updatedMeta);
      statamic.$store.dispatch(`publish/${moduleName}/setMeta`, updatedMeta);
    } catch {}
  }
}

function injectTopLevelItemMeta(statamic, rootHandle, newItemId, type) {
  const publishStore = getPublishStore(statamic);
  const meta = publishStore?.meta;
  if (!meta) return;

  const rootFieldMeta = meta[rootHandle];
  if (!rootFieldMeta) return;

  // Prefer copying from an existing item of the same type — Statamic initialized that meta
  // correctly. Fall back to the new[type] template, then to blueprint-derived field stubs.
  let typeTemplate = null;
  const valuesArr = publishStore?.values?.[rootHandle];
  if (Array.isArray(valuesArr)) {
    for (const item of valuesArr) {
      if (item?.type === type && item?._id && rootFieldMeta.existing?.[item._id]) {
        typeTemplate = cloneValue(rootFieldMeta.existing[item._id]);
        break;
      }
    }
  }
  if (!typeTemplate && rootFieldMeta?.new?.[type]) {
    typeTemplate = cloneValue(rootFieldMeta.new[type]);
  }
  if (!typeTemplate) {
    // Build stub from cached blueprint: each field handle → {} so field components
    // receive a defined (if empty) meta object rather than undefined.
    const cachedSets = blueprintDataProvider?.()?.sets ?? {};
    const setDef = cachedSets[type];
    typeTemplate = setDef?.fields?.length
      ? Object.fromEntries(setDef.fields.map((f) => [f.handle, {}]))
      : {};
  }

  const updatedMeta = {
    ...meta,
    [rootHandle]: {
      ...rootFieldMeta,
      existing: {
        ...(rootFieldMeta.existing ?? {}),
        [newItemId]: typeTemplate,
      },
    },
  };

  const moduleNames = getPublishModuleNames(statamic);
  for (const moduleName of moduleNames) {
    try {
      statamic.$store.commit(`publish/${moduleName}/setMeta`, updatedMeta);
      statamic.$store.dispatch(`publish/${moduleName}/setMeta`, updatedMeta);
    } catch {}
  }
}

// Statamic's code fieldtype only watches `value` in readOnly mode — in normal edit
// mode CodeMirror is uncontrolled and ignores external value-prop changes.
// CodeMirror writes the editor instance onto its container DOM element as el.CodeMirror,
// which is more reliable to locate than walking the Vue component tree.
function syncCodeMirrorValues(statamic, itemId, fieldValues) {
  requestAnimationFrame(() => {
    const cmEls = Array.from(document.querySelectorAll('.CodeMirror'));
    if (!cmEls.length) return;

    // Walk up the DOM collecting Vue component instances attached as el.__vue__.
    function collectAncestorVms(startEl, maxDepth = 60) {
      const vms = [];
      let cur = startEl;
      for (let i = 0; i < maxDepth && cur; i++, cur = cur.parentElement) {
        if (cur.__vue__) vms.push(cur.__vue__);
      }
      return vms;
    }

    function getHandle(vm) {
      return vm.$props?.handle ?? vm.$props?.config?.handle ?? vm.$props?.field?.handle ?? null;
    }

    function hasItemId(vm, id) {
      const d = vm.$data ?? {};
      const p = vm.$props ?? {};
      return [d.row, d.item, d.set, d.value, p.row, p.item, p.set, p.value]
        .some((v) => v?._id === id);
    }

    for (const [handle, val] of Object.entries(fieldValues)) {
      if (typeof val !== 'string') continue;

      let cm = null;

      // Primary: find the editor that belongs to our item and matches the handle.
      for (const el of cmEls) {
        const instance = el.CodeMirror;
        if (!instance || typeof instance.setValue !== 'function') continue;
        const ancestors = collectAncestorVms(el);
        if (ancestors.some((vm) => hasItemId(vm, itemId)) && ancestors.some((vm) => getHandle(vm) === handle)) {
          cm = instance;
          break;
        }
      }

      // Fallback: match by handle alone on any editor whose current value differs.
      if (!cm) {
        for (const el of cmEls) {
          const instance = el.CodeMirror;
          if (!instance || typeof instance.setValue !== 'function') continue;
          const ancestors = collectAncestorVms(el);
          if (ancestors.some((vm) => getHandle(vm) === handle) && instance.getValue() !== val) {
            cm = instance;
            break;
          }
        }
      }

      if (cm && cm.getValue() !== val) {
        cm.setValue(val);
        cm.refresh();
      }
    }
  });
}

function getItemId(item) {
  return item?._id ?? item?.id ?? item?.key ?? null;
}

function patchItemInArray(arr, targetId, fields) {
  for (let i = 0; i < arr.length; i++) {
    const item = arr[i];
    if (!item || typeof item !== 'object') continue;
    if (getItemId(item) === targetId) {
      if (item.type === 'set' && item.attrs?.values != null) {
        arr[i] = { ...item, attrs: { ...item.attrs, values: { ...item.attrs.values, ...fields } } };
        return item.attrs.values.type ?? 'set';
      }
      const type = item.type ?? null;
      arr[i] = { ...item, ...fields };
      return type;
    }
    for (const fieldValue of Object.values(item)) {
      if (Array.isArray(fieldValue)) {
        const result = patchItemInArray(fieldValue, targetId, fields);
        if (result !== false) return result;
      }
    }
  }
  return false;
}

function removeItemFromArray(arr, targetId) {
  for (let i = 0; i < arr.length; i++) {
    const item = arr[i];
    if (!item || typeof item !== 'object') continue;
    if (getItemId(item) === targetId) {
      const type = item.type ?? null;
      arr.splice(i, 1);
      return type;
    }
    for (const fieldValue of Object.values(item)) {
      if (Array.isArray(fieldValue)) {
        const result = removeItemFromArray(fieldValue, targetId);
        if (result !== false) return result;
      }
    }
  }
  return false;
}

function findItemWithParent(arr, targetId) {
  for (let i = 0; i < arr.length; i++) {
    const item = arr[i];
    if (!item || typeof item !== 'object') continue;
    if (getItemId(item) === targetId) {
      return { item, parentArray: arr, index: i };
    }
    for (const fieldValue of Object.values(item)) {
      if (Array.isArray(fieldValue)) {
        const found = findItemWithParent(fieldValue, targetId);
        if (found) return found;
      }
    }
  }
  return null;
}

function insertAfterIdOrAppend(arr, newItem, afterId) {
  if (!afterId) { arr.push(newItem); return; }
  const idx = arr.findIndex((i) => getItemId(i) === afterId);
  arr.splice(idx >= 0 ? idx + 1 : arr.length, 0, newItem);
}

function addToParentItem(arr, parentId, fieldHandle, newItem, afterId) {
  for (const item of arr) {
    if (!item || typeof item !== 'object') continue;
    if (getItemId(item) === parentId) {
      if (!Array.isArray(item[fieldHandle])) item[fieldHandle] = [];
      insertAfterIdOrAppend(item[fieldHandle], newItem, afterId);
      return true;
    }
    for (const fieldValue of Object.values(item)) {
      if (Array.isArray(fieldValue) && addToParentItem(fieldValue, parentId, fieldHandle, newItem, afterId)) return true;
    }
  }
  return false;
}

const BARD_BLOCK_TYPES = new Set([
  'paragraph', 'heading', 'bulletList', 'orderedList', 'listItem',
  'blockquote', 'codeBlock', 'horizontalRule', 'set', 'table',
  'tableRow', 'tableCell', 'tableHeader',
]);

function inlineImageToBardSet(src) {
  return { type: 'set', attrs: { id: uid(), values: { type: 'image', enabled: true, image: src ? [src] : [] } } };
}

function sanitizeBardContent(arr, blueprint) {
  if (!Array.isArray(arr)) return arr;
  // Only apply to arrays that look like ProseMirror block content
  if (!arr.some((n) => n && typeof n === 'object' && BARD_BLOCK_TYPES.has(n.type))) return arr;

  // flatMap so a single block node can expand to multiple (e.g. paragraph → paragraph + image sets)
  return arr
    .filter((node) => node != null && typeof node === 'object')
    .flatMap((node) => {
      // TipTap inline image node at block level — promote to bard image set
      if (node.type === 'image') {
        return [inlineImageToBardSet(node.attrs?.src)];
      }

      // Other non-block types — wrap text in paragraph
      if (!BARD_BLOCK_TYPES.has(node.type)) {
        const t = typeof node.text === 'string' ? node.text
          : typeof node.value === 'string' ? node.value : '';
        return [{ type: 'paragraph', content: [{ type: 'text', text: t }] }];
      }

      const result = { ...node };

      // text nodes: fix value→text, ensure text is a string
      if (node.type === 'text') {
        if (result.value !== undefined && result.text === undefined) {
          result.text = result.value;
          delete result.value;
        }
        if (typeof result.text !== 'string') result.text = '';
        return [result];
      }

      // heading: ensure textAlign is present (ProseMirror schema requires it)
      if (node.type === 'heading') {
        result.attrs = { textAlign: 'left', ...node.attrs };
      }

      // paragraph: ensure textAlign is present if attrs exist
      if (node.type === 'paragraph' && node.attrs) {
        result.attrs = { textAlign: 'left', ...node.attrs };
      }

      // bard set: ensure attrs.id; initialize missing sub-fields via blueprint
      if (node.type === 'set' && node.attrs != null) {
        if (!node.attrs.id) result.attrs = { ...node.attrs, id: uid() };
        if (node.attrs.values && blueprint) {
          const setType = node.attrs.values.type;
          if (setType) {
            const defaults = buildItemDefaults(blueprint, setType);
            if (Object.keys(defaults).length) {
              result.attrs = {
                ...result.attrs,
                values: { ...defaults, ...node.attrs.values },
              };
            }
          }
        }
        return [result];
      }

      // Recurse into content — extract any inline image nodes and promote to block-level bard sets
      if (Array.isArray(node.content)) {
        const imageSets = [];
        result.content = node.content
          .filter((n) => n != null && typeof n === 'object')
          .filter((inline) => {
            if (inline.type === 'image') {
              imageSets.push(inlineImageToBardSet(inline.attrs?.src));
              return false;
            }
            return true;
          })
          .map((inline) => {
            if (inline.type !== 'text') return inline;
            const fixed = { ...inline };
            if (fixed.value !== undefined && fixed.text === undefined) {
              fixed.text = fixed.value;
              delete fixed.value;
            }
            if (typeof fixed.text !== 'string') fixed.text = '';
            return fixed;
          });
        // If paragraph became empty after extracting images, drop it and return just the sets
        if (result.content.length === 0 && imageSets.length > 0) return imageSets;
        return [result, ...imageSets];
      }

      return [result];
    });
}

function injectReplicatorItemIds(arr) {
  return arr.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
    const patched = { ...item };
    if (!patched._id) patched._id = uid();
    if (patched.enabled === undefined) patched.enabled = true;
    return patched;
  });
}

function getSetFieldTypes(blueprint, type, parentType) {
  if (!blueprint || !type) return {};

  // Collect all set-type nodes matching `type`, tracking their immediate set-type ancestor.
  // When multiple set types share the same handle (e.g. a section type and a tile type both
  // named "text"), parentType disambiguates which one is relevant.
  const candidates = [];
  function findFields(node, ancestorSetHandle) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach((item) => findFields(item, ancestorSetHandle)); return; }
    if (typeof node.handle === 'string' && node.type == null && Array.isArray(node.fields) && node.fields.length > 0) {
      if (node.handle === type) candidates.push({ fields: node.fields, ancestor: ancestorSetHandle });
      node.fields.forEach((f) => findFields(f, node.handle));
      return;
    }
    Object.values(node).forEach((v) => findFields(v, ancestorSetHandle));
  }
  findFields(blueprint, null);

  if (!candidates.length) return {};
  const best = parentType
    ? (candidates.find((c) => c.ancestor === parentType) ?? candidates[0])
    : (candidates.find((c) => c.ancestor === null) ?? candidates[0]);
  const config = {};
  for (const field of best.fields) {
    if (field.handle) config[field.handle] = field.type ?? field.component ?? '';
  }
  return config;
}

function buildItemDefaults(blueprint, type, parentType) {
  if (!blueprint || !type) return {};

  const candidates = [];
  function findSetFields(node, ancestorSetHandle) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach((item) => findSetFields(item, ancestorSetHandle)); return; }
    if (typeof node.handle === 'string' && node.type == null && Array.isArray(node.fields) && node.fields.length > 0) {
      if (node.handle === type) candidates.push({ fields: node.fields, ancestor: ancestorSetHandle });
      node.fields.forEach((f) => findSetFields(f, node.handle));
      return;
    }
    Object.values(node).forEach((v) => findSetFields(v, ancestorSetHandle));
  }
  findSetFields(blueprint, null);

  if (!candidates.length) return {};
  const best = parentType
    ? (candidates.find((c) => c.ancestor === parentType) ?? candidates[0])
    : (candidates.find((c) => c.ancestor === null) ?? candidates[0]);

  const defaults = {};
  const ARRAY_TYPES = new Set(['replicator', 'grid', 'bard', 'checkboxes', 'list', 'tags', 'assets']);
  for (const field of best.fields) {
    if (!field.handle) continue;
    const fieldType = field.type ?? field.component ?? '';
    if (ARRAY_TYPES.has(fieldType)) {
      defaults[field.handle] = [];
    } else if (Object.prototype.hasOwnProperty.call(field, 'default') && field.default != null) {
      defaults[field.handle] = field.default;
    }
  }
  return defaults;
}

let messages = [];
let totalInputTokens = 0;
let totalOutputTokens = 0;
let blueprintDataProvider = null;

const MAX_ROUNDS = 8;
const WRITE_TOOLS = new Set(['update_item', 'add_item', 'delete_item', 'move_item', 'update_field']);

const AI_TOOLS = [
  {
    name: 'get_field',
    description: 'Get the raw value of a top-level scalar page field (e.g. title). For sections, tiles, or any replicator item, use get_item instead.',
    input_schema: {
      type: 'object',
      properties: {
        handle: { type: 'string', description: 'Field handle, e.g. "title"' },
      },
      required: ['handle'],
    },
  },
  {
    name: 'get_item',
    description: 'Get the full raw content of any item by its _id — works for sections, tiles, accordion items, or any nested replicator item. Use this before editing bard fields to see the exact ProseMirror structure.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The _id of the item' },
      },
      required: ['id'],
    },
  },
  {
    name: 'get_blueprint',
    description: 'Get the page blueprint — all available item types and their fields. Each entry includes _root_field (the top-level field handle to use as parent in add_item, e.g. "sections" or "schema") and may include _parent_set (for nested types that are only valid inside a specific parent section type). Always use _root_field as parent for top-level add_item calls.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'search_assets',
    description: 'Search for media assets by filename or alt text.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search term to match against filename or alt text' },
      },
      required: ['query'],
    },
  },
  {
    name: 'update_item',
    description: 'Patch fields on any item by its _id — works for sections, tiles, or any nested replicator item at any depth. Only supplied fields change; others are preserved. Never change _id or type.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The _id of the item to update' },
        fields: { type: 'object', description: 'Key-value pairs of fields to patch on the item' },
      },
      required: ['id', 'fields'],
    },
  },
  {
    name: 'add_item',
    description: 'Add a new item to any replicator. "parent" is either a root field handle (e.g. "sections", "schema") for top-level items, or the _id of a parent item for nested items. Use get_blueprint to find the correct root field handle for a type (_root_field key). When parent is an _id, "field" is required — the replicator field name within that parent (e.g. "tiles"). Adding an invalid type to a field returns an error with the correct parent suggestion.',
    input_schema: {
      type: 'object',
      properties: {
        parent: { type: 'string', description: 'Root field handle (e.g. "sections") or parent item _id' },
        type: { type: 'string', description: 'Set type handle for the new item' },
        field: { type: 'string', description: 'Replicator field name within the parent item. Required when parent is an _id.' },
        after_id: { type: 'string', description: 'Insert after this sibling _id. Omit to append.' },
        fields: { type: 'object', description: 'Optional initial field values.' },
      },
      required: ['parent', 'type'],
    },
  },
  {
    name: 'delete_item',
    description: 'Delete any item by its _id — works for sections, tiles, or any nested replicator item.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The _id of the item to delete' },
      },
      required: ['id'],
    },
  },
  {
    name: 'move_item',
    description: 'Reorder an item within its parent by _id. after_id must be a sibling. Omit after_id to move to the first position.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The _id of the item to move' },
        after_id: { type: 'string', description: 'Move after this sibling _id. Omit to move to first position.' },
      },
      required: ['id'],
    },
  },
  {
    name: 'update_field',
    description: 'Update a top-level scalar page field such as title or slug. For sections, tiles, or any replicator item use update_item instead.',
    input_schema: {
      type: 'object',
      properties: {
        handle: { type: 'string', description: 'Field handle, e.g. "title"' },
        value: { description: 'New value to set' },
      },
      required: ['handle', 'value'],
    },
  },
];

async function executeTool(name, input) {
  if (name === 'get_field') {
    const values = getPublishStore(window.Statamic)?.values;
    if (!values) return { error: 'Publish store not found' };
    const value = values[input.handle];
    return value !== undefined ? { [input.handle]: value } : { error: `Field "${input.handle}" not found` };
  }

  if (name === 'get_item') {
    const values = getPublishStore(window.Statamic)?.values;
    if (!values) return { error: 'Publish store not found' };
    for (const rootValue of Object.values(values)) {
      if (!Array.isArray(rootValue)) continue;
      const found = findItemWithParent(rootValue, input.id);
      if (found) return found.item;
    }
    return { error: `Item "${input.id}" not found` };
  }

  if (name === 'get_blueprint') {
    const cached = blueprintDataProvider?.()?.sets;
    if (cached && Object.keys(cached).length > 0) return cached;
    // Fallback: derive from Vuex blueprint (less complete but always available)
    const blueprint = getPublishStore(window.Statamic)?.blueprint;
    if (!blueprint) return { error: 'Blueprint not found' };
    return extractBlueprintSets(blueprint);
  }

  if (name === 'search_assets') {
    return fetchAssetsForAI(input.query);
  }

  if (name === 'update_item') {
    const values = getPublishStore(window.Statamic)?.values;
    if (!values) return { error: 'Publish store not found' };
    const blueprint = getPublishStore(window.Statamic)?.blueprint;
    const normalizedFields = Object.fromEntries(
      Object.entries(input.fields).map(([k, v]) => [k, sanitizeBardContent(v, blueprint)]),
    );
    for (const [rootHandle, rootValue] of Object.entries(values)) {
      if (!Array.isArray(rootValue)) continue;
      const cloned = cloneValue(rootValue);
      const type = patchItemInArray(cloned, input.id, normalizedFields);
      if (type !== false) {
        pushUndoSnapshot();
        commitField(window.Statamic, rootHandle, cloned);
        syncCodeMirrorValues(window.Statamic, input.id, normalizedFields);
        return { ok: true, type };
      }
    }
    return { error: `Item "${input.id}" not found` };
  }

  if (name === 'add_item') {
    const values = getPublishStore(window.Statamic)?.values;
    if (!values) return { error: 'Publish store not found' };
    const { parent, type, field, after_id, fields = {} } = input;
    const blueprint = getPublishStore(window.Statamic)?.blueprint;
    // Pre-scan: if parent is a nested item _id (not a top-level field), find its type so
    // buildItemDefaults picks the correct set definition when handles collide across levels
    // (e.g. section type "text" and tile type "text" both have handle "text").
    // An empty replicator field won't appear in `values` — treat it as top-level if it's a
    // known root field according to the endpoint blueprint or the Vuex-derived map.
    const cachedSets = blueprintDataProvider?.()?.sets ?? {};
    const hasCached = Object.keys(cachedSets).length > 0;
    const knownRootFields = new Set([
      ...Object.values(cachedSets).map((s) => s._root_field).filter(Boolean),
      ...Object.values(blueprint ? buildRootFieldMap(blueprint) : {}),
    ]);
    const isTopLevel = typeof parent === 'string' && (parent in values || knownRootFields.has(parent));

    // Validate the type against the target field's allowed set types.
    // Endpoint data is authoritative; fall back to Vuex-derived validation.
    if (isTopLevel) {
      if (hasCached) {
        const requestedSet = cachedSets[type];
        const correctField = requestedSet?._root_field;
        const validForField = Object.entries(cachedSets)
          .filter(([, s]) => s._root_field === parent && !s._parent_set)
          .map(([t]) => t);
        if (validForField.length > 0 && !validForField.includes(type)) {
          const suggestion = correctField ? ` Use parent: "${correctField}" instead.` : '';
          return { error: `Type "${type}" is not valid for field "${parent}".${suggestion} Valid types for "${parent}": [${validForField.join(', ')}]` };
        }
      } else if (blueprint) {
        const typeError = validateSetTypeForField(blueprint, type, parent);
        if (typeError) return typeError;
      }
    }

    let nestedParentType;
    if (!isTopLevel) {
      for (const rootValue of Object.values(values)) {
        if (!Array.isArray(rootValue)) continue;
        const parentFound = findItemWithParent(cloneValue(rootValue), parent);
        if (parentFound) { nestedParentType = parentFound.item?.type; break; }
      }
    }
    const defaults = buildItemDefaults(blueprint, type, nestedParentType);
    const fieldTypes = getSetFieldTypes(blueprint, type, nestedParentType);
    const REPLICATOR_FIELD_TYPES = new Set(['replicator', 'grid']);
    // Bard fields are stripped — Statamic must initialize new items before bard content
    // can be set. Use update_item after creation to populate bard fields.
    // Replicator/grid arrays get _id+enabled injected into sub-items.
    const skippedBard = [];
    const sanitizedFields = Object.fromEntries(
      Object.entries(fields).filter(([k, v]) => {
        if (fieldTypes[k] === 'bard' && Array.isArray(v)) { skippedBard.push(k); return false; }
        return true;
      }).map(([k, v]) =>
        Array.isArray(v) && REPLICATOR_FIELD_TYPES.has(fieldTypes[k])
          ? [k, injectReplicatorItemIds(v)]
          : [k, v],
      ),
    );
    const newItem = { _id: uid(), type, enabled: true, ...defaults, ...sanitizedFields };

    if (isTopLevel) {
      const cloned = cloneValue(Array.isArray(values[parent]) ? values[parent] : []);
      insertAfterIdOrAppend(cloned, newItem, after_id);
      pushUndoSnapshot();
      // Values must be committed first so Vue knows the set type (and can resolve
      // field configs from the blueprint) when the meta commit triggers re-render.
      commitField(window.Statamic, parent, cloned);
      injectTopLevelItemMeta(window.Statamic, parent, newItem._id, type);
      // Push any string field values into CodeMirror after Vue renders — code fieldtypes
      // are uncontrolled and don't watch their value prop in normal (editable) mode.
      if (Object.keys(sanitizedFields).length > 0) {
        syncCodeMirrorValues(window.Statamic, newItem._id, sanitizedFields);
      }
      return skippedBard.length
        ? { ok: true, id: newItem._id, set_bard_fields: skippedBard }
        : { ok: true, id: newItem._id };
    }

    if (!field) return { error: 'field is required when parent is an item _id' };
    for (const [rootHandle, rootValue] of Object.entries(values)) {
      if (!Array.isArray(rootValue)) continue;
      const cloned = cloneValue(rootValue);
      const parentFound = findItemWithParent(cloned, parent);
      if (parentFound) {
        const parentType = parentFound.item?.type;
        if (parentType && blueprint) {
          const allSets = hasCached ? cachedSets : extractBlueprintSets(blueprint);
          const requestedSet = allSets[type];
          if (requestedSet?._parent_set && requestedSet._parent_set !== parentType) {
            const validTypes = Object.values(allSets)
              .filter((s) => s._parent_set === parentType)
              .map((s) => s.handle)
              .join(', ');
            return {
              error: `Type "${type}" is only valid inside "${requestedSet._parent_set}" sections. Parent "${parent}" is type "${parentType}". Valid types for "${parentType}": [${validTypes || 'see get_blueprint'}]`,
            };
          }
        }
      }
      if (addToParentItem(cloned, parent, field, newItem, after_id)) {
        // Inject meta for the new item before committing values so Vue renders it correctly.
        injectNestedItemMeta(window.Statamic, rootHandle, parent, field, newItem._id, type);
        pushUndoSnapshot();
        commitField(window.Statamic, rootHandle, cloned);
        return skippedBard.length
          ? { ok: true, id: newItem._id, set_bard_fields: skippedBard }
          : { ok: true, id: newItem._id };
      }
    }
    return { error: `Parent "${parent}" not found` };
  }

  if (name === 'delete_item') {
    const values = getPublishStore(window.Statamic)?.values;
    if (!values) return { error: 'Publish store not found' };
    for (const [rootHandle, rootValue] of Object.entries(values)) {
      if (!Array.isArray(rootValue)) continue;
      const cloned = cloneValue(rootValue);
      const type = removeItemFromArray(cloned, input.id);
      if (type !== false) {
        pushUndoSnapshot();
        commitField(window.Statamic, rootHandle, cloned);
        return { ok: true, type, note: `id ${input.id} is no longer in page structure` };
      }
    }
    return { error: `Item "${input.id}" not found` };
  }

  if (name === 'move_item') {
    const values = getPublishStore(window.Statamic)?.values;
    if (!values) return { error: 'Publish store not found' };
    for (const [rootHandle, rootValue] of Object.entries(values)) {
      if (!Array.isArray(rootValue)) continue;
      const cloned = cloneValue(rootValue);
      const found = findItemWithParent(cloned, input.id);
      if (!found) continue;
      const { item, parentArray, index } = found;
      parentArray.splice(index, 1);
      if (!input.after_id) {
        parentArray.unshift(item);
      } else {
        const afterIndex = parentArray.findIndex((i) => getItemId(i) === input.after_id);
        if (afterIndex < 0) return { error: `after_id "${input.after_id}" not found among siblings` };
        parentArray.splice(afterIndex + 1, 0, item);
      }
      pushUndoSnapshot();
      commitField(window.Statamic, rootHandle, cloned);
      return { ok: true, type: item.type ?? null };
    }
    return { error: `Item "${input.id}" not found` };
  }

  if (name === 'update_field') {
    const handle = input.handle;
    // Guard against Claude accidentally double-encoding the value as a JSON string.
    let value = input.value;
    if (typeof value === 'string') {
      try { value = JSON.parse(value); } catch {}
    }
    const moduleNames = getPublishModuleNames(window.Statamic);
    if (!moduleNames.length) return { error: 'Publish store not found' };
    let applied = false;
    for (const moduleName of moduleNames) {
      try {
        window.Statamic.$store.commit(`publish/${moduleName}/setFieldValue`, { handle, value });
        window.Statamic.$store.dispatch(`publish/${moduleName}/setFieldValue`, { handle, value });
        applied = true;
      } catch {}
    }
    return applied ? { ok: true, handle } : { error: 'setFieldValue failed' };
  }

  return { error: `Unknown tool: ${name}` };
}

function getXsrfToken() {
  const match = document.cookie.match(/(?:^|;\s*)XSRF-TOKEN=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : '';
}

async function sendToClaude(allMessages, systemPrompt, tools) {
  const body = { messages: allMessages };
  if (systemPrompt) body.system = systemPrompt;
  if (tools?.length) body.tools = tools;

  const response = await fetch('/cp/section-tools/ai/chat', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-XSRF-TOKEN': getXsrfToken(),
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errBody = await response.json().catch(() => null);
    const detail = errBody?.error?.message ?? errBody?.message ?? '';
    throw new Error(`HTTP ${response.status}${detail ? ': ' + detail : ''}`);
  }

  return response.json();
}

function renderMarkdown(text) {
  function esc(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function inline(s) {
    return s
      .replace(/`([^`\n]+)`/g, '<code style="background:rgba(0,0,0,0.07);padding:1px 4px;border-radius:2px;font-size:11px">$1</code>')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.+?)\*/g, '<em>$1</em>')
      .replace(/~~(.+?)~~/g, '<del>$1</del>')
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer" style="color:#4f46e5;text-decoration:underline">$1</a>');
  }

  const lines = text.split('\n');
  let html = '';
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block
    if (line.startsWith('```')) {
      let code = '';
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) { code += esc(lines[i]) + '\n'; i++; }
      html += `<pre style="background:rgba(0,0,0,0.06);padding:6px 8px;border-radius:3px;overflow-x:auto;font-size:11px;margin:4px 0;white-space:pre"><code>${code.trimEnd()}</code></pre>`;
      i++;
      continue;
    }

    // Horizontal rule
    if (/^(\s*[-*_]){3,}\s*$/.test(line) && line.trim().length >= 3) {
      html += '<hr style="border:none;border-top:1px solid rgba(0,0,0,0.15);margin:6px 0">';
      i++; continue;
    }

    // Heading — use real h tags so copy-paste preserves semantics
    const hm = line.match(/^(#{1,6}) (.+)/);
    if (hm) {
      const level = hm[1].length;
      const sz = ['15px','14px','13px','12px','12px','12px'][level - 1];
      html += `<h${level} style="font-size:${sz};font-weight:700;margin:6px 0 2px;padding:0">${inline(esc(hm[2]))}</h${level}>`;
      i++; continue;
    }

    // Blockquote (supports >> nesting)
    if (line.startsWith('>')) {
      let depth = 0, content = line;
      while (content.startsWith('>')) { depth++; content = content.slice(1).replace(/^ /, ''); }
      html += `<div style="border-left:3px solid rgba(0,0,0,0.2);padding-left:${depth * 10}px;margin:2px 0;color:rgba(0,0,0,0.55);font-style:italic">${inline(esc(content))}</div>`;
      i++; continue;
    }

    // Table — collect consecutive pipe rows
    if (line.startsWith('|')) {
      const rows = [];
      while (i < lines.length && lines[i].startsWith('|')) { rows.push(lines[i]); i++; }
      const isSep = (r) => /^\|[\s\-:|]+\|$/.test(r.trim());
      let tbl = '<table style="border-collapse:collapse;font-size:11px;margin:4px 0;width:100%">';
      rows.forEach((row, ri) => {
        if (isSep(row)) return;
        const isHead = ri === 0 || (ri === 1 && !isSep(rows[0])) && rows.length > 1 && isSep(rows[1] ?? '');
        const cells = row.split('|').slice(1, -1).map(c => c.trim());
        tbl += '<tr>';
        cells.forEach(cell => {
          const tag = (ri === 0) ? 'th' : 'td';
          const style = (ri === 0)
            ? 'padding:3px 7px;border:1px solid rgba(0,0,0,0.15);font-weight:600;background:rgba(0,0,0,0.04);text-align:left'
            : 'padding:3px 7px;border:1px solid rgba(0,0,0,0.12)';
          tbl += `<${tag} style="${style}">${inline(esc(cell))}</${tag}>`;
        });
        tbl += '</tr>';
      });
      tbl += '</table>';
      html += tbl;
      continue;
    }

    // List item (- / * / 1.)
    const lm = line.match(/^(\s*)([-*+]|\d+\.) (.+)/);
    if (lm) {
      const indent = Math.floor(lm[1].length / 2);
      const bullet = /\d+\./.test(lm[2]) ? lm[2] : '•';
      html += `<div style="padding-left:${12 + indent * 12}px;margin:1px 0">${bullet} ${inline(esc(lm[3]))}</div>`;
      i++; continue;
    }

    // Empty line
    if (line.trim() === '') { html += '<div style="height:5px"></div>'; i++; continue; }

    // Regular line
    html += `<div>${inline(esc(line))}</div>`;
    i++;
  }

  return html;
}

function appendMessage(historyEl, role, text) {
  const msg = document.createElement('div');
  msg.style.marginBottom = '4px';
  msg.style.padding = '4px 7px';
  msg.style.borderRadius = '4px';
  msg.style.fontSize = '12px';
  msg.style.lineHeight = '1.5';
  msg.style.wordBreak = 'break-word';

  if (role === 'user') {
    msg.style.background = 'rgba(0,0,0,0.06)';
    msg.style.marginLeft = '16px';
    msg.style.whiteSpace = 'pre-wrap';
    msg.textContent = text;
  } else {
    msg.style.background = 'rgba(99,102,241,0.1)';
    msg.style.marginRight = '16px';
    msg.innerHTML = renderMarkdown(text);
  }

  historyEl.appendChild(msg);
  historyEl.scrollTop = historyEl.scrollHeight;
  return msg;
}

function appendTechnical(historyEl, text, dimmer = false) {
  const msg = document.createElement('div');
  msg.dataset.technical = '1';
  msg.style.fontFamily = 'monospace';
  msg.style.fontSize = '10px';
  msg.style.lineHeight = '1.4';
  msg.style.padding = '2px 4px';
  msg.style.marginBottom = '2px';
  msg.style.color = dimmer ? 'rgba(0,0,0,0.25)' : 'rgba(0,0,0,0.38)';
  msg.style.wordBreak = 'break-all';
  msg.style.whiteSpace = 'pre-wrap';
  msg.textContent = text;
  historyEl.appendChild(msg);
  historyEl.scrollTop = historyEl.scrollHeight;
  return msg;
}

function setTechnicalVisibility(historyEl, visible) {
  historyEl.querySelectorAll('[data-technical]').forEach((el) => {
    el.style.display = visible ? '' : 'none';
  });
}

function updateTokenDisplay(tokenEl) {
  tokenEl.textContent = `↑${totalInputTokens} ↓${totalOutputTokens} tokens`;
}

function buildSystemPrompt(getBrief) {
  const brief = getBrief?.();
  const briefJson = brief ? JSON.stringify(brief, null, 2) : null;

  const staticText = `You are an AI assistant helping a web editor manage content in a Statamic CMS.
The site is for a plastic surgery clinic in Frankfurt, Germany.
You help with content suggestions, copywriting, and structure advice for any entry type — pages, blog posts, testimonials, or others.
Respond concisely.
When referring to sections to the user, use 1-based numbering (e.g. "section 1", "section 2"). Tool calls always use _id values — never positional indexes.
ITEM IDs: Every item in the brief (sections, tiles, accordion items, etc.) has a unique _id. Always use these in tool calls. Never guess or construct an _id — if you cannot find the exact _id in the brief, stop and ask the user to clarify instead of proceeding. Write tool responses include a "type" field confirming what was affected — verify it matches your intention before continuing.
BRIEF: The brief is rebuilt after every write operation and always reflects current entry state. The current brief is the complete structure — any item not listed in it does not exist.
HIERARCHY: The word "section" always means a top-level entry in the sections (or equivalent) array. Items nested inside a section (tiles, accordion items, etc.) are sub-items — not sections themselves. When looking for a section by type, only consider top-level entries.
READING: The brief contains every item's _id, type, and key content. Do NOT call get_item before delete, move, or update_item — derive the _id from the brief. Only call get_item when you need full raw data not in the brief (e.g. complete ProseMirror nodes of a bard field you intend to edit).
UPDATING: update_item patches any item at any depth by _id. To update a tile, accordion item, or any nested item, use its own _id directly — no need to reconstruct the parent array. For top-level scalar fields (title, date, slug, etc.) use update_field.
ADDING: add_item takes parent + type. For top-level items use the root field handle as parent — call get_blueprint first and read the _root_field value on the set type you want (e.g. schema_set has _root_field:"schema", not "sections"). For nested items (e.g. a tile inside a section) use the parent item's _id as parent and set field to the replicator field name (e.g. "tiles"). The optional fields parameter is for scalar values (text, numbers, asset strings). If you pre-populate a nested replicator array via fields (e.g. fields.icons), every sub-item in that array MUST include "type" (the set handle from the blueprint) — _id and enabled are injected automatically.
BARD FIELDS use ProseMirror JSON. Bard fields cannot be set during add_item — they are always initialized empty. If you pass bard content in add_item fields, the response will include "set_bard_fields" listing the skipped fields; immediately follow up with update_item calls (in parallel) to set those fields. For existing items, always call get_item first to read the current structure before editing. ProseMirror rules: text leaf nodes are {"type":"text","text":"..."} (never "value"); paragraphs are {"type":"paragraph","content":[{"type":"text","text":"..."}]}; headings are {"type":"heading","attrs":{"level":2,"textAlign":"left"},"content":[...]}; bard set nodes use {"type":"set","attrs":{"id":"...","values":{...}}} where values holds the set fields. IMAGES in bard: never use {"type":"image",...} inline nodes — that TipTap extension is not active. Embed images as bard sets: {"type":"set","attrs":{"id":"...","values":{"type":"image","enabled":true,"image":["assets::path/to/file.jpg"]}}}.
ASSET FIELDS store values as "assets::path/to/file.jpg" strings (with the assets:: prefix). Always include this prefix when setting an asset field.
EMPTY FIELDS: The brief omits fields that have no value. The "_fields" key lists all known field handles for this entry type, including empty ones. If a user refers to a field not shown in the brief but listed in "_fields", use update_field or get_field directly — do not say the field doesn't exist.
When passing a complex object or array as a tool argument value, pass it as a native JSON value — never as a JSON string.`;

  const blocks = [
    { type: 'text', text: staticText, cache_control: { type: 'ephemeral' } },
  ];

  if (briefJson) {
    blocks.push({ type: 'text', text: `Current page brief:\n\`\`\`json\n${briefJson}\n\`\`\`` });
  }

  return blocks;
}

function mountBardEditor(container) {
  const BardComp = window.Vue?.component?.('bard-fieldtype');
  if (!BardComp) return null;

  if (!document.getElementById('st-bard-doc-style')) {
    const s = document.createElement('style');
    s.id = 'st-bard-doc-style';
    s.textContent = '.st-doc-bard .bard-editor .ProseMirror{min-height:80px;max-height:160px;overflow-y:auto;padding:6px 8px;outline:none}.st-doc-bard .bard-fieldtype-wrapper{border:1px solid rgba(0,0,0,0.15);border-radius:4px}.st-doc-bard .bard-content ul{list-style-type:disc;padding-left:1.5em;margin:.3em 0}.st-doc-bard .bard-content ol{list-style-type:decimal;padding-left:1.5em;margin:.3em 0}.st-doc-bard .bard-content li{margin:.1em 0}.st-doc-bard .bard-content blockquote{border-left:3px solid rgba(0,0,0,0.25);padding-left:.75em;margin:.3em 0;color:rgba(0,0,0,0.6);font-style:italic}.st-doc-bard .bard-content table{border-collapse:collapse;width:100%;margin:.5em 0}.st-doc-bard .bard-content td,.st-doc-bard .bard-content th{border:1px solid rgba(0,0,0,0.2);padding:4px 8px;min-width:2em}.st-doc-bard .bard-content th{background:rgba(0,0,0,0.04);font-weight:600}.st-doc-portals .popover{z-index:100}.st-doc-portals .stack{z-index:100}.st-doc-bard .bard-content a{color:#43a9ff;text-decoration:underline}';
    document.head.appendChild(s);
  }
  container.classList.add('st-doc-bard');

  let vm;
  try {
    const mountEl = document.createElement('div');
    container.appendChild(mountEl);
    vm = new window.Vue({
      store: window.Statamic?.$store,
      provide() { return { storeName: null }; },
      render(h) {
        return h(BardComp, {
          props: {
            value: this.bardValue,
            config: this.bardConfig,
            handle: 'document_content',
            meta: this.bardMeta,
          },
          on: {
            input: (v) => { this.bardValue = v; },
            'meta-updated': (m) => { this.bardMeta = { ...this.bardMeta, ...m }; },
          },
        });
      },
      data() {
        return {
          portals: [],
          bardValue: [],
          bardConfig: {
            sets: null,
            buttons: ['h1', 'h2', 'h3', 'h4', 'bold', 'italic', 'underline', 'alignleft', 'aligncenter', 'alignright', 'unorderedlist', 'orderedlist', 'quote', 'anchor', 'table', 'removeformat'],
            toolbar_mode: 'fixed',
            allow_source: false,
            fullscreen: false,
            smart_typography: false,
            enable_input_rules: true,
            enable_paste_rules: true,
          },
          bardMeta: {
            collapsed: [],
            previews: {},
            linkData: {},
            defaults: {},
            new: {},
            existing: {},
          },
        };
      },
    }).$mount(mountEl);

    // Portal targets must live at body level so fixed-position popovers are
    // not clipped by any stacking context inside the panel.
    const ptEl = document.createElement('div');
    document.body.appendChild(ptEl);
    new window.Vue({
      parent: vm,
      render(h) {
        return h('div', { class: 'portal-targets st-doc-portals' },
          this.$root.portals.map(p => h('portal-target', { key: p.id, props: { name: p.id } }))
        );
      },
    }).$mount(ptEl);
  } catch (err) {
    console.error('Failed to mount Bard editor:', err);
    return null;
  }

  const getBardInst = () => vm.$children[0];
  return {
    getHTML() { return getBardInst()?.editor?.getHTML?.() ?? ''; },
    setContent(html) { getBardInst()?.editor?.commands?.setContent?.(html, false); },
    clear() { getBardInst()?.editor?.commands?.setContent?.('', false); },
  };
}

export function createChatSection(getBrief, getBlueprintData) {
  blueprintDataProvider = getBlueprintData ?? null;
  let showTechnical = true;

  const section = document.createElement('div');
  section.style.display = 'flex';
  section.style.flexDirection = 'column';
  section.style.gap = '5px';
  section.style.paddingBottom = '8px';
  section.style.borderBottom = '1px solid rgba(0,0,0,0.1)';

  let currentTab = 'chat';
  let bardEditor = null;

  function htmlToMarkdown(html) {
    const temp = document.createElement('div');
    temp.innerHTML = html;
    function traverse(node) {
      if (node.nodeType === 3) return node.textContent;
      if (node.nodeType !== 1) return '';
      const tag = node.tagName.toLowerCase();
      const kids = Array.from(node.childNodes).map(traverse).join('');
      if (tag === 'br') return '\n';
      if (tag === 'h1') return `# ${kids.trim()}\n\n`;
      if (tag === 'h2') return `## ${kids.trim()}\n\n`;
      if (tag === 'h3') return `### ${kids.trim()}\n\n`;
      if (['h4', 'h5', 'h6'].includes(tag)) return `#### ${kids.trim()}\n\n`;
      if (tag === 'p') return `${kids.trim()}\n\n`;
      if (tag === 'li') return `- ${kids.trim()}\n`;
      if (tag === 'ul' || tag === 'ol') return `${kids}\n`;
      if (tag === 'b' || tag === 'strong') return `**${kids}**`;
      if (tag === 'i' || tag === 'em') return `_${kids}_`;
      if (tag === 's' || tag === 'del' || tag === 'strike') return `~~${kids}~~`;
      if (tag === 'u') return kids;
      if (tag === 'code') return `\`${kids}\``;
      if (tag === 'blockquote') return `> ${kids.trim().replace(/\n/g, '\n> ')}\n\n`;
      if (tag === 'a') { const href = node.getAttribute('href'); return href ? `[${kids}](${href})` : kids; }
      if (tag === 'td' || tag === 'th') return `${kids.trim()} | `;
      if (tag === 'tr') return `${kids.trim()}\n`;
      if (['div', 'section', 'article', 'figure'].includes(tag)) return `${kids}\n`;
      return kids;
    }
    return traverse(temp).replace(/\n{3,}/g, '\n\n').trim();
  }

  // Header row: tabs + action buttons
  const headerRow = document.createElement('div');
  headerRow.style.display = 'flex';
  headerRow.style.justifyContent = 'space-between';
  headerRow.style.alignItems = 'center';

  const tabBar = document.createElement('div');
  tabBar.style.display = 'flex';
  tabBar.style.gap = '10px';
  tabBar.style.alignItems = 'center';

  function makeTabBtn(label, active) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = label;
    btn.style.fontSize = '10px';
    btn.style.textTransform = 'uppercase';
    btn.style.letterSpacing = '0.05em';
    btn.style.background = 'none';
    btn.style.border = 'none';
    btn.style.cursor = 'pointer';
    btn.style.padding = '0';
    btn.style.fontWeight = active ? '600' : '400';
    btn.style.color = active ? 'rgba(0,0,0,0.7)' : 'rgba(0,0,0,0.35)';
    return btn;
  }

  const chatTabBtn = makeTabBtn('Chat', true);
  const docTabBtn = makeTabBtn('Document', false);
  tabBar.appendChild(chatTabBtn);
  tabBar.appendChild(docTabBtn);

  const headerButtons = document.createElement('div');
  headerButtons.style.display = 'flex';
  headerButtons.style.gap = '8px';
  headerButtons.style.alignItems = 'center';

  const techToggle = document.createElement('button');
  techToggle.type = 'button';
  techToggle.textContent = 'hide technical';
  techToggle.style.fontSize = '10px';
  techToggle.style.background = 'none';
  techToggle.style.border = 'none';
  techToggle.style.cursor = 'pointer';
  techToggle.style.color = 'rgba(0,0,0,0.35)';
  techToggle.style.padding = '0';

  techToggle.addEventListener('click', () => {
    showTechnical = !showTechnical;
    techToggle.textContent = showTechnical ? 'hide technical' : 'show technical';
    setTechnicalVisibility(history, showTechnical);
  });

  const clearBtn = document.createElement('button');
  clearBtn.type = 'button';
  clearBtn.textContent = 'clear chat';
  clearBtn.style.fontSize = '10px';
  clearBtn.style.background = 'none';
  clearBtn.style.border = 'none';
  clearBtn.style.cursor = 'pointer';
  clearBtn.style.color = 'rgba(0,0,0,0.35)';
  clearBtn.style.padding = '0';

  clearBtn.addEventListener('click', () => {
    messages = [];
    totalInputTokens = 0;
    totalOutputTokens = 0;
    history.innerHTML = '';
    updateTokenDisplay(tokenInfo);
  });

  headerButtons.appendChild(techToggle);
  headerButtons.appendChild(clearBtn);
  headerRow.appendChild(tabBar);
  headerRow.appendChild(headerButtons);

  // Chat view
  const chatView = document.createElement('div');
  chatView.style.display = 'flex';
  chatView.style.flexDirection = 'column';
  chatView.style.gap = '5px';

  const history = document.createElement('div');
  history.style.maxHeight = '180px';
  history.style.minHeight = '32px';
  history.style.overflowY = 'auto';
  history.style.display = 'flex';
  history.style.flexDirection = 'column';

  const inputRow = document.createElement('div');
  inputRow.style.display = 'flex';
  inputRow.style.gap = '5px';
  inputRow.style.alignItems = 'flex-end';

  const textarea = document.createElement('textarea');
  textarea.rows = 2;
  textarea.placeholder = 'Ask Claude… (Enter to send, Shift+Enter for new line)';
  textarea.style.flex = '1';
  textarea.style.resize = 'vertical';
  textarea.style.fontSize = '12px';
  textarea.style.padding = '4px 6px';
  textarea.style.border = '1px solid rgba(0,0,0,0.2)';
  textarea.style.borderRadius = '4px';
  textarea.style.fontFamily = 'inherit';
  textarea.style.lineHeight = '1.4';

  const sendBtn = document.createElement('button');
  sendBtn.type = 'button';
  sendBtn.className = 'btn btn-primary';
  sendBtn.textContent = 'Send';
  sendBtn.style.fontSize = '12px';
  sendBtn.style.padding = '4px 10px';

  const tokenInfo = document.createElement('div');
  tokenInfo.style.fontSize = '10px';
  tokenInfo.style.color = 'rgba(0,0,0,0.35)';
  tokenInfo.style.textAlign = 'right';
  updateTokenDisplay(tokenInfo);

  inputRow.appendChild(textarea);
  inputRow.appendChild(sendBtn);
  chatView.appendChild(history);
  chatView.appendChild(inputRow);
  chatView.appendChild(tokenInfo);

  // Document view
  const documentView = document.createElement('div');
  documentView.style.display = 'none';
  documentView.style.flexDirection = 'column';
  documentView.style.gap = '5px';

  const docDesc = document.createElement('div');
  docDesc.textContent = 'Paste your document here, or upload a .docx file. Click "Build" to let the AI restructure the page.';
  docDesc.style.fontSize = '11px';
  docDesc.style.color = 'rgba(0,0,0,0.45)';
  docDesc.style.lineHeight = '1.4';

  const docEditorContainer = document.createElement('div');

  function ensureBardEditor() {
    if (bardEditor) return;
    bardEditor = mountBardEditor(docEditorContainer);
  }

  const docBtnRow = document.createElement('div');
  docBtnRow.style.display = 'flex';
  docBtnRow.style.gap = '6px';
  docBtnRow.style.justifyContent = 'flex-end';
  docBtnRow.style.alignItems = 'center';

  const clearDocBtn = document.createElement('button');
  clearDocBtn.type = 'button';
  clearDocBtn.textContent = 'Clear';
  clearDocBtn.style.fontSize = '11px';
  clearDocBtn.style.background = 'none';
  clearDocBtn.style.border = '1px solid rgba(0,0,0,0.2)';
  clearDocBtn.style.borderRadius = '4px';
  clearDocBtn.style.cursor = 'pointer';
  clearDocBtn.style.padding = '3px 10px';
  clearDocBtn.style.color = 'rgba(0,0,0,0.5)';
  clearDocBtn.addEventListener('click', () => { bardEditor?.clear(); });

  // .docx upload — hidden file input + visible label button, revealed after mammoth loads
  const docxInput = document.createElement('input');
  docxInput.type = 'file';
  docxInput.accept = '.docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  docxInput.style.display = 'none';

  const uploadBtn = document.createElement('button');
  uploadBtn.type = 'button';
  uploadBtn.textContent = 'loading…';
  uploadBtn.disabled = true;
  uploadBtn.style.fontSize = '11px';
  uploadBtn.style.background = 'none';
  uploadBtn.style.border = '1px solid rgba(0,0,0,0.2)';
  uploadBtn.style.borderRadius = '4px';
  uploadBtn.style.cursor = 'default';
  uploadBtn.style.padding = '3px 10px';
  uploadBtn.style.color = 'rgba(0,0,0,0.35)';

  docxInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file || !window.mammoth) return;
    uploadBtn.textContent = 'reading…';
    uploadBtn.disabled = true;
    try {
      const arrayBuffer = await file.arrayBuffer();
      const { value: html } = await window.mammoth.convertToHtml({ arrayBuffer });
      bardEditor?.setContent(html);
    } catch (err) {
      uploadBtn.textContent = 'read error';
      setTimeout(() => { uploadBtn.textContent = 'Upload .docx'; }, 2000);
    } finally {
      uploadBtn.textContent = 'Upload .docx';
      uploadBtn.disabled = false;
      docxInput.value = '';
    }
  });

  uploadBtn.addEventListener('click', () => { if (!uploadBtn.disabled) docxInput.click(); });

  const buildBtn = document.createElement('button');
  buildBtn.type = 'button';
  buildBtn.className = 'btn btn-primary';
  buildBtn.textContent = 'Build page';
  buildBtn.style.fontSize = '11px';
  buildBtn.style.padding = '3px 12px';

  buildBtn.addEventListener('click', () => {
    const html = bardEditor?.getHTML() ?? '';
    const md = htmlToMarkdown(html);
    if (!md.trim()) return;
    const prompt = `Rebuild this page's sections based on the document below. Use the blueprint to choose appropriate section types and fill in the content. Replace or add sections as needed.\n\n---\n\n${md}`;
    switchTab('chat');
    handleSend(prompt);
  });

  docBtnRow.appendChild(docxInput);
  docBtnRow.appendChild(clearDocBtn);
  docBtnRow.appendChild(uploadBtn);
  docBtnRow.appendChild(buildBtn);
  documentView.appendChild(docDesc);
  documentView.appendChild(docEditorContainer);
  documentView.appendChild(docBtnRow);

  let mammothLoading = false;
  function loadMammoth() {
    if (window.mammoth || mammothLoading) return;
    mammothLoading = true;
    const cpRoot = window.Statamic?.$config?.get('cp_root') ?? '/cp';
    const s = document.createElement('script');
    s.src = `${cpRoot}/section-tools/mammoth.js`;
    s.onload = () => {
      uploadBtn.textContent = 'Upload .docx';
      uploadBtn.disabled = false;
      uploadBtn.style.cursor = 'pointer';
      uploadBtn.style.color = 'rgba(0,0,0,0.6)';
    };
    s.onerror = () => { uploadBtn.textContent = 'docx N/A'; };
    document.head.appendChild(s);
  }

  function switchTab(tab) {
    currentTab = tab;
    chatTabBtn.style.fontWeight = tab === 'chat' ? '600' : '400';
    chatTabBtn.style.color = tab === 'chat' ? 'rgba(0,0,0,0.7)' : 'rgba(0,0,0,0.35)';
    docTabBtn.style.fontWeight = tab === 'document' ? '600' : '400';
    docTabBtn.style.color = tab === 'document' ? 'rgba(0,0,0,0.7)' : 'rgba(0,0,0,0.35)';
    chatView.style.display = tab === 'chat' ? 'flex' : 'none';
    documentView.style.display = tab === 'document' ? 'flex' : 'none';
    headerButtons.style.visibility = tab === 'chat' ? 'visible' : 'hidden';
    if (tab === 'document') { ensureBardEditor(); loadMammoth(); }
  }

  chatTabBtn.addEventListener('click', () => switchTab('chat'));
  docTabBtn.addEventListener('click', () => switchTab('document'));

  section.appendChild(headerRow);
  section.appendChild(chatView);
  section.appendChild(documentView);

  async function handleSend(customText) {
    const text = (customText ?? textarea.value).trim();
    if (!text) return;

    if (!customText) textarea.value = '';
    textarea.disabled = true;
    sendBtn.disabled = true;
    buildBtn.disabled = true;
    sendBtn.textContent = '…';

    const displayText = customText && customText.length > 120
      ? customText.slice(0, 120) + '…'
      : text;

    // Document builds get cache_control so the large content is cached in subsequent rounds
    const userContent = customText
      ? [{ type: 'text', text, cache_control: { type: 'ephemeral' } }]
      : text;
    messages.push({ role: 'user', content: userContent });
    appendMessage(history, 'user', displayText);

    let systemPrompt = buildSystemPrompt(getBrief);
    const msgCountBefore = messages.length;

    try {
      let lastToolSignature = null;
      let finalText = null;

      for (let round = 0; round < MAX_ROUNDS; round++) {
        if (round > 0) sendBtn.textContent = `step ${round + 1}/${MAX_ROUNDS}…`;

        const data = await sendToClaude(messages, systemPrompt, AI_TOOLS);

        totalInputTokens += data.usage?.input_tokens ?? 0;
        totalOutputTokens += data.usage?.output_tokens ?? 0;
        updateTokenDisplay(tokenInfo);

        if (data.stop_reason !== 'tool_use') {
          finalText = data.content?.find((b) => b.type === 'text')?.text ?? '[no response]';
          break;
        }

        // Normalize tool_use inputs: Anthropic may send input:[] for empty-input tools,
        // but resending [] (array) where {} (object) is expected causes a 400 on next round.
        const normalizedContent = data.content.map((b) =>
          b.type === 'tool_use' && Array.isArray(b.input) && b.input.length === 0
            ? { ...b, input: {} }
            : b,
        );

        // Append assistant message with tool_use blocks
        messages.push({ role: 'assistant', content: normalizedContent });

        const toolUseBlocks = normalizedContent.filter((b) => b.type === 'tool_use');

        // Stuck loop detection
        if (toolUseBlocks.length === 1) {
          const sig = `${toolUseBlocks[0].name}:${JSON.stringify(toolUseBlocks[0].input)}`;
          if (sig === lastToolSignature) {
            finalText = '[stopped: repeated tool call detected]';
            break;
          }
          lastToolSignature = sig;
        } else {
          lastToolSignature = null;
        }

        // Show any text Claude included alongside the tool call
        const textBlock = data.content.find((b) => b.type === 'text' && b.text?.trim());
        if (textBlock) appendMessage(history, 'assistant', textBlock.text);

        // Execute tools
        const toolResults = [];
        for (const block of toolUseBlocks) {
          const callMsg = appendTechnical(history, `→ ${block.name}(${JSON.stringify(block.input)})`, false);
          if (!showTechnical) callMsg.style.display = 'none';

          let result;
          try {
            result = await executeTool(block.name, block.input);
          } catch (err) {
            result = { error: err.message };
          }

          const preview = JSON.stringify(result);
          const resultMsg = appendTechnical(history, `← ${preview.length > 300 ? preview.slice(0, 300) + '…' : preview}`, true);
          if (!showTechnical) resultMsg.style.display = 'none';

          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: JSON.stringify(result),
          });
        }

        messages.push({ role: 'user', content: toolResults });

        if (toolUseBlocks.some((b) => WRITE_TOOLS.has(b.name))) {
          systemPrompt = buildSystemPrompt(getBrief);
        }
      }

      if (finalText === null) finalText = '[max steps reached]';

      messages.push({ role: 'assistant', content: finalText });
      appendMessage(history, 'assistant', finalText);
    } catch (err) {
      messages.splice(msgCountBefore);
      const display = err.message.includes('429')
        ? 'Rate limit hit — wait a few seconds and try again.'
        : `Error: ${err.message}`;
      appendMessage(history, 'assistant', display);
    } finally {
      textarea.disabled = false;
      sendBtn.disabled = false;
      buildBtn.disabled = false;
      sendBtn.textContent = 'Send';
      textarea.focus();
    }
  }

  sendBtn.addEventListener('click', () => handleSend());
  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  });

  return section;
}
