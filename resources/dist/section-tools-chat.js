import { getPublishStore, getSections, setSections, assignFreshSectionIdentity, uid, getPublishModulesWithSections, cloneValue, commitField } from './section-tools-lib.js';
import { simplifyBlueprintNode, fetchAssetsForAI } from './section-tools-queries.js';
import { pushUndoSnapshot } from './section-tools-mutations.js';

function getItemId(item) {
  return item?._id ?? item?.id ?? item?.key ?? null;
}

function patchItemInArray(arr, targetId, fields) {
  for (let i = 0; i < arr.length; i++) {
    const item = arr[i];
    if (!item || typeof item !== 'object') continue;
    if (getItemId(item) === targetId) {
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

function buildItemDefaults(blueprint, type) {
  if (!blueprint || !type) return {};

  function findSetFields(node) {
    if (!node || typeof node !== 'object') return null;
    if (Array.isArray(node)) {
      for (const item of node) {
        const found = findSetFields(item);
        if (found) return found;
      }
      return null;
    }
    if (typeof node.handle === 'string' && node.handle === type && Array.isArray(node.fields)) {
      return node.fields;
    }
    for (const value of Object.values(node)) {
      const found = findSetFields(value);
      if (found) return found;
    }
    return null;
  }

  const fields = findSetFields(blueprint);
  if (!fields) return {};

  const defaults = {};
  const ARRAY_TYPES = new Set(['replicator', 'grid', 'bard', 'checkboxes', 'list', 'tags', 'assets']);
  for (const field of fields) {
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
    description: 'Get the page blueprint — all available item types and their fields.',
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
    description: 'Add a new item to any replicator. "parent" is either a root field handle (e.g. "sections", "header") for top-level items, or the _id of a parent item for nested items. When parent is an _id, "field" is required — the replicator field name within that parent (e.g. "tiles").',
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
    const blueprint = getPublishStore(window.Statamic)?.blueprint;
    if (!blueprint) return { error: 'Blueprint not found' };
    return simplifyBlueprintNode(blueprint) ?? {};
  }

  if (name === 'search_assets') {
    return fetchAssetsForAI(input.query);
  }

  if (name === 'update_item') {
    const values = getPublishStore(window.Statamic)?.values;
    if (!values) return { error: 'Publish store not found' };
    for (const [rootHandle, rootValue] of Object.entries(values)) {
      if (!Array.isArray(rootValue)) continue;
      const cloned = cloneValue(rootValue);
      const type = patchItemInArray(cloned, input.id, input.fields);
      if (type !== false) {
        pushUndoSnapshot();
        commitField(window.Statamic, rootHandle, cloned);
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
    const defaults = buildItemDefaults(blueprint, type);
    const newItem = { _id: uid(), type, enabled: true, ...defaults, ...fields };

    if (typeof parent === 'string' && parent in values) {
      const cloned = cloneValue(Array.isArray(values[parent]) ? values[parent] : []);
      insertAfterIdOrAppend(cloned, newItem, after_id);
      pushUndoSnapshot();
      commitField(window.Statamic, parent, cloned);
      return { ok: true, id: newItem._id };
    }

    if (!field) return { error: 'field is required when parent is an item _id' };
    for (const [rootHandle, rootValue] of Object.entries(values)) {
      if (!Array.isArray(rootValue)) continue;
      const cloned = cloneValue(rootValue);
      if (addToParentItem(cloned, parent, field, newItem, after_id)) {
        pushUndoSnapshot();
        commitField(window.Statamic, rootHandle, cloned);
        return { ok: true, id: newItem._id };
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
    const moduleNames = getPublishModulesWithSections(window.Statamic);
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
    throw new Error(`HTTP ${response.status}`);
  }

  return response.json();
}

function appendMessage(historyEl, role, text) {
  const msg = document.createElement('div');
  msg.style.marginBottom = '4px';
  msg.style.padding = '4px 7px';
  msg.style.borderRadius = '4px';
  msg.style.fontSize = '12px';
  msg.style.lineHeight = '1.5';
  msg.style.wordBreak = 'break-word';
  msg.style.whiteSpace = 'pre-wrap';

  if (role === 'user') {
    msg.style.background = 'rgba(0,0,0,0.06)';
    msg.style.marginLeft = '16px';
  } else {
    msg.style.background = 'rgba(99,102,241,0.1)';
    msg.style.marginRight = '16px';
  }

  msg.textContent = text;
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

  const staticText = `You are an AI assistant helping a web editor manage page content in a Statamic CMS.
The site is for a plastic surgery clinic in Frankfurt, Germany.
You help with content suggestions, copywriting, and page structure advice.
Respond concisely.
When referring to sections to the user, use 1-based numbering (e.g. "section 1", "section 2"). Tool calls always use _id values — never positional indexes.
ITEM IDs: Every item in the brief (sections, tiles, accordion items, etc.) has a unique _id. Always use these in tool calls. Never guess or construct an _id — if you cannot find the exact _id in the brief, stop and ask the user to clarify instead of proceeding. Write tool responses include a "type" field confirming what was affected — verify it matches your intention before continuing.
BRIEF: The brief is rebuilt after every write operation and always reflects current page state. The current brief is the complete page structure — any item not listed in it does not exist on the page.
HIERARCHY: The word "section" always means a top-level entry in the sections array. Items nested inside a section (tiles, accordion items, quotes within a tiles set, etc.) are sub-items of that section — not sections themselves. When looking for a section by type, only consider top-level entries.
READING: The brief contains every item's _id, type, and key content. Do NOT call get_item before delete, move, or update_item — derive the _id from the brief. Only call get_item when you need full raw data not in the brief (e.g. complete ProseMirror nodes of a bard field you intend to edit).
UPDATING: update_item patches any item at any depth by _id. To update a tile, accordion item, or any nested item, use its own _id directly — no need to reconstruct the parent array.
ADDING: add_item takes parent + type. Use the root field handle as parent for top-level items (the top-level keys visible in the brief, e.g. "sections", "header"). For nested items (e.g. a tile inside a section) use the parent item's _id as parent and set field to the replicator field name (e.g. "tiles").
BARD FIELDS use ProseMirror JSON. Always call get_field (for scalar top-level fields) or get_item (for bard fields inside any item) first, then make targeted changes to the returned structure. Never construct bard values from scratch. Key rules: text leaf nodes are {"type":"text","text":"..."} (not "value"); paragraphs are {"type":"paragraph","content":[...]}; bard set nodes are {"type":"set","attrs":{"id":"...","values":{...}}} where values contains the actual set fields.
ASSET FIELDS store values as "assets::path/to/file.jpg" strings (with the assets:: prefix). Always include this prefix when setting an asset field.
When passing a complex object or array as a tool argument value, pass it as a native JSON value — never as a JSON string.`;

  const blocks = [
    { type: 'text', text: staticText, cache_control: { type: 'ephemeral' } },
  ];

  if (briefJson) {
    blocks.push({ type: 'text', text: `Current page brief:\n\`\`\`json\n${briefJson}\n\`\`\`` });
  }

  return blocks;
}

export function createChatSection(getBrief) {
  let showTechnical = true;

  const section = document.createElement('div');
  section.style.display = 'flex';
  section.style.flexDirection = 'column';
  section.style.gap = '5px';
  section.style.paddingBottom = '8px';
  section.style.borderBottom = '1px solid rgba(0,0,0,0.1)';

  // Header row: label + show/hide toggle
  const headerRow = document.createElement('div');
  headerRow.style.display = 'flex';
  headerRow.style.justifyContent = 'space-between';
  headerRow.style.alignItems = 'center';

  const chatLabel = document.createElement('span');
  chatLabel.textContent = 'Chat';
  chatLabel.style.fontSize = '10px';
  chatLabel.style.fontWeight = '600';
  chatLabel.style.color = 'rgba(0,0,0,0.4)';
  chatLabel.style.textTransform = 'uppercase';
  chatLabel.style.letterSpacing = '0.05em';

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

  headerRow.appendChild(chatLabel);
  headerRow.appendChild(techToggle);

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

  section.appendChild(headerRow);
  section.appendChild(history);
  section.appendChild(inputRow);
  section.appendChild(tokenInfo);

  async function handleSend() {
    const text = textarea.value.trim();
    if (!text) return;

    textarea.value = '';
    textarea.disabled = true;
    sendBtn.disabled = true;
    sendBtn.textContent = '…';

    messages.push({ role: 'user', content: text });
    appendMessage(history, 'user', text);

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

        // Append assistant message with tool_use blocks
        messages.push({ role: 'assistant', content: data.content });

        const toolUseBlocks = data.content.filter((b) => b.type === 'tool_use');

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
      sendBtn.textContent = 'Send';
      textarea.focus();
    }
  }

  sendBtn.addEventListener('click', handleSend);
  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  });

  return section;
}
