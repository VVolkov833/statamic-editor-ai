let messages = [];
let totalInputTokens = 0;
let totalOutputTokens = 0;

function getXsrfToken() {
  const match = document.cookie.match(/(?:^|;\s*)XSRF-TOKEN=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : '';
}

async function sendToClaude(allMessages) {
  const response = await fetch('/cp/section-tools/ai/chat', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-XSRF-TOKEN': getXsrfToken(),
    },
    body: JSON.stringify({ messages: allMessages }),
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
}

function updateTokenDisplay(tokenEl) {
  tokenEl.textContent = `↑${totalInputTokens} ↓${totalOutputTokens} tokens`;
}

export function createChatSection() {
  const section = document.createElement('div');
  section.style.display = 'flex';
  section.style.flexDirection = 'column';
  section.style.gap = '5px';
  section.style.paddingBottom = '8px';
  section.style.borderBottom = '1px solid rgba(0,0,0,0.1)';

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

    try {
      const data = await sendToClaude(messages);
      const reply = data.content?.[0]?.text ?? '[no response]';
      messages.push({ role: 'assistant', content: reply });
      appendMessage(history, 'assistant', reply);

      totalInputTokens += data.usage?.input_tokens ?? 0;
      totalOutputTokens += data.usage?.output_tokens ?? 0;
      updateTokenDisplay(tokenInfo);
    } catch (err) {
      appendMessage(history, 'assistant', `Error: ${err.message}`);
      messages.pop();
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
