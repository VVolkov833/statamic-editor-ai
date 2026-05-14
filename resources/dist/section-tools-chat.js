import { getPublishStore, getSections } from './section-tools-lib.js';
import { simplifyBlueprintNode, fetchAssetsForAI } from './section-tools-queries.js';

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

  const role = `You are an AI assistant helping a web editor manage page content in a Statamic CMS.\nThe site is for a plastic surgery clinic in Frankfurt, Germany.\nYou help with content suggestions, copywriting, and page structure advice.\nRespond concisely. When referencing sections, use their index and type.`;

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
      appendMessage(history, 'assistant', `Error: ${err.message}`);
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
