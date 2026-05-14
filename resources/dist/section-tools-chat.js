import { getPublishStore, getSections, setSections, assignFreshSectionIdentity, uid, getPublishModulesWithSections } from './section-tools-lib.js';
import { simplifyBlueprintNode, fetchAssetsForAI } from './section-tools-queries.js';
import { pushUndoSnapshot } from './section-tools-mutations.js';

let messages = [];
let totalInputTokens = 0;
let totalOutputTokens = 0;

const MAX_ROUNDS = 8;

const AI_TOOLS = [
  {
    name: 'get_section',
    description: 'Get the full raw content of one section by its 0-based index.',
    input_schema: {
      type: 'object',
      properties: {
        index: { type: 'integer', description: 'Zero-based section index' },
      },
      required: ['index'],
    },
  },
  {
    name: 'get_blueprint',
    description: 'Get the page blueprint — all available section types and their fields.',
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
    name: 'update_section',
    description: 'Patch fields on an existing section. Only supplied fields change; others are preserved. Do not change _id.',
    input_schema: {
      type: 'object',
      properties: {
        index: { type: 'integer', description: 'Zero-based section index' },
        fields: { type: 'object', description: 'Key-value pairs of fields to set on the section' },
      },
      required: ['index', 'fields'],
    },
  },
  {
    name: 'add_section',
    description: 'Insert a new section. Supply fields to set content immediately and avoid a separate update_section call.',
    input_schema: {
      type: 'object',
      properties: {
        type: { type: 'string', description: 'Section type handle, e.g. "text" or "quote"' },
        after_index: { type: 'integer', description: 'Insert after this 0-based index. Omit or use -1 to append.' },
        fields: { type: 'object', description: 'Optional fields to set on the new section immediately.' },
      },
      required: ['type'],
    },
  },
  {
    name: 'delete_section',
    description: 'Delete a section by its 0-based index.',
    input_schema: {
      type: 'object',
      properties: {
        index: { type: 'integer', description: 'Zero-based section index to delete' },
      },
      required: ['index'],
    },
  },
  {
    name: 'move_section',
    description: 'Move a section from one position to another.',
    input_schema: {
      type: 'object',
      properties: {
        from: { type: 'integer', description: 'Current 0-based index of the section' },
        to: { type: 'integer', description: 'Target 0-based index after the move' },
      },
      required: ['from', 'to'],
    },
  },
  {
    name: 'update_field',
    description: 'Update a top-level page field such as title or header. Use update_section for fields inside sections.',
    input_schema: {
      type: 'object',
      properties: {
        handle: { type: 'string', description: 'Field handle, e.g. "title" or "header"' },
        value: { description: 'New value to set' },
      },
      required: ['handle', 'value'],
    },
  },
];

async function executeTool(name, input) {
  if (name === 'get_section') {
    const sections = getSections(window.Statamic);
    const section = sections?.[input.index];
    return section ?? { error: `No section at index ${input.index}` };
  }

  if (name === 'get_blueprint') {
    const blueprint = getPublishStore(window.Statamic)?.blueprint;
    if (!blueprint) return { error: 'Blueprint not found' };
    return simplifyBlueprintNode(blueprint) ?? {};
  }

  if (name === 'search_assets') {
    return fetchAssetsForAI(input.query);
  }

  if (name === 'update_section') {
    const sections = getSections(window.Statamic);
    if (!sections) return { error: 'Could not get sections' };
    const { index, fields } = input;
    if (index < 0 || index >= sections.length) {
      return { error: `Index ${index} out of range (0–${sections.length - 1})` };
    }
    pushUndoSnapshot();
    sections[index] = { ...sections[index], ...fields };
    const ok = setSections(window.Statamic, sections);
    return ok ? { ok: true, section: sections[index] } : { error: 'setSections failed' };
  }

  if (name === 'add_section') {
    pushUndoSnapshot();
    const sections = getSections(window.Statamic) ?? [];
    const newSection = { type: input.type, enabled: true, ...(input.fields ?? {}) };
    assignFreshSectionIdentity(newSection);
    const afterIndex = input.after_index ?? sections.length - 1;
    const insertAt = afterIndex < 0 ? sections.length : Math.min(afterIndex + 1, sections.length);
    sections.splice(insertAt, 0, newSection);
    const ok = setSections(window.Statamic, sections);
    return ok ? { ok: true, index: insertAt, section: newSection } : { error: 'setSections failed' };
  }

  if (name === 'delete_section') {
    const sections = getSections(window.Statamic);
    if (!sections) return { error: 'Could not get sections' };
    const { index } = input;
    if (index < 0 || index >= sections.length) {
      return { error: `Index ${index} out of range (0–${sections.length - 1})` };
    }
    pushUndoSnapshot();
    sections.splice(index, 1);
    const ok = setSections(window.Statamic, sections);
    return ok ? { ok: true, deleted_index: index } : { error: 'setSections failed' };
  }

  if (name === 'move_section') {
    const sections = getSections(window.Statamic);
    if (!sections) return { error: 'Could not get sections' };
    const { from, to } = input;
    if (from < 0 || from >= sections.length) return { error: `'from' index out of range` };
    if (to < 0 || to >= sections.length) return { error: `'to' index out of range` };
    if (from === to) return { ok: true, note: 'no change' };
    pushUndoSnapshot();
    const [moved] = sections.splice(from, 1);
    sections.splice(to, 0, moved);
    const ok = setSections(window.Statamic, sections);
    return ok ? { ok: true, moved_to: to } : { error: 'setSections failed' };
  }

  if (name === 'update_field') {
    const { handle, value } = input;
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

  const role = `You are an AI assistant helping a web editor manage page content in a Statamic CMS.
The site is for a plastic surgery clinic in Frankfurt, Germany.
You help with content suggestions, copywriting, and page structure advice.
Respond concisely.
When referring to sections to the user, use 1-based numbering (e.g. "section 1" = index 0, "section 2" = index 1). Tool calls always use 0-based indices.
The page brief already contains every section's index, type, and key content. Do NOT call get_section before delete, move, or update operations — derive the index from the brief. Only call get_section when you need full raw data not visible in the brief (e.g. complete ProseMirror nodes of a bard field you intend to edit).`;

  return briefJson
    ? `${role}\n\nCurrent page brief:\n\`\`\`json\n${briefJson}\n\`\`\``
    : role;
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

    const systemPrompt = buildSystemPrompt(getBrief);
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
