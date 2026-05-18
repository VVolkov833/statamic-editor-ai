import { createChatSection } from './section-tools-chat.js';
import { buildPageBrief as defaultBuildPageBrief, readPanelState, writePanelState } from './section-tools-lib.js';

const PANEL_ID = 'section-tools-floating-panel';
const PANEL_HANDLE_ID = 'section-tools-floating-panel-handle';
const PANEL_MARGIN = 16;
const MIN_PANEL_WIDTH = 300;
const MIN_PANEL_HEIGHT = 180;
const DEFAULT_WIDTH = 375;
const DEFAULT_HEIGHT = 500;

function createButton(label, onClick) {
  const button = document.createElement('button');

  button.type = 'button';
  button.className = 'btn';
  button.textContent = label;
  button.addEventListener('click', onClick);

  return button;
}

function appendDefaultActionButtons(container, actions) {
  container.appendChild(createButton('undo', actions.onUndo));
  container.appendChild(createButton('Log Page Brief', actions.onLogPageBrief));
  container.appendChild(createButton('Log AI Blueprint', actions.onLogAiBlueprint));
}

function createPanelGroup(actions) {
  const wrapper = document.createElement('div');
  wrapper.style.display = 'flex';
  wrapper.style.gap = '6px';
  wrapper.style.flexWrap = 'wrap';

  appendDefaultActionButtons(wrapper, actions);

  return wrapper;
}

function getClampedPosition(panel, position) {
  const maxX = Math.max(PANEL_MARGIN, window.innerWidth - panel.offsetWidth - PANEL_MARGIN);
  const maxY = Math.max(PANEL_MARGIN, window.innerHeight - panel.offsetHeight - PANEL_MARGIN);

  return {
    x: Math.min(Math.max(PANEL_MARGIN, position.x), maxX),
    y: Math.min(Math.max(PANEL_MARGIN, position.y), maxY),
  };
}

function applyPanelPosition(panel, position) {
  const next = getClampedPosition(panel, position);
  panel.style.left = `${next.x}px`;
  panel.style.top = `${next.y}px`;
  return next;
}

function getDefaultPanelPosition(panel) {
  return getClampedPosition(panel, {
    x: window.innerWidth - panel.offsetWidth - 24,
    y: 88,
  });
}

function makePanelDraggable(panel, handle, panelStorageKey) {
  let pointerId = null;
  let deltaX = 0;
  let deltaY = 0;

  handle.addEventListener('pointerdown', (event) => {
    pointerId = event.pointerId;
    const rect = panel.getBoundingClientRect();
    deltaX = event.clientX - rect.left;
    deltaY = event.clientY - rect.top;
    handle.setPointerCapture(pointerId);
    document.body.style.userSelect = 'none';
  });

  handle.addEventListener('pointermove', (event) => {
    if (event.pointerId !== pointerId) {
      return;
    }

    applyPanelPosition(panel, {
      x: event.clientX - deltaX,
      y: event.clientY - deltaY,
    });
  });

  function finishDrag(event) {
    if (event.pointerId !== pointerId) {
      return;
    }

    pointerId = null;
    document.body.style.userSelect = '';
    writePanelState(panelStorageKey, {
      position: { x: panel.offsetLeft, y: panel.offsetTop },
    });
  }

  handle.addEventListener('pointerup', finishDrag);
  handle.addEventListener('pointercancel', finishDrag);
}

function makePanelResizable(panel, panelStorageKey) {
  const resizeHandle = document.createElement('div');
  resizeHandle.title = 'Resize';
  resizeHandle.style.cssText = [
    'position:absolute',
    'bottom:0',
    'right:0',
    'width:16px',
    'height:16px',
    'cursor:nwse-resize',
    'display:flex',
    'align-items:flex-end',
    'justify-content:flex-end',
    'opacity:0.35',
    'padding:3px',
  ].join(';');
  resizeHandle.innerHTML = `<svg width="9" height="9" viewBox="0 0 9 9" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><circle cx="8" cy="8" r="1.2"/><circle cx="4.5" cy="8" r="1.2"/><circle cx="8" cy="4.5" r="1.2"/><circle cx="1" cy="8" r="1.2"/><circle cx="4.5" cy="4.5" r="1.2"/><circle cx="8" cy="1" r="1.2"/></svg>`;

  let pointerId = null;
  let startX, startY, startW, startH;

  resizeHandle.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    pointerId = e.pointerId;
    startX = e.clientX;
    startY = e.clientY;
    startW = panel.offsetWidth;
    startH = panel.offsetHeight;
    resizeHandle.setPointerCapture(pointerId);
    document.body.style.userSelect = 'none';
  });

  resizeHandle.addEventListener('pointermove', (e) => {
    if (e.pointerId !== pointerId) return;
    const newW = Math.max(MIN_PANEL_WIDTH, startW + (e.clientX - startX));
    const newH = Math.max(MIN_PANEL_HEIGHT, startH + (e.clientY - startY));
    panel.style.width = `${newW}px`;
    panel.style.height = `${newH}px`;
  });

  function finishResize(e) {
    if (e.pointerId !== pointerId) return;
    pointerId = null;
    document.body.style.userSelect = '';
    writePanelState(panelStorageKey, { size: { w: panel.offsetWidth, h: panel.offsetHeight } });
  }

  resizeHandle.addEventListener('pointerup', finishResize);
  resizeHandle.addEventListener('pointercancel', finishResize);

  panel.appendChild(resizeHandle);
}

function showPanel(panel, panelStorageKey) {
  panel.style.display = 'flex';
  writePanelState(panelStorageKey, { hidden: false });
}

function hidePanel(panel, panelStorageKey) {
  panel.style.display = 'none';
  writePanelState(panelStorageKey, { hidden: true });
}

export function togglePanelVisibility(panelStorageKey) {
  const panel = document.getElementById(PANEL_ID);
  if (!panel) return;
  if (panel.style.display === 'none') {
    showPanel(panel, panelStorageKey);
  } else {
    hidePanel(panel, panelStorageKey);
  }
}

function createFloatingPanel(actions, panelStorageKey, getBrief, getBlueprintData) {
  const panel = document.createElement('div');
  panel.id = PANEL_ID;
  panel.style.position = 'fixed';
  panel.style.zIndex = '4';
  panel.style.background = 'var(--bg, #fff)';
  panel.style.border = '1px solid rgba(0, 0, 0, 0.12)';
  panel.style.borderRadius = '10px';
  panel.style.boxShadow = '0 8px 24px rgba(0, 0, 0, 0.16)';
  panel.style.padding = '8px';
  panel.style.minWidth = `${MIN_PANEL_WIDTH}px`;
  panel.style.display = 'flex';
  panel.style.flexDirection = 'column';
  panel.style.gap = '8px';

  // Handle bar: draggable title + close button
  const handle = document.createElement('div');
  handle.id = PANEL_HANDLE_ID;
  handle.style.display = 'flex';
  handle.style.alignItems = 'center';
  handle.style.justifyContent = 'space-between';
  handle.style.cursor = 'move';
  handle.style.padding = '2px 4px';
  handle.style.color = 'var(--text, #111)';
  handle.style.userSelect = 'none';
  handle.style.flexShrink = '0';

  const title = document.createElement('span');
  title.textContent = 'Editor AI Assistant';
  title.style.fontSize = '12px';
  title.style.fontWeight = '600';

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.title = 'Hide panel';
  closeBtn.textContent = '×';
  closeBtn.style.cssText = 'background:none;border:none;cursor:pointer;font-size:20px;line-height:1;padding:0 2px;color:rgba(0,0,0,0.35);margin:0;flex-shrink:0';
  closeBtn.addEventListener('pointerdown', (e) => e.stopPropagation()); // prevent drag
  closeBtn.addEventListener('click', () => hidePanel(panel, panelStorageKey));

  handle.appendChild(title);
  handle.appendChild(closeBtn);

  panel.appendChild(handle);
  panel.appendChild(createChatSection(getBrief ?? (() => defaultBuildPageBrief()), getBlueprintData, panelStorageKey));
  panel.appendChild(createPanelGroup(actions));
  makePanelDraggable(panel, handle, panelStorageKey);
  makePanelResizable(panel, panelStorageKey);

  return panel;
}

function mountFloatingPanel(isInScope, actions, panelStorageKey, getBrief, getBlueprintData) {
  if (!isInScope() || document.getElementById(PANEL_ID)) {
    return;
  }

  const panel = createFloatingPanel(actions, panelStorageKey, getBrief, getBlueprintData);
  document.body.appendChild(panel);

  const state = readPanelState(panelStorageKey);

  // Apply size (saved or default); must happen before position so offsetWidth/Height are correct
  const size = state.size;
  panel.style.width = `${size?.w ?? DEFAULT_WIDTH}px`;
  panel.style.height = `${size?.h ?? DEFAULT_HEIGHT}px`;

  // Apply position (saved or default top-right)
  const savedPosition = state.position;
  const initial = savedPosition ?? getDefaultPanelPosition(panel);
  const applied = applyPanelPosition(panel, initial);
  if (!savedPosition) {
    writePanelState(panelStorageKey, { position: applied });
  }

  // Panel is hidden by default; only shown when the user has explicitly revealed it
  if (state.hidden !== false) {
    panel.style.display = 'none';
  }
}

function unmountFloatingPanelWhenOutOfScope(isInScope) {
  if (isInScope()) {
    return;
  }

  const panel = document.getElementById(PANEL_ID);
  if (panel) {
    panel.remove();
  }
}

export function syncSectionToolsUi(options) {
  const { isInScope, actions, panelStorageKey, getBrief, getBlueprintData } = options;

  mountFloatingPanel(isInScope, actions, panelStorageKey, getBrief, getBlueprintData);
  unmountFloatingPanelWhenOutOfScope(isInScope);
}

export function persistPanelPositionOnResize(panelStorageKey) {
  const panel = document.getElementById(PANEL_ID);
  if (!panel) {
    return;
  }

  const applied = applyPanelPosition(panel, {
    x: panel.offsetLeft,
    y: panel.offsetTop,
  });

  writePanelState(panelStorageKey, { position: applied });
}
