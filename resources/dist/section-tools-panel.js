const PANEL_ID = 'section-tools-floating-panel';
const PANEL_HANDLE_ID = 'section-tools-floating-panel-handle';
const PANEL_MARGIN = 16;

function createButton(label, onClick) {
  const button = document.createElement('button');

  button.type = 'button';
  button.className = 'btn';
  button.textContent = label;
  button.addEventListener('click', onClick);

  return button;
}

function appendDefaultActionButtons(container, actions) {
  container.appendChild(createButton('Quote +', actions.onQuote));
  container.appendChild(createButton('Swap 2<->3', actions.onSwap));
  container.appendChild(createButton('Clone 3 +1', actions.onClone));
  container.appendChild(createButton('unde', actions.onUndo));
  container.appendChild(createButton('Log §2', actions.onLogSection2));
  container.appendChild(createButton('Log §2 Blueprint', actions.onLogSection2Blueprint));
  container.appendChild(createButton('Log Page Brief', actions.onLogPageBrief));
  container.appendChild(createButton('Search Assets', actions.onSearchAssets));
}

function createPanelGroup(actions) {
  const wrapper = document.createElement('div');
  wrapper.style.display = 'flex';
  wrapper.style.gap = '6px';
  wrapper.style.flexWrap = 'wrap';

  appendDefaultActionButtons(wrapper, actions);

  return wrapper;
}

function readPanelPosition(panelStorageKey) {
  try {
    const raw = window.localStorage.getItem(panelStorageKey);
    if (!raw) {
      return null;
    }

    const parsed = JSON.parse(raw);
    if (typeof parsed?.x !== 'number' || typeof parsed?.y !== 'number') {
      return null;
    }

    return parsed;
  } catch {
    return null;
  }
}

function writePanelPosition(panelStorageKey, position) {
  try {
    window.localStorage.setItem(panelStorageKey, JSON.stringify(position));
  } catch {
    // Ignore storage quota/privacy failures.
  }
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
    writePanelPosition(panelStorageKey, {
      x: panel.offsetLeft,
      y: panel.offsetTop,
    });
  }

  handle.addEventListener('pointerup', finishDrag);
  handle.addEventListener('pointercancel', finishDrag);
}

function createFloatingPanel(actions, panelStorageKey) {
  const panel = document.createElement('div');
  panel.id = PANEL_ID;
  panel.style.position = 'fixed';
  panel.style.zIndex = '2000';
  panel.style.background = 'var(--bg, #fff)';
  panel.style.border = '1px solid rgba(0, 0, 0, 0.12)';
  panel.style.borderRadius = '10px';
  panel.style.boxShadow = '0 8px 24px rgba(0, 0, 0, 0.16)';
  panel.style.padding = '8px';
  panel.style.display = 'flex';
  panel.style.flexDirection = 'column';
  panel.style.gap = '8px';

  const handle = document.createElement('div');
  handle.id = PANEL_HANDLE_ID;
  handle.textContent = 'Editor AI Assistant';
  handle.style.fontSize = '12px';
  handle.style.fontWeight = '600';
  handle.style.cursor = 'move';
  handle.style.padding = '2px 4px';
  handle.style.color = 'var(--text, #111)';

  panel.appendChild(handle);
  panel.appendChild(createPanelGroup(actions));
  makePanelDraggable(panel, handle, panelStorageKey);

  return panel;
}

function mountFloatingPanel(isInScope, actions, panelStorageKey) {
  if (!isInScope() || document.getElementById(PANEL_ID)) {
    return;
  }

  const panel = createFloatingPanel(actions, panelStorageKey);
  document.body.appendChild(panel);

  const savedPosition = readPanelPosition(panelStorageKey);
  const initial = savedPosition ?? getDefaultPanelPosition(panel);
  const applied = applyPanelPosition(panel, initial);

  if (!savedPosition) {
    writePanelPosition(panelStorageKey, applied);
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
  const { isInScope, actions, panelStorageKey } = options;

  mountFloatingPanel(isInScope, actions, panelStorageKey);
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

  writePanelPosition(panelStorageKey, applied);
}
