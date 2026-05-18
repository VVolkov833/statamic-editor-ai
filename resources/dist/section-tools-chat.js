import { getPublishStore, uid, getPublishModuleNames, cloneValue, commitField, readPanelState, writePanelState } from './section-tools-lib.js';
import { simplifyBlueprintNode, fetchAssetsForAI, extractBlueprintSets, validateSetTypeForField, buildRootFieldMap } from './section-tools-queries.js';
import { pushUndoSnapshot } from './section-tools-mutations.js';

// inlineSubItems:  { fieldHandle: [subItems] } — replicator sub-items to inject in the same commit
// inlineSubRows:   { fieldHandle: [rows] }     — grid rows to inject in the same commit
// inlineAssets:    { fieldHandle: [assetObjects] } — pre-fetched asset objects for assets fields.
//                  Setting meta.data to a truthy array prevents Statamic's initializeAssets from
//                  calling loadAssets (an async HTTP POST). loadAssets completes after commitField
//                  and its setMeta callback uses a stale store snapshot, wiping out the meta of
//                  any item added after this one and crashing the renderer. Pass [] on fetch error
//                  (still prevents loadAssets; just no preview until the page is reloaded).
// All three are combined into one setMeta commit to prevent any async re-render window.
function injectNestedItemMeta(statamic, rootHandle, parentId, field, newItemId, type,
                              inlineSubItems = {}, inlineSubRows = {}, inlineAssets = {}) {
  const publishStore = getPublishStore(statamic);
  const meta = publishStore?.meta;
  if (!meta) return;

  const rootFieldMeta = meta[rootHandle];
  if (!rootFieldMeta) return;

  // Deep-clone so we can mutate safely, then recursively search for parentId at any depth.
  const newMeta = cloneValue(meta);
  const newRootFieldMeta = newMeta[rootHandle];

  function findAndInject(existingObj) {
    if (!existingObj || typeof existingObj !== 'object') return false;
    if (parentId in existingObj) {
      const parentMeta = existingObj[parentId];
      if (!parentMeta || typeof parentMeta !== 'object') return false;
      const nestedFieldMeta = parentMeta[field];
      if (!nestedFieldMeta || typeof nestedFieldMeta !== 'object') return false;
      const typeTemplate = nestedFieldMeta.new?.[type];
      if (!nestedFieldMeta.existing) nestedFieldMeta.existing = {};
      const newItemMeta = typeTemplate ? cloneValue(typeTemplate) : {};

      // Inline replicator sub-items (e.g. step items inside a steps tile)
      for (const [fh, subItems] of Object.entries(inlineSubItems)) {
        if (!Array.isArray(subItems) || !subItems.length) continue;
        if (!newItemMeta[fh] || typeof newItemMeta[fh] !== 'object') newItemMeta[fh] = {};
        const fm = newItemMeta[fh];
        if (!fm.existing) fm.existing = {};
        for (const si of subItems) {
          if (si?._id && !fm.existing[si._id]) fm.existing[si._id] = fm.new?.[si.type] ?? {};
        }
      }
      // Inline grid rows (e.g. icons rows inside an icons tile)
      for (const [fh, rows] of Object.entries(inlineSubRows)) {
        if (!Array.isArray(rows) || !rows.length) continue;
        if (!newItemMeta[fh] || typeof newItemMeta[fh] !== 'object') newItemMeta[fh] = {};
        const fm = newItemMeta[fh];
        if (!fm.existing) fm.existing = {};
        for (const row of rows) {
          if (row?._id && !fm.existing[row._id]) fm.existing[row._id] = {};
        }
      }
      // Inline assets: set meta.data to the pre-fetched asset objects so Statamic's assets
      // field skips initializeAssets → loadAssets entirely (it only calls loadAssets when
      // meta.data is falsy). With meta.data truthy the field uses it directly → previews show.
      for (const [fh, assetData] of Object.entries(inlineAssets)) {
        if (!Array.isArray(assetData)) continue;
        if (!newItemMeta[fh] || typeof newItemMeta[fh] !== 'object') newItemMeta[fh] = {};
        newItemMeta[fh].data = assetData;
      }

      nestedFieldMeta.existing[newItemId] = newItemMeta;
      return true;
    }
    for (const itemMeta of Object.values(existingObj)) {
      if (!itemMeta || typeof itemMeta !== 'object') continue;
      for (const fieldMeta of Object.values(itemMeta)) {
        if (!fieldMeta || typeof fieldMeta !== 'object' || !fieldMeta.existing) continue;
        if (findAndInject(fieldMeta.existing)) return true;
      }
    }
    return false;
  }

  if (!findAndInject(newRootFieldMeta.existing)) return;

  const moduleNames = getPublishModuleNames(statamic);
  for (const moduleName of moduleNames) {
    try {
      statamic.$store.commit(`publish/${moduleName}/setMeta`, newMeta);
      statamic.$store.dispatch(`publish/${moduleName}/setMeta`, newMeta);
    } catch {}
  }
}

function injectTopLevelItemMeta(statamic, rootHandle, newItemId, type,
                               inlineSubItems = {}, inlineSubRows = {}, inlineAssets = {}) {
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

  const newItemMeta = typeTemplate;

  // Inline replicator sub-items (e.g. tab items inside a tabs_numbers section)
  for (const [fh, subItems] of Object.entries(inlineSubItems)) {
    if (!Array.isArray(subItems) || !subItems.length) continue;
    if (!newItemMeta[fh] || typeof newItemMeta[fh] !== 'object') newItemMeta[fh] = {};
    const fm = newItemMeta[fh];
    if (!fm.existing) fm.existing = {};
    for (const si of subItems) {
      if (si?._id && !fm.existing[si._id]) fm.existing[si._id] = fm.new?.[si.type] ?? {};
    }
  }
  // Inline grid rows (e.g. accordion entries)
  for (const [fh, rows] of Object.entries(inlineSubRows)) {
    if (!Array.isArray(rows) || !rows.length) continue;
    if (!newItemMeta[fh] || typeof newItemMeta[fh] !== 'object') newItemMeta[fh] = {};
    const fm = newItemMeta[fh];
    if (!fm.existing) fm.existing = {};
    for (const row of rows) {
      if (row?._id && !fm.existing[row._id]) fm.existing[row._id] = {};
    }
  }
  // Inline assets: same fix as nested — set meta.data to pre-fetched objects so loadAssets
  // is never called and previews display immediately.
  for (const [fh, assetData] of Object.entries(inlineAssets)) {
    if (!Array.isArray(assetData)) continue;
    if (!newItemMeta[fh] || typeof newItemMeta[fh] !== 'object') newItemMeta[fh] = {};
    newItemMeta[fh].data = assetData;
  }

  const updatedMeta = {
    ...meta,
    [rootHandle]: {
      ...rootFieldMeta,
      existing: {
        ...(rootFieldMeta.existing ?? {}),
        [newItemId]: newItemMeta,
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

// Fetch Statamic asset objects for a list of "assets::path" strings.
// Returns an array of asset objects (with url, thumbnail, etc.) as returned by
// Statamic's assets-fieldtype endpoint. Falls back to [] on error.
// Uses window.Statamic.$axios (already configured with CSRF/cookies) to avoid 419s.
async function fetchStatamicAssetData(assetPaths) {
  if (!assetPaths || !assetPaths.length) return [];
  const axios = window.Statamic?.$axios;
  if (!axios) return [];
  const cpRoot = window.Statamic?.$config?.get('cp_root') ?? '/cp';
  try {
    const res = await axios.post(`${cpRoot}/assets-fieldtype`, { assets: assetPaths });
    return Array.isArray(res.data) ? res.data : [];
  } catch {
    return [];
  }
}

// After update_item writes bard content that contains set nodes with nested replicators,
// the Vuex meta for those set nodes and their items is missing — causing Vue component
// crashes ("Cannot read properties of undefined"). This function patches meta so that
// every bard set node and every replicator item inside it has the required meta entries.
function injectBardSetsMeta(statamic, rootHandle, itemId, bardFieldUpdates) {
  const publishStore = getPublishStore(statamic);
  const meta = publishStore?.meta;
  if (!meta) return;

  const rootMeta = meta[rootHandle];
  if (!rootMeta) return;

  const itemMeta = rootMeta.existing?.[itemId];
  if (!itemMeta) return;

  let changed = false;
  const newItemMeta = { ...itemMeta };

  for (const [fieldHandle, bardNodes] of Object.entries(bardFieldUpdates)) {
    if (!Array.isArray(bardNodes)) continue;
    const bardFieldMeta = itemMeta[fieldHandle];
    if (!bardFieldMeta || typeof bardFieldMeta !== 'object') continue;

    const setNodes = bardNodes.filter(n => n?.type === 'set' && n?.attrs?.id && n?.attrs?.values?.type);
    if (!setNodes.length) continue;

    const bardNewTemplates = bardFieldMeta.new ?? {};
    const existingBardMeta = { ...(bardFieldMeta.existing ?? {}) };
    let bardChanged = false;

    for (const node of setNodes) {
      const setId   = node.attrs.id;
      const setType = node.attrs.values.type;
      if (existingBardMeta[setId]) continue; // meta already present

      // Copy the new-item template for this set type, then patch in existing-item entries
      // for any replicator items already in values.
      const setMeta = cloneValue(bardNewTemplates[setType] ?? {});

      for (const [subHandle, subValue] of Object.entries(node.attrs.values ?? {})) {
        if (!Array.isArray(subValue) || !subValue.length) continue;
        const subMeta = setMeta[subHandle];
        if (!subMeta || typeof subMeta !== 'object' || !subMeta.new) continue;
        const subExisting = { ...(subMeta.existing ?? {}) };
        for (const subItem of subValue) {
          const subId = subItem._id ?? subItem.id;
          if (!subId || subExisting[subId]) continue;
          subExisting[subId] = cloneValue(subMeta.new[subItem.type] ?? {});
        }
        setMeta[subHandle] = { ...subMeta, existing: subExisting };
      }

      existingBardMeta[setId] = setMeta;
      bardChanged = true;
    }

    if (bardChanged) {
      newItemMeta[fieldHandle] = { ...bardFieldMeta, existing: existingBardMeta };
      changed = true;
    }
  }

  if (!changed) return;

  const updatedMeta = {
    ...meta,
    [rootHandle]: {
      ...rootMeta,
      existing: { ...rootMeta.existing, [itemId]: newItemMeta },
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

// After update_item writes replicator sub-items (e.g., steps inside a steps tile), the
// Vuex meta for those items is missing — Statamic's renderer accesses meta.existing[id]
// which is undefined, causing "Cannot read properties of undefined (reading '<handle>')".
// This function searches the nested meta hierarchy for the parent item and injects
// existing-item meta entries for each new sub-item in the updated replicator fields.
function injectNestedReplicatorItemsMeta(statamic, rootHandle, itemId, replicatorUpdates) {
  const publishStore = getPublishStore(statamic);
  const meta = publishStore?.meta;
  if (!meta) return;

  const rootFieldMeta = meta[rootHandle];
  if (!rootFieldMeta) return;

  const newMeta = cloneValue(meta);
  const newRootFieldMeta = newMeta[rootHandle];

  function findAndPatch(existingObj) {
    if (!existingObj || typeof existingObj !== 'object') return false;
    if (itemId in existingObj) {
      const itemMeta = existingObj[itemId];
      if (!itemMeta || typeof itemMeta !== 'object') return false;
      let patched = false;
      for (const [fieldHandle, newItems] of Object.entries(replicatorUpdates)) {
        if (!Array.isArray(newItems) || !newItems.length) continue;
        // Create field meta entry if the type template didn't include it.
        if (!itemMeta[fieldHandle] || typeof itemMeta[fieldHandle] !== 'object') {
          itemMeta[fieldHandle] = {};
        }
        const fieldMeta = itemMeta[fieldHandle];
        if (!fieldMeta.existing) fieldMeta.existing = {};
        for (const subItem of newItems) {
          const subId = subItem._id;
          if (!subId || fieldMeta.existing[subId]) continue;
          fieldMeta.existing[subId] = cloneValue(fieldMeta.new?.[subItem.type] ?? {});
          patched = true;
        }
      }
      return patched;
    }
    for (const itemMeta of Object.values(existingObj)) {
      if (!itemMeta || typeof itemMeta !== 'object') continue;
      for (const fieldMeta of Object.values(itemMeta)) {
        if (!fieldMeta || typeof fieldMeta !== 'object' || !fieldMeta.existing) continue;
        if (findAndPatch(fieldMeta.existing)) return true;
      }
    }
    return false;
  }

  if (!findAndPatch(newRootFieldMeta.existing)) return;

  const moduleNames = getPublishModuleNames(statamic);
  for (const moduleName of moduleNames) {
    try {
      statamic.$store.commit(`publish/${moduleName}/setMeta`, newMeta);
      statamic.$store.dispatch(`publish/${moduleName}/setMeta`, newMeta);
    } catch {}
  }
}

// After update_item writes grid rows (e.g., icons grid on an icons tile, rows grid within
// table sections), Statamic's renderer accesses meta.existing[row._id] for each row.
// Without _id on the row and a matching entry in existing, $.meta is undefined and the
// renderer crashes with "Cannot read properties of undefined (reading '<fieldHandle>')".
// This function recursively searches the nested meta hierarchy for the parent item and
// injects existing entries for each new grid row.
//
// gridRowAssetData: pre-fetched asset objects keyed as
//   { gridFieldHandle: { rowId: { assetFieldHandle: [assetObjects] } } }
// Setting meta.data on each assets sub-field prevents Statamic's initializeAssets from
// calling loadAssets (async), which would overwrite meta with a stale snapshot and crash
// the renderer for subsequently-added items.
function injectNestedGridRowsMeta(statamic, rootHandle, itemId, gridUpdates, gridRowAssetData = {}) {
  const publishStore = getPublishStore(statamic);
  const meta = publishStore?.meta;
  if (!meta) return;

  const rootFieldMeta = meta[rootHandle];
  if (!rootFieldMeta) return;

  const newMeta = cloneValue(meta);
  const newRootFieldMeta = newMeta[rootHandle];

  function findAndPatch(existingObj) {
    if (!existingObj || typeof existingObj !== 'object') return false;
    if (itemId in existingObj) {
      const itemMeta = existingObj[itemId];
      if (!itemMeta || typeof itemMeta !== 'object') return false;
      let patched = false;
      for (const [fieldHandle, newRows] of Object.entries(gridUpdates)) {
        if (!Array.isArray(newRows) || !newRows.length) continue;
        // Create field meta if the item meta template didn't include it (e.g. empty {} from new-item template).
        if (!itemMeta[fieldHandle] || typeof itemMeta[fieldHandle] !== 'object') {
          itemMeta[fieldHandle] = {};
        }
        const fieldMeta = itemMeta[fieldHandle];
        if (!fieldMeta.existing) fieldMeta.existing = {};
        const rowAssetMap = gridRowAssetData[fieldHandle] ?? {};
        for (const row of newRows) {
          const rowId = row._id;
          if (!rowId || fieldMeta.existing[rowId]) continue;
          // Build initial row meta: for each assets sub-field, set data to the pre-fetched
          // asset objects so initializeAssets skips its async loadAssets call entirely.
          const rowAssetFields = rowAssetMap[rowId] ?? {};
          const rowInitMeta = Object.fromEntries(
            Object.entries(rowAssetFields).map(([fh, assetData]) => [fh, { data: assetData }])
          );
          fieldMeta.existing[rowId] = rowInitMeta;
          patched = true;
        }
      }
      return patched;
    }
    for (const itemMeta of Object.values(existingObj)) {
      if (!itemMeta || typeof itemMeta !== 'object') continue;
      for (const fieldMeta of Object.values(itemMeta)) {
        if (!fieldMeta || typeof fieldMeta !== 'object' || !fieldMeta.existing) continue;
        if (findAndPatch(fieldMeta.existing)) return true;
      }
    }
    return false;
  }

  if (!findAndPatch(newRootFieldMeta.existing)) return;

  const moduleNames = getPublishModuleNames(statamic);
  for (const moduleName of moduleNames) {
    try {
      statamic.$store.commit(`publish/${moduleName}/setMeta`, newMeta);
      statamic.$store.dispatch(`publish/${moduleName}/setMeta`, newMeta);
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

      // text nodes: fix value→text, ensure text is a non-empty string
      if (node.type === 'text') {
        if (result.value !== undefined && result.text === undefined) {
          result.text = result.value;
          delete result.value;
        }
        if (typeof result.text !== 'string') result.text = String(result.text ?? '');
        if (!result.text) return []; // ProseMirror forbids empty text nodes
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
          .flatMap((inline) => {
            if (inline.type !== 'text') return [inline];
            const fixed = { ...inline };
            if (fixed.value !== undefined && fixed.text === undefined) {
              fixed.text = fixed.value;
              delete fixed.value;
            }
            if (typeof fixed.text !== 'string') fixed.text = String(fixed.text ?? '');
            if (!fixed.text) return []; // drop empty text nodes
            return [fixed];
          });
        // If paragraph became empty after extracting images, drop it and return just the sets
        if (result.content.length === 0 && imageSets.length > 0) return imageSets;
        return [result, ...imageSets];
      }

      return [result];
    });
}

function bardArrayToPlainText(arr) {
  if (!Array.isArray(arr)) return typeof arr === 'string' ? arr : String(arr ?? '');
  function extractText(node) {
    if (!node || typeof node !== 'object') return '';
    if (node.type === 'text') return typeof node.text === 'string' ? node.text : '';
    if (Array.isArray(node.content)) return node.content.map(extractText).join('');
    return '';
  }
  return arr.map(extractText).filter(Boolean).join('\n').trim();
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
let totalCacheReadTokens = 0;
let blueprintDataProvider = null;

const MAX_ROUNDS = 8;
const MAX_ROUNDS_BUILD = 20;
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
    name: 'search_assets',
    description: 'Search for media assets. Always call this to verify an asset exists before using it — even when the document provides a full path. Query matching: if query contains "/" it matches against the full path (folder+filename+extension) → matched_by="path"; otherwise matches filename → matched_by="filename", folder name → matched_by="folder", or alt text → matched_by="alt". When a full path is provided (e.g. "7_botox/istock_2157073168_prostock_studio_geandert.jpg"), use it as the query exactly. Only set an asset field once search confirms the asset exists.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Full path (e.g. "7_botox/file.jpg"), partial path ("7_botox/istock_2157"), filename ("dr_yun.jpg"), folder ("7_botox"), or alt text keywords.' },
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
    description: 'Add a new item to any replicator. "parent" is either a root field handle (e.g. "sections", "schema") for top-level items, or the _id of a parent item for nested items. Read _root_field from the blueprint in your context to find the correct root field handle for a type. When parent is an _id, "field" is required — the replicator field name within that parent (e.g. "tiles"). Adding an invalid type to a field returns an error with the correct parent suggestion.',
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

// Normalize a single grid row: add _id, wrap bare asset strings, and coerce bard field values.
// rowFieldTypes maps field handles to their Statamic type (e.g. {label:"text", text:"bard"}).
// blueprint is the Vuex blueprint object used by sanitizeBardContent.
function normalizeGridRow(row, rowFieldTypes, blueprint) {
  if (!row || typeof row !== 'object') return row;
  const r = { ...row };
  if (!r._id) r._id = uid();
  for (const [rk, rv] of Object.entries(r)) {
    if (rk === '_id') continue;
    const rft = rowFieldTypes?.[rk];
    if (rft === 'bard') {
      if (typeof rv === 'string' && rv.trim()) {
        r[rk] = [{ type: 'paragraph', content: [{ type: 'text', text: rv }] }];
      } else if (Array.isArray(rv)) {
        const sanitized = sanitizeBardContent(rv, blueprint);
        const hasBlocks = sanitized.some(n => n && typeof n === 'object' && BARD_BLOCK_TYPES.has(n.type));
        if (!hasBlocks && sanitized.length > 0) {
          const inlines = sanitized.filter(n => n && typeof n === 'object' && n.type === 'text' && n.text);
          r[rk] = inlines.length > 0 ? [{ type: 'paragraph', content: inlines }] : [];
        } else {
          r[rk] = sanitized;
        }
      } else if (!rv) {
        r[rk] = [];
      }
    } else if (typeof rv === 'string' && rv.startsWith('assets::')) {
      r[rk] = [rv];
    } else if (rft === 'assets' && typeof rv === 'string') {
      r[rk] = [rv];
    }
  }
  return r;
}

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
    // Resolve the target item's set type so we can coerce fields to their declared types.
    // Prefer the endpoint blueprint (fully resolves imported fieldsets) over Vuex-derived.
    let itemFieldTypes = {};
    let resolvedSetType = null;
    // Use the endpoint blueprint (fully resolves imported fieldsets); fall back to Vuex-derived.
    const cachedSetsSnapshot = (() => {
      const ep = blueprintDataProvider?.()?.sets ?? {};
      return Object.keys(ep).length > 0 ? ep : extractBlueprintSets(blueprint);
    })();
    for (const rootValue of Object.values(values)) {
      if (!Array.isArray(rootValue)) continue;
      const found = findItemWithParent(cloneValue(rootValue), input.id);
      if (found?.item?.type) {
        resolvedSetType = found.item.type;
        const cachedFields = cachedSetsSnapshot[resolvedSetType]?.fields;
        if (cachedFields) {
          itemFieldTypes = Object.fromEntries(
            cachedFields.filter(f => f.handle && f.type).map(f => [f.handle, f.type])
          );
        } else {
          itemFieldTypes = getSetFieldTypes(blueprint, resolvedSetType);
        }
        break;
      }
    }
    const STRING_TYPES = new Set(['textarea', 'text', 'slug', 'markdown']);
    const SELECT_TYPES = new Set(['select', 'radio', 'button_group']);
    // Validate select fields before writing — wrong shapes cause Vue component crashes.
    for (const [k, v] of Object.entries(input.fields)) {
      if (SELECT_TYPES.has(itemFieldTypes[k]) && v !== null && typeof v !== 'string') {
        return { error: `Field "${k}" is a ${itemFieldTypes[k]} field — value must be a plain option key string (e.g. "certificates_shortest"), never an object or array. Got: ${JSON.stringify(v)}` };
      }
    }
    // Extract a heading node's text from a bard array (returns '' if no heading at position 0).
    const extractBardHeading = (bardArr) => {
      if (!Array.isArray(bardArr) || bardArr[0]?.type !== 'heading') return '';
      return (bardArr[0]?.content ?? []).map(n => n.text ?? '').join('');
    };
    // Coerce a single field value: bard→string for textarea, asset string→array, etc.
    // siblingTypes: {fieldHandle: type} of all fields in the same set, used for heading extraction.
    const coerceFieldValue = (fk, fv, fieldType, siblingTypes, siblingValues) => {
      if (STRING_TYPES.has(fieldType) && Array.isArray(fv)) {
        // When a textarea bard array starts with a heading, extract it as the sibling 'title' field
        // (if title exists in the set, isn't already set, and the caller hasn't supplied it).
        if (fk !== 'title' && STRING_TYPES.has(siblingTypes?.title) && !siblingValues?.title) {
          const heading = extractBardHeading(fv);
          if (heading) {
            siblingValues.title = heading; // mutate caller's accumulator
            return bardArrayToPlainText(fv.slice(1));
          }
        }
        return bardArrayToPlainText(fv);
      }
      if (fieldType === 'assets' && typeof fv === 'string') return [fv];
      return fv; // leave unknown types as-is (caller handles bard/grid separately)
    };
    // Normalize a replicator sub-item array: infer missing type, coerce textarea→string, asset string→array.
    const normalizeSubItems = (items, parentSetType) => {
      if (!Array.isArray(items)) return items;
      const childSets = Object.values(cachedSetsSnapshot).filter(s => s._parent_set === parentSetType);
      const singleChildType = childSets.length === 1 ? childSets[0].handle : null;
      return items.map(item => {
        if (!item || typeof item !== 'object') return item;
        const resolvedType = item.type ?? singleChildType;
        if (!resolvedType) return { _id: item._id ?? uid(), enabled: item.enabled ?? true, ...item };
        const setDef = cachedSetsSnapshot[resolvedType];
        const setFieldTypes = setDef?.fields
          ? Object.fromEntries(setDef.fields.filter(f => f.handle && f.type).map(f => [f.handle, f.type]))
          : {};
        // Inject _id and enabled so Statamic's replicator component can look up meta
        // correctly. Without _id, meta.existing[undefined] = undefined → render crash.
        const _id = item._id ?? uid();
        const enabled = item.enabled ?? true;
        const out = { ...item, _id, enabled, type: resolvedType };
        // Rename common field-name aliases the AI uses (e.g. "headline" when the set has "title").
        const ALIASES = [['headline', 'title'], ['title', 'headline']];
        for (const [wrong, correct] of ALIASES) {
          if (out[wrong] !== undefined && !setFieldTypes[wrong] && setFieldTypes[correct] && out[correct] === undefined) {
            out[correct] = out[wrong];
            delete out[wrong];
          }
        }
        for (const [fk, fv] of Object.entries(out)) {
          if (fk === 'type' || fk === '_id' || fk === 'enabled') continue;
          const ft = setFieldTypes[fk];
          if (!ft) continue;
          // Grid sub-fields: normalize each row (add _id, coerce bard/assets values).
          if (ft === 'grid' && Array.isArray(fv)) {
            const gridFieldDef = setDef?.fields?.find(f => f.handle === fk);
            const rowFieldTypes = gridFieldDef?.fields
              ? Object.fromEntries(gridFieldDef.fields.filter(f => f.handle && f.type).map(f => [f.handle, f.type]))
              : {};
            out[fk] = fv.map(row => normalizeGridRow(row, rowFieldTypes));
            continue;
          }
          out[fk] = coerceFieldValue(fk, fv, ft, setFieldTypes, out);
        }
        return out;
      });
    };
    const bardFieldUpdates = {};
    // Use an accumulator (not map) so coerceFieldValue can inject extracted fields (e.g. title from heading).
    const normalizedFields = {};
    // Common field-name aliases the AI uses (e.g. "headline" when the blueprint field is "title").
    const FIELD_ALIASES = { headline: 'title', title: 'headline' };
    for (const [k, v] of Object.entries(input.fields)) {
      // Resolve alias: if the field name isn't in the item's set but its alias is, redirect the write.
      const alias = !itemFieldTypes[k] && FIELD_ALIASES[k] && itemFieldTypes[FIELD_ALIASES[k]] ? FIELD_ALIASES[k] : null;
      const effectiveKey = alias ?? k;
      const effectiveType = itemFieldTypes[effectiveKey];
      // Auto-convert bard arrays to plain text for fields declared as plain-string types.
      if (STRING_TYPES.has(effectiveType) && Array.isArray(v)) {
        normalizedFields[effectiveKey] = coerceFieldValue(effectiveKey, v, effectiveType, itemFieldTypes, normalizedFields);
        continue;
      }
      // Normalize replicator sub-items: infer type, coerce textarea→string, asset string→array.
      if (effectiveType === 'replicator' && Array.isArray(v) && resolvedSetType) {
        normalizedFields[effectiveKey] = normalizeSubItems(v, resolvedSetType);
        continue;
      }
      // Grid rows: normalize each row (add _id, coerce bard/assets values).
      if (effectiveType === 'grid' && Array.isArray(v)) {
        const gridFieldDef = cachedSetsSnapshot[resolvedSetType]?.fields?.find(f => f.handle === effectiveKey);
        const rowFieldTypes = gridFieldDef?.fields
          ? Object.fromEntries(gridFieldDef.fields.filter(f => f.handle && f.type).map(f => [f.handle, f.type]))
          : {};
        normalizedFields[effectiveKey] = v.map(row => normalizeGridRow(row, rowFieldTypes));
        continue;
      }
      const sanitized = sanitizeBardContent(v, blueprint);
      // Track bard field updates so we can inject meta for nested bard set nodes.
      if (effectiveType === 'bard' && Array.isArray(sanitized)) bardFieldUpdates[effectiveKey] = sanitized;
      normalizedFields[effectiveKey] = sanitized;
    }
    // Pre-fetch asset objects for all assets fields inside grid rows so that
    // injectNestedGridRowsMeta can populate meta.data and prevent loadAssets calls.
    // { gridHandle: { rowId: { assetFieldHandle: [assetObjects] } } }
    const gridRowAssetData = {};
    const gridFetchEntries = Object.entries(normalizedFields).filter(
      ([k, v]) => itemFieldTypes[k] === 'grid' && Array.isArray(v)
    );
    for (const [gridHandle, rows] of gridFetchEntries) {
      const gridFieldDef = cachedSetsSnapshot[resolvedSetType]?.fields?.find(f => f.handle === gridHandle);
      const rowFieldTypes = gridFieldDef?.fields
        ? Object.fromEntries(gridFieldDef.fields.filter(f => f.handle && f.type).map(f => [f.handle, f.type]))
        : {};
      const assetHandles = Object.entries(rowFieldTypes).filter(([, ft]) => ft === 'assets').map(([fh]) => fh);
      if (!assetHandles.length) continue;
      gridRowAssetData[gridHandle] = {};
      await Promise.all(rows.map(async (row) => {
        if (!row?._id) return;
        const rowAssets = {};
        await Promise.all(assetHandles.map(async (fh) => {
          const paths = row[fh];
          if (Array.isArray(paths) && paths.length) {
            rowAssets[fh] = await fetchStatamicAssetData(paths);
          }
        }));
        if (Object.keys(rowAssets).length) gridRowAssetData[gridHandle][row._id] = rowAssets;
      }));
    }

    for (const [rootHandle, rootValue] of Object.entries(values)) {
      if (!Array.isArray(rootValue)) continue;
      const cloned = cloneValue(rootValue);
      const type = patchItemInArray(cloned, input.id, normalizedFields);
      if (type !== false) {
        // Inject meta for new replicator sub-items BEFORE commitField so Vue doesn't
        // crash on first render trying to access meta.existing[id] = undefined.
        const replicatorUpdates = Object.fromEntries(
          Object.entries(normalizedFields).filter(([k, v]) => itemFieldTypes[k] === 'replicator' && Array.isArray(v))
        );
        if (Object.keys(replicatorUpdates).length) {
          injectNestedReplicatorItemsMeta(window.Statamic, rootHandle, input.id, replicatorUpdates);
          // For each replicator sub-item, also inject meta for any nested grid rows
          // (e.g., rows grid inside section items of a table replicator).
          for (const repItems of Object.values(replicatorUpdates)) {
            for (const repItem of repItems) {
              if (!repItem?._id) continue;
              const itemSetDef = cachedSetsSnapshot[repItem.type];
              const nestedGridUpdates = {};
              for (const [fk, fv] of Object.entries(repItem)) {
                if (!Array.isArray(fv) || !fv.length) continue;
                const fieldDef = itemSetDef?.fields?.find(f => f.handle === fk);
                if (fieldDef?.type !== 'grid') continue;
                nestedGridUpdates[fk] = fv;
              }
              if (Object.keys(nestedGridUpdates).length) {
                injectNestedGridRowsMeta(window.Statamic, rootHandle, repItem._id, nestedGridUpdates);
              }
            }
          }
        }
        // Inject meta for new grid rows on the item itself (e.g., icons grid on an icons tile).
        // Pass pre-fetched asset data so loadAssets is never triggered for image fields in rows.
        const gridUpdates = Object.fromEntries(
          Object.entries(normalizedFields).filter(([k, v]) => itemFieldTypes[k] === 'grid' && Array.isArray(v))
        );
        if (Object.keys(gridUpdates).length) {
          injectNestedGridRowsMeta(window.Statamic, rootHandle, input.id, gridUpdates, gridRowAssetData);
        }
        pushUndoSnapshot();
        commitField(window.Statamic, rootHandle, cloned);
        if (Object.keys(bardFieldUpdates).length) {
          injectBardSetsMeta(window.Statamic, rootHandle, input.id, bardFieldUpdates);
        }
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
    // Field types from Vuex blueprint (may miss imported fieldsets); merge with endpoint blueprint.
    const vuexFieldTypes = getSetFieldTypes(blueprint, type, nestedParentType);
    const endpointFields = cachedSets[type]?.fields ?? [];
    const endpointFieldTypes = Object.fromEntries(
      endpointFields.filter(f => f.handle && f.type).map(f => [f.handle, f.type])
    );
    const fieldTypes = { ...vuexFieldTypes, ...endpointFieldTypes }; // endpoint wins
    const STRING_FIELD_TYPES = new Set(['textarea', 'text', 'slug', 'markdown']);
    const SELECT_FIELD_TYPES = new Set(['select', 'radio', 'button_group']);
    for (const [k, v] of Object.entries(fields)) {
      if (SELECT_FIELD_TYPES.has(fieldTypes[k]) && v !== null && typeof v !== 'string') {
        return { error: `Field "${k}" is a ${fieldTypes[k]} field — value must be a plain option key string, never an object or array. Got: ${JSON.stringify(v)}` };
      }
    }
    // Build a snapshot of all set definitions so replicator sub-items can have type inferred.
    const allSetsForAdd = hasCached ? cachedSets : extractBlueprintSets(blueprint);
    // Normalize a single replicator sub-item: infer missing type, fix headline↔title alias,
    // coerce string fields, wrap bare asset strings in arrays.
    const normalizeAddSubItem = (item, parentSetType) => {
      if (!item || typeof item !== 'object') return item;
      const childSets = Object.values(allSetsForAdd).filter((s) => s._parent_set === parentSetType);
      const singleChildType = childSets.length === 1 ? childSets[0].handle : null;
      const resolvedType = item.type ?? singleChildType;
      if (!resolvedType) return { _id: uid(), enabled: true, ...item };
      const setDef = allSetsForAdd[resolvedType];
      const setFTypes = setDef?.fields
        ? Object.fromEntries(setDef.fields.filter((f) => f.handle && f.type).map((f) => [f.handle, f.type]))
        : {};
      const out = { _id: uid(), enabled: true, ...item, type: resolvedType };
      for (const [wrong, correct] of [['headline', 'title'], ['title', 'headline']]) {
        if (out[wrong] !== undefined && !setFTypes[wrong] && setFTypes[correct] && out[correct] === undefined) {
          out[correct] = out[wrong]; delete out[wrong];
        }
      }
      for (const [fk, fv] of Object.entries(out)) {
        if (fk === 'type' || fk === '_id' || fk === 'enabled') continue;
        const ft = setFTypes[fk];
        if (!ft) continue;
        if (STRING_FIELD_TYPES.has(ft) && Array.isArray(fv)) out[fk] = bardArrayToPlainText(fv);
        else if (ft === 'assets' && typeof fv === 'string') out[fk] = [fv];
      }
      return out;
    };
    // Bard fields are stripped — Statamic must initialize new items before bard content
    // can be set. Use update_item after creation to populate bard fields.
    // String-type fields that receive a bard array are auto-converted to plain text.
    // Replicator sub-items get type inferred + field coercion. Grid rows get asset strings wrapped.
    const skippedBard = [];
    const sanitizedFields = Object.fromEntries(
      Object.entries(fields).filter(([k, v]) => {
        if (fieldTypes[k] === 'bard' && Array.isArray(v)) { skippedBard.push(k); return false; }
        return true;
      }).map(([k, v]) => {
        if (STRING_FIELD_TYPES.has(fieldTypes[k]) && Array.isArray(v)) return [k, bardArrayToPlainText(v)];
        if (Array.isArray(v) && fieldTypes[k] === 'replicator') {
          return [k, v.map((item) => normalizeAddSubItem(item, type))];
        }
        if (Array.isArray(v) && fieldTypes[k] === 'grid') {
          const gridFieldDef = allSetsForAdd[type]?.fields?.find(f => f.handle === k);
          const rowFieldTypes = gridFieldDef?.fields
            ? Object.fromEntries(gridFieldDef.fields.filter(f => f.handle && f.type).map(f => [f.handle, f.type]))
            : {};
          return [k, v.map((row) => normalizeGridRow(row, rowFieldTypes, blueprint))];
        }
        // Auto-wrap bare asset strings into arrays (assets fields always store arrays).
        if (fieldTypes[k] === 'assets' && typeof v === 'string') return [k, [v]];
        return [k, v];
      }),
    );
    const newItem = { _id: uid(), type, enabled: true, ...defaults, ...sanitizedFields };

    if (isTopLevel) {
      const cloned = cloneValue(Array.isArray(values[parent]) ? values[parent] : []);
      insertAfterIdOrAppend(cloned, newItem, after_id);
      pushUndoSnapshot();
      // Inject meta (with all inline sub-items) BEFORE committing values. The new item is not yet
      // in the values array, so Vue won't render it during the meta commit. When values are then
      // committed, Vue renders the new item with meta already in place — no crash window.
      const topInlineReplicators = Object.fromEntries(
        Object.entries(sanitizedFields).filter(([k, v]) => Array.isArray(v) && fieldTypes[k] === 'replicator')
      );
      const topInlineGrids = Object.fromEntries(
        Object.entries(sanitizedFields).filter(([k, v]) => Array.isArray(v) && fieldTypes[k] === 'grid')
      );
      const topAssetFieldEntries = Object.entries(sanitizedFields).filter(([k, v]) => Array.isArray(v) && fieldTypes[k] === 'assets');
      const topInlineAssets = {};
      await Promise.all(topAssetFieldEntries.map(async ([fh, paths]) => {
        topInlineAssets[fh] = await fetchStatamicAssetData(paths);
      }));
      injectTopLevelItemMeta(window.Statamic, parent, newItem._id, type,
        topInlineReplicators, topInlineGrids, topInlineAssets);
      commitField(window.Statamic, parent, cloned);
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
              error: `Type "${type}" is only valid inside "${requestedSet._parent_set}" sections. Parent "${parent}" is type "${parentType}". Valid types for "${parentType}": [${validTypes || 'see blueprint in context'}]`,
            };
          }
        }
      }
      if (addToParentItem(cloned, parent, field, newItem, after_id)) {
        // Inject meta for the new item and all inline sub-items in a single setMeta commit,
        // preventing a race condition where loadAssets re-renders between two separate commits.
        const inlineReplicators = Object.fromEntries(
          Object.entries(sanitizedFields).filter(([k, v]) => Array.isArray(v) && fieldTypes[k] === 'replicator')
        );
        const inlineGrids = Object.fromEntries(
          Object.entries(sanitizedFields).filter(([k, v]) => Array.isArray(v) && fieldTypes[k] === 'grid')
        );
        // Fetch real asset objects before injecting meta. Pre-populating meta.data with the
        // fetched objects prevents Statamic's initializeAssets from calling loadAssets (async).
        // loadAssets would otherwise fire and, when complete, commit setMeta with a stale store
        // snapshot that wipes out meta for any item added after this one, causing a render crash.
        const assetFieldEntries = Object.entries(sanitizedFields).filter(([k, v]) => Array.isArray(v) && fieldTypes[k] === 'assets');
        const inlineAssets = {};
        await Promise.all(assetFieldEntries.map(async ([fh, paths]) => {
          inlineAssets[fh] = await fetchStatamicAssetData(paths);
        }));
        injectNestedItemMeta(window.Statamic, rootHandle, parent, field, newItem._id, type,
          inlineReplicators, inlineGrids, inlineAssets);
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

async function sendToClaude(allMessages, systemPrompt, tools, { maxTokens } = {}) {
  const body = { messages: allMessages };
  if (systemPrompt) body.system = systemPrompt;
  if (tools?.length) body.tools = tools;
  if (maxTokens) body.max_tokens = maxTokens;

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

const MAX_MSG_HEIGHT = 120;
const MAX_TECHNICAL_HEIGHT = 40;

function addExpandToggle(el, bgColor, maxHeight = MAX_MSG_HEIGHT) {
  setTimeout(() => {
    if (el.scrollHeight <= maxHeight) return;
    el.style.maxHeight = maxHeight + 'px';
    el.style.overflow = 'hidden';

    const fade = document.createElement('div');
    fade.style.cssText = `position:absolute;bottom:0;left:0;right:0;height:28px;background:linear-gradient(transparent,${bgColor});pointer-events:none`;
    el.appendChild(fade);

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = '▾';
    btn.style.cssText = 'position:absolute;bottom:2px;right:4px;background:none;border:none;cursor:pointer;font-size:12px;line-height:1;padding:0 2px;color:rgba(0,0,0,0.4);pointer-events:auto';

    let expanded = false;
    btn.addEventListener('click', () => {
      expanded = !expanded;
      el.style.maxHeight = expanded ? '' : maxHeight + 'px';
      el.style.overflow = expanded ? '' : 'hidden';
      fade.style.display = expanded ? 'none' : '';
      btn.textContent = expanded ? '▴' : '▾';
      if (!expanded) el.scrollIntoView({ block: 'nearest' });
    });
    el.appendChild(btn);
  }, 0);
}

function appendMessage(historyEl, role, text) {
  const msg = document.createElement('div');
  msg.style.marginBottom = '4px';
  msg.style.padding = '4px 7px';
  msg.style.borderRadius = '4px';
  msg.style.fontSize = '12px';
  msg.style.lineHeight = '1.5';
  msg.style.wordBreak = 'break-word';
  msg.style.position = 'relative';
  msg.style.flexShrink = '0';

  const bgColor = role === 'user' ? 'rgba(0,0,0,0.06)' : 'rgba(99,102,241,0.1)';
  msg.style.background = bgColor;

  if (role === 'user') {
    msg.style.marginLeft = '16px';
    msg.style.whiteSpace = 'pre-wrap';
    msg.textContent = text;
    addExpandToggle(msg, '#f0f0f0');
  } else {
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
  msg.style.position = 'relative';
  msg.style.flexShrink = '0';
  msg.textContent = text;
  historyEl.appendChild(msg);
  historyEl.scrollTop = historyEl.scrollHeight;
  addExpandToggle(msg, '#fff', MAX_TECHNICAL_HEIGHT);
  return msg;
}

function setTechnicalVisibility(historyEl, visible) {
  historyEl.querySelectorAll('[data-technical]').forEach((el) => {
    el.style.display = visible ? '' : 'none';
  });
}

function updateTokenDisplay(tokenEl) {
  tokenEl.textContent = `↑${totalInputTokens} ↓${totalOutputTokens}  +${totalCacheReadTokens} tokens`;
}

function buildSystemPrompt(getBrief) {
  const brief = getBrief?.();
  const briefJson = brief ? JSON.stringify(brief, null, 2) : null;

  const staticText = `You are an AI assistant helping a web editor manage content in a Statamic CMS.
The site is for a plastic surgery clinic in Frankfurt, Germany.
You help with content suggestions, copywriting, and structure advice for any entry type — pages, blog posts, testimonials, or others.
Respond concisely.
Do not narrate your intentions or reasoning alongside tool calls — execute tools silently. Only produce a text response when all tool calls are complete, to report what was done, ask a clarifying question, or describe a problem. Never say "I'll now…", "Let me check…", or similar planning phrases before tool calls.
When referring to sections to the user, use 1-based numbering (e.g. "section 1", "section 2"). Tool calls always use _id values — never positional indexes.
ITEM IDs: Every item in the brief (sections, tiles, accordion items, etc.) has a unique _id. Always use these in tool calls. Never guess or construct an _id — if you cannot find the exact _id in the brief, stop and ask the user to clarify instead of proceeding. Write tool responses include a "type" field confirming what was affected — verify it matches your intention before continuing.
BRIEF: The brief is rebuilt after every write operation and always reflects current entry state. The current brief is the complete structure — any item not listed in it does not exist.
HIERARCHY: The word "section" always means a top-level entry in the sections (or equivalent) array. Items nested inside a section (tiles, accordion items, etc.) are sub-items — not sections themselves. When looking for a section by type, only consider top-level entries.
READING: The brief contains every item's _id, type, and key content. Do NOT call get_item before delete, move, or update_item — derive the _id from the brief. Only call get_item when you need full raw data not in the brief (e.g. complete ProseMirror nodes of a bard field you intend to edit).
UPDATING: update_item patches any item at any depth by _id. To update a tile, accordion item, or any nested item, use its own _id directly — no need to reconstruct the parent array. For top-level scalar fields (title, date, slug, etc.) use update_field.
ADDING: add_item takes parent + type. For top-level items use the root field handle as parent — read the _root_field value on the set type you want from the blueprint provided in your context (e.g. schema_set has _root_field:"schema", not "sections"). For nested items (e.g. a tile inside a section) use the parent item's _id as parent and set field to the replicator field name (e.g. "tiles"). The optional fields parameter is for scalar values (text, numbers, asset strings). If you pre-populate a nested replicator array via fields (e.g. fields.steps), every sub-item in that array MUST include "type" (the set handle from the blueprint) — _id and enabled are injected automatically. The same rule applies when using update_item to set a replicator field: every item in the array must include "type". Example: update_item(id, {steps:[{type:"step",title:"...",text:"..."},...]}). Omitting "type" causes silent render errors in the editor.
BARD FIELDS use ProseMirror JSON. Bard fields cannot be set during add_item — they are always initialized empty. If you pass bard content in add_item fields, the response will include "set_bard_fields" listing the skipped fields; immediately follow up with update_item calls (in parallel) to set those fields. For existing items, always call get_item first to read the current structure before editing. ProseMirror rules: text leaf nodes are {"type":"text","text":"..."} (never "value"); paragraphs are {"type":"paragraph","content":[{"type":"text","text":"..."}]}; headings are {"type":"heading","attrs":{"level":2,"textAlign":"left"},"content":[...]}; bard set nodes use {"type":"set","attrs":{"id":"...","values":{...}}} where values holds the set fields. IMAGES in bard: never use {"type":"image",...} inline nodes — that TipTap extension is not active. Embed images as bard sets: {"type":"set","attrs":{"id":"...","values":{"type":"image","enabled":true,"image":["assets::path/to/file.jpg"]}}}.
ASSET FIELDS always store values as arrays of "assets::..." strings — even when max_files is 1. Example: ["assets::praxis/image.jpg"]. Always include the assets:: prefix on each string. When using add_item fields for a top-level asset field you may pass a bare string and it will be auto-wrapped; but when setting an asset field inside a grid row or a replicator item via update_item you MUST pass an array: {image:["assets::path/to/file.jpg"]}. Always call search_assets to verify a path before using it.
GRID FIELDS (e.g. "rows" in a table group, "icons" in an icons tile) are flat arrays — each row has no _id and cannot use add_item. To populate a grid field use update_item on the parent item with the full array value. Asset fields within grid rows must be arrays: {image:["assets::path.jpg"],text:"..."}. Example icons: update_item(iconsTileId,{icons:[{image:["assets::img.jpg"],text:"Label"},...]}). Example table rows: update_item(sectionId,{rows:[{label:"Label",text:[{type:"paragraph",content:[{type:"text",text:"Value"}]}]},...]}).
TEXTAREA FIELDS are plain strings — even when nested inside a replicator or grid. If the blueprint shows type "textarea" or "text", always set a plain string. Never pass an array or ProseMirror object. Example steps: update_item(id,{steps:[{type:"step",title:"Title",text:"Plain text string."}]}).
SELECT FIELDS (type: select, radio, button_group): always set to the option key as a plain string, exactly as listed under "options" in the blueprint (e.g. badges_group: "certificates_shortest"). Never pass an object or array — that crashes the editor.
BUTTONS in call_to_action sections: the "text" field is a plain textarea string. The "buttons" field is a replicator — add each button using add_item(parent=sectionId, field="buttons", type="button_book_page") etc., one call per button.
BUTTONS BARD SET inside text fields (e.g. header text): button items live inside a bard set node of type "buttons". Include them inline in the values.buttons array when setting the bard field — do NOT use add_item for these. Find available button types in the blueprint provided in your context (look for sets with names like "button_book_page" inside the "buttons" bard set). Example full bard array with a buttons set at the end: [{type:"heading",attrs:{level:1,textAlign:"left"},content:[{type:"text",text:"Title"}]},{type:"paragraph",content:[{type:"text",text:"Body."}]},{type:"set",attrs:{id:"UUID",values:{type:"buttons",enabled:true,align:"center",buttons:[{_id:"UUID",type:"button_book_page",enabled:true}]}}}]. Generate fresh UUIDs for all id/\_id fields.
EMPTY FIELDS: The brief omits fields that have no value. The "_fields" key lists all known field handles for this entry type, including empty ones. If a user refers to a field not shown in the brief but listed in "_fields", use update_field or get_field directly — do not say the field doesn't exist.
When passing a complex object or array as a tool argument value, pass it as a native JSON value — never as a JSON string.`;

  // Get blueprint — prefer the endpoint-fetched cache (fully resolves imported fieldsets),
  // fall back to Vuex-derived extraction.
  const bpCached = blueprintDataProvider?.()?.sets;
  const blueprintSets = (bpCached && Object.keys(bpCached).length > 0)
    ? bpCached
    : (() => {
        const bp = getPublishStore(window.Statamic)?.blueprint;
        return bp ? extractBlueprintSets(bp) : null;
      })();
  const blueprintJson = blueprintSets ? JSON.stringify(blueprintSets) : null;

  const blocks = [
    { type: 'text', text: staticText, cache_control: { type: 'ephemeral' } },
  ];

  if (blueprintJson) {
    // Blueprint as a second cached block — avoids a get_blueprint tool call and keeps the
    // blueprint tokens cached (0.1× cost) across all rounds in the same build session.
    blocks.push({
      type: 'text',
      text: `Blueprint (all available item types with _root_field, _parent_set, field handles and types):\n\`\`\`json\n${blueprintJson}\n\`\`\``,
      cache_control: { type: 'ephemeral' },
    });
  }

  if (briefJson) {
    blocks.push({ type: 'text', text: `Current page brief:\n\`\`\`json\n${briefJson}\n\`\`\`` });
  }

  return blocks;
}

export function getAiBlueprintSets() {
  const bpCached = blueprintDataProvider?.()?.sets;
  if (bpCached && Object.keys(bpCached).length > 0) return bpCached;
  const bp = getPublishStore(window.Statamic)?.blueprint;
  return bp ? extractBlueprintSets(bp) : null;
}

function mountBardEditor(container) {
  const BardComp = window.Vue?.component?.('bard-fieldtype');
  if (!BardComp) return null;

  if (!document.getElementById('st-bard-doc-style')) {
    const s = document.createElement('style');
    s.id = 'st-bard-doc-style';
    s.textContent = '.st-doc-bard{position:relative;flex:1;min-height:0}.st-doc-bard .bard-fieldtype-wrapper{position:absolute;inset:0;display:flex;flex-direction:column;border:1px solid rgba(0,0,0,0.15);border-radius:4px;overflow:hidden}.st-doc-bard .bard-fixed-toolbar{flex-shrink:0}.st-doc-bard .bard-editor{display:flex;flex-direction:column;flex:1;min-height:0}.st-doc-bard .bard-editor>div{display:flex;flex-direction:column;flex:1;min-height:0}.st-doc-bard .bard-editor .ProseMirror{flex:1;min-height:80px;overflow-y:auto;padding:6px 8px;outline:none}.st-doc-bard .bard-content{overflow-y:auto}.st-doc-bard .bard-content ul{list-style-type:disc;padding-left:1.5em;margin:.3em 0}.st-doc-bard .bard-content ol{list-style-type:decimal;padding-left:1.5em;margin:.3em 0}.st-doc-bard .bard-content li{margin:.1em 0}.st-doc-bard .bard-content blockquote{border-left:3px solid rgba(0,0,0,0.25);padding-left:.75em;margin:.3em 0;color:rgba(0,0,0,0.6);font-style:italic}.st-doc-bard .bard-content table{border-collapse:collapse;width:100%;margin:.5em 0}.st-doc-bard .bard-content td,.st-doc-bard .bard-content th{border:1px solid rgba(0,0,0,0.2);padding:4px 8px;min-width:2em}.st-doc-bard .bard-content th{background:rgba(0,0,0,0.04);font-weight:600}.st-doc-portals .popover{z-index:100}.st-doc-portals .stack{z-index:100}.st-doc-bard .bard-content a{color:#43a9ff;text-decoration:underline}';
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

export function createChatSection(getBrief, getBlueprintData, panelStorageKey) {
  blueprintDataProvider = getBlueprintData ?? null;
  const _initState = panelStorageKey ? readPanelState(panelStorageKey) : {};
  let showTechnical = _initState.showTechnical ?? false;

  const section = document.createElement('div');
  section.style.display = 'flex';
  section.style.flexDirection = 'column';
  section.style.flex = '1';
  section.style.minHeight = '0';
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
  headerRow.style.flexShrink = '0';
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
  techToggle.textContent = showTechnical ? 'hide technical' : 'show technical';
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
    if (panelStorageKey) writePanelState(panelStorageKey, { showTechnical });
  });

  const clearBtn = document.createElement('button');
  clearBtn.type = 'button';
  clearBtn.textContent = 'new chat';
  clearBtn.style.fontSize = '10px';
  clearBtn.style.background = 'none';
  clearBtn.style.border = 'none';
  clearBtn.style.cursor = 'pointer';
  clearBtn.style.color = 'rgba(0,0,0,0.35)';
  clearBtn.style.padding = '0';

  function resetChat() {
    messages = [];
    totalInputTokens = 0;
    totalOutputTokens = 0;
    totalCacheReadTokens = 0;
    history.innerHTML = '';
    updateTokenDisplay(tokenInfo);
  }

  clearBtn.addEventListener('click', resetChat);

  headerButtons.appendChild(techToggle);
  headerButtons.appendChild(clearBtn);

  // Mirrors headerButtons but shown in the Document tab
  const docHeaderButtons = document.createElement('div');
  docHeaderButtons.style.display = 'none';
  docHeaderButtons.style.gap = '8px';
  docHeaderButtons.style.alignItems = 'center';

  headerRow.appendChild(tabBar);
  headerRow.appendChild(headerButtons);
  headerRow.appendChild(docHeaderButtons);

  // Chat view
  const chatView = document.createElement('div');
  chatView.style.display = 'flex';
  chatView.style.flex = '1';
  chatView.style.minHeight = '0';
  chatView.style.flexDirection = 'column';
  chatView.style.gap = '5px';

  const history = document.createElement('div');
  history.style.flex = '1';
  history.style.minHeight = '40px';
  history.style.overflowY = 'auto';
  history.style.display = 'flex';
  history.style.flexDirection = 'column';

  const inputRow = document.createElement('div');
  inputRow.style.display = 'flex';
  inputRow.style.gap = '5px';

  const textarea = document.createElement('textarea');
  textarea.rows = 3;
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
  sendBtn.style.height = '100%';

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
  documentView.style.flex = '1';
  documentView.style.minHeight = '0';
  documentView.style.flexDirection = 'column';
  documentView.style.gap = '5px';

  const docEditorContainer = document.createElement('div');
  docEditorContainer.style.flex = '1';
  docEditorContainer.style.minHeight = '0';
  docEditorContainer.style.display = 'flex';
  docEditorContainer.style.flexDirection = 'column';

  function ensureBardEditor() {
    if (bardEditor) return;
    bardEditor = mountBardEditor(docEditorContainer);
  }

  const docBtnRow = document.createElement('div');
  docBtnRow.style.display = 'flex';
  docBtnRow.style.flexShrink = '0';
  docBtnRow.style.justifyContent = 'flex-end';
  docBtnRow.style.alignItems = 'center';
  docBtnRow.style.gap = '6px';

  const clearDocBtn = document.createElement('button');
  clearDocBtn.type = 'button';
  clearDocBtn.textContent = 'clear';
  clearDocBtn.style.cssText = 'font-size:10px;background:none;border:none;cursor:pointer;color:rgba(0,0,0,0.35);padding:0;font-family:inherit';
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
  uploadBtn.style.cssText = 'font-size:10px;background:none;border:none;cursor:pointer;color:rgba(0,0,0,0.35);padding:0;font-family:inherit';

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
      setTimeout(() => { uploadBtn.textContent = 'upload .docx'; }, 2000);
    } finally {
      uploadBtn.textContent = 'upload .docx';
      uploadBtn.disabled = false;
      docxInput.value = '';
    }
  });

  uploadBtn.addEventListener('click', () => { if (!uploadBtn.disabled) docxInput.click(); });

  const BUILD_PROMPT_RULES =
    'Blockquotes are editor instructions — they describe what to create and how. The content directly below a blockquote is the actual content for that section. Blockquotes may use formal directives ("> [[ SECTION: type ]]") or plain natural language ("Quote section, text below") — treat both as instructions.\n' +
    'GRID FIELDS: some fields (e.g. "rows" in table sections) are grid fields, NOT replicators. ' +
    'Grid fields have no _id per row and cannot use add_item. ' +
    'Populate a grid field by calling update_item on the parent with the full array value.\n' +
    'TABLE SECTIONS — exact sequence (no deviation):\n' +
    '  1. add_item(parent="sections", type="table") → note the returned id as TABLE_ID\n' +
    '  2. add_item(parent=TABLE_ID, field="table", type="section") → note returned id as GROUP_ID\n' +
    '  3. update_item(GROUP_ID, {rows:[{label:"Label",text:[{type:"paragraph",content:[{type:"text",text:"Value"}]}]}, ...]}) — do this immediately in the same tool batch as step 2 if possible, or in the very next tool call. Do NOT skip this step or say you will do it later.\n\n' +
    '---\n\n';

  function doBuild(mode) {
    const html = bardEditor?.getHTML() ?? '';
    const md = htmlToMarkdown(html);
    if (!md.trim()) return;

    if (mode === 'replace') {
      resetChat();
      const values = getPublishStore(window.Statamic)?.values ?? {};
      for (const [handle, value] of Object.entries(values)) {
        if (handle === 'slug') continue;
        const empty = Array.isArray(value) ? [] : typeof value === 'string' ? '' : typeof value === 'boolean' ? false : null;
        commitField(window.Statamic, handle, empty);
      }
    }

    const preamble = mode === 'replace'
      ? 'All page fields have been cleared (except slug). Build the full page from the document content below.\n'
      : 'Add new content from the document below, appending after existing content. Do not modify or remove anything already on the page.\n';

    switchTab('chat');
    handleSend(preamble + BUILD_PROMPT_RULES + md, { maxRounds: MAX_ROUNDS_BUILD, maxTokens: 8192, isBuild: true });
  }

  const replaceBtn = document.createElement('button');
  replaceBtn.type = 'button';
  replaceBtn.className = 'btn btn-primary';
  replaceBtn.textContent = 'Build';
  replaceBtn.title = 'Clear the entire page and build it from scratch using the document above';
  replaceBtn.setAttribute('aria-label', 'Clear page and build from document');
  replaceBtn.addEventListener('click', () => doBuild('replace'));

  const appendBtn = document.createElement('button');
  appendBtn.type = 'button';
  appendBtn.className = 'btn btn-primary';
  appendBtn.textContent = 'Add';
  appendBtn.title = 'Append new sections to the page based on the document above';
  appendBtn.setAttribute('aria-label', 'Add document content to page');
  appendBtn.addEventListener('click', () => doBuild('append'));

  docHeaderButtons.appendChild(uploadBtn);
  docHeaderButtons.appendChild(clearDocBtn);

  docBtnRow.appendChild(docxInput);
  docBtnRow.appendChild(appendBtn);
  docBtnRow.appendChild(replaceBtn);
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
      uploadBtn.textContent = 'upload .docx';
      uploadBtn.disabled = false;
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
    headerButtons.style.display = tab === 'chat' ? 'flex' : 'none';
    docHeaderButtons.style.display = tab === 'document' ? 'flex' : 'none';
    if (tab === 'document') { ensureBardEditor(); loadMammoth(); }
  }

  chatTabBtn.addEventListener('click', () => switchTab('chat'));
  docTabBtn.addEventListener('click', () => switchTab('document'));

  section.appendChild(headerRow);
  section.appendChild(chatView);
  section.appendChild(documentView);

  async function handleSend(customText, { maxRounds = MAX_ROUNDS, maxTokens, isBuild = false } = {}) {
    const text = (customText ?? textarea.value).trim();
    if (!text) return;

    if (!customText) textarea.value = '';
    textarea.disabled = true;
    sendBtn.disabled = true;
    replaceBtn.disabled = true;
    appendBtn.disabled = true;
    sendBtn.textContent = '…';

    const displayText = customText && customText.length > 120
      ? customText.slice(0, 120) + '…'
      : text;

    const userContent = customText ? [{ type: 'text', text }] : text;
    messages.push({ role: 'user', content: userContent });
    appendMessage(history, 'user', displayText);

    let systemPrompt = buildSystemPrompt(getBrief);
    const msgCountBefore = messages.length;

    try {
      let lastToolSignature = null;
      let finalText = null;

      for (let round = 0; round < maxRounds; round++) {
        if (round > 0) sendBtn.textContent = `step ${round + 1}/${maxRounds}…`;

        const data = await sendToClaude(messages, systemPrompt, AI_TOOLS, { maxTokens });

        totalInputTokens += data.usage?.input_tokens ?? 0;
        totalOutputTokens += data.usage?.output_tokens ?? 0;
        totalCacheReadTokens += data.usage?.cache_read_input_tokens ?? 0;
        updateTokenDisplay(tokenInfo);

        if (data.stop_reason !== 'tool_use') {
          const text = data.content?.find((b) => b.type === 'text')?.text ?? '';
          // In build mode, detect planning-without-executing: AI announces intent (end_turn) but
          // made no tool calls. Nudge it to proceed rather than silently stopping.
          if (isBuild && round < maxRounds - 1) {
            const NUDGE_PHRASES = ["i'll ", "i will ", "let me ", "now i'll ", "i'll now ", "i'm going to ", "i will now "];
            if (NUDGE_PHRASES.some(p => text.toLowerCase().includes(p))) {
              if (text.trim()) appendMessage(history, 'assistant', text);
              messages.push({ role: 'assistant', content: data.content });
              messages.push({ role: 'user', content: 'Please proceed with the tool calls you just described.' });
              const nudgeMsg = appendTechnical(history, '→ [nudge: AI planned without tool calls — continuing loop]', true);
              if (!showTechnical) nudgeMsg.style.display = 'none';
              continue;
            }
          }
          finalText = text || '[no response]';
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

        // Intermediate text alongside tool calls is suppressed — it is always narration
        // ("I'll now…", "Let me verify…"). Questions and error reports are shown as end_turn.

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
      replaceBtn.disabled = false;
      appendBtn.disabled = false;
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
