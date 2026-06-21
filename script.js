// ─── State ───────────────────────────────────────────────────
let nextId = 1;
const nodes = {};  // id -> { id, type, x, y, power }
const connections = [];  // [{ fromId, toId }]
let selectedNodeId = null;

// ─── Canvas state ────────────────────────────────────────────
let panX = 0, panY = 0;
let scale = 1;

// ─── DOM refs ────────────────────────────────────────────────
const viewport = document.getElementById('canvasViewport');
const world = document.getElementById('canvasWorld');
const nodesContainer = document.getElementById('nodesContainer');
const connectionsSvg = document.getElementById('connectionsSvg');
const zoomLevelEl = document.getElementById('zoomLevel');
const nodeCountEl = document.getElementById('nodeCount');

const settingsModal = document.getElementById('settingsModal');
const modalHeader = document.getElementById('modalHeader');
const modalTitle = document.getElementById('modalTitle');
const closeModal = document.getElementById('closeModal');
const powerSlider = document.getElementById('powerSlider');
const powerSliderValue = document.getElementById('powerSliderValue');
const infoType = document.getElementById('infoType');
const infoPower = document.getElementById('infoPower');
const infoStatus = document.getElementById('infoStatus');

// ─── Helpers ─────────────────────────────────────────────────
function worldX(screenX) {
  return (screenX - panX) / scale;
}
function worldY(screenY) {
  return (screenY - panY) / scale;
}

function updateWorldTransform() {
  world.style.transform = `translate(${panX}px, ${panY}px) scale(${scale})`;
  zoomLevelEl.textContent = `${Math.round(scale * 100)}%`;
  nodeCountEl.textContent = `${Object.keys(nodes).length} nodes`;
}

// ─── Create a node ───────────────────────────────────────────
function createNode(type, wx, wy, power) {
  const id = nextId++;
  nodes[id] = { id, type, x: wx, y: wy, power: power ?? 10 };

  const el = document.createElement('div');
  el.className = `node ${type}`;
  el.dataset.id = id;
  el.style.left = '0px';
  el.style.top = '0px';

  const symbol = type === 'generator' ? 'G' : 'L';
  const sub = type === 'generator' ? 'Gen' : 'Load';
  el.innerHTML = `
    <span class="symbol">${symbol}</span>
    <span class="sub">${sub}</span>
    <span class="value">${nodes[id].power.toFixed(1)} MW</span>
  `;

  // Drag handling on the node itself
  let dragData = null;
  el.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    dragData = {
      startWx: worldX(e.clientX),
      startWy: worldY(e.clientY),
      nodeX: nodes[id].x,
      nodeY: nodes[id].y,
      moved: false,
      targetId: id,
    };
    el.setPointerCapture(e.pointerId);
  });

  el.addEventListener('pointermove', (e) => {
    if (!dragData) return;
    const cx = worldX(e.clientX), cy = worldY(e.clientY);
    const ddx = cx - dragData.startWx;
    const ddy = cy - dragData.startWy;
    if (Math.abs(ddx) > 2 || Math.abs(ddy) > 2) dragData.moved = true;
    if (!dragData.moved) return;
    nodes[id].x = dragData.nodeX + ddx;
    nodes[id].y = dragData.nodeY + ddy;
    updateNodePosition(id);
    updateConnections();
  });

  el.addEventListener('pointerup', (e) => {
    if (dragData) {
      if (!dragData.moved) {
        // Click — open settings
        selectNode(id);
      }
      dragData = null;
    }
  });

  nodesContainer.appendChild(el);
  updateNodePosition(id);
  updateConnections();
  return id;
}

function updateNodePosition(id) {
  const node = nodes[id];
  const el = nodesContainer.querySelector(`[data-id="${id}"]`);
  if (!el) return;
  el.style.transform = `translate(calc(${node.x}px - 50%), calc(${node.y}px - 50%))`;
}

// ─── Remove a node ───────────────────────────────────────────
function removeNode(id) {
  const el = nodesContainer.querySelector(`[data-id="${id}"]`);
  if (el) el.remove();
  // Remove connections involving this node
  for (let i = connections.length - 1; i >= 0; i--) {
    const c = connections[i];
    if (c.fromId === id || c.toId === id) {
      connections.splice(i, 1);
    }
  }
  delete nodes[id];
  updateConnections();
  nodeCountEl.textContent = `${Object.keys(nodes).length} nodes`;
}

// ─── Connections ─────────────────────────────────────────────
function addConnection(fromId, toId) {
  connections.push({ fromId, toId });
  updateConnections();
}

function updateConnections() {
  // Clear SVG lines
  connectionsSvg.querySelectorAll('.connection-line, .flow-arrow-svg').forEach(el => el.remove());

  for (const c of connections) {
    const from = nodes[c.fromId];
    const to = nodes[c.toId];
    if (!from || !to) continue;

    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', from.x);
    line.setAttribute('y1', from.y);
    line.setAttribute('x2', to.x);
    line.setAttribute('y2', to.y);
    line.setAttribute('class', 'connection-line');
    line.id = `conn-${c.fromId}-${c.toId}`;

    // Determine status color
    const totalLoad = Object.values(nodes).filter(n => n.type === 'load').reduce((s, n) => s + n.power, 0);
    const totalGen = Object.values(nodes).filter(n => n.type === 'generator').reduce((s, n) => s + n.power, 0);
    const ratio = totalGen > 0 ? totalLoad / totalGen : 1;
    if (ratio <= 0.5) line.classList.add('balanced');
    else if (ratio <= 0.8) line.classList.add('moderate');
    else line.classList.add('overloaded');

    connectionsSvg.appendChild(line);

    // Arrow markers (on the to side)
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const len = Math.sqrt(dx*dx + dy*dy);
    if (len < 20) continue;
    const angle = Math.atan2(dy, dx) * 180 / Math.PI;

    // Two flow arrows along the line
    for (const t of [0.35, 0.65]) {
      const ax = from.x + dx * t;
      const ay = from.y + dy * t;
      const arrow = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
      const s = 10;
      arrow.setAttribute('points', `${ax-s},${ay-s/2} ${ax-s},${ay+s/2} ${ax},${ay}`);
      arrow.setAttribute('transform', `rotate(${angle} ${ax} ${ay})`);
      arrow.setAttribute('class', 'flow-arrow-svg');
      arrow.style.fill = '#7a8a9a';
      arrow.style.opacity = '0.6';
      connectionsSvg.appendChild(arrow);
    }
  }
}

// ─── Canvas panning ──────────────────────────────────────────
let panData = null;
viewport.addEventListener('pointerdown', (e) => {
  if (e.target.closest('.node')) return;  // handled by node
  if (e.target.closest('.zoom-controls')) return;
  if (e.target.closest('.action-btn')) return;
  panData = {
    sx: e.clientX, sy: e.clientY,
    px: panX, py: panY,
    moved: false,
  };
  viewport.setPointerCapture(e.pointerId);
});

viewport.addEventListener('pointermove', (e) => {
  if (!panData) return;
  const dx = e.clientX - panData.sx, dy = e.clientY - panData.sy;
  if (Math.abs(dx) > 2 || Math.abs(dy) > 2) panData.moved = true;
  if (!panData.moved) return;
  panX = panData.px + dx;
  panY = panData.py + dy;
  updateWorldTransform();
});

viewport.addEventListener('pointerup', () => { panData = null; });
viewport.addEventListener('pointerleave', () => { panData = null; });

// ─── Zoom ────────────────────────────────────────────────────
viewport.addEventListener('wheel', (e) => {
  e.preventDefault();
  const rect = viewport.getBoundingClientRect();
  const mx = e.clientX - rect.left;
  const my = e.clientY - rect.top;

  const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
  const newScale = Math.min(Math.max(scale * factor, 0.15), 5);

  // Zoom toward cursor
  panX = mx - (mx - panX) * (newScale / scale);
  panY = my - (my - panY) * (newScale / scale);
  scale = newScale;
  updateWorldTransform();
}, { passive: false });

document.getElementById('zoomIn').addEventListener('click', () => {
  const newScale = Math.min(scale * 1.3, 5);
  panX = viewport.clientWidth / 2 - (viewport.clientWidth / 2 - panX) * (newScale / scale);
  panY = viewport.clientHeight / 2 - (viewport.clientHeight / 2 - panY) * (newScale / scale);
  scale = newScale;
  updateWorldTransform();
});

document.getElementById('zoomOut').addEventListener('click', () => {
  const newScale = Math.max(scale / 1.3, 0.15);
  panX = viewport.clientWidth / 2 - (viewport.clientWidth / 2 - panX) * (newScale / scale);
  panY = viewport.clientHeight / 2 - (viewport.clientHeight / 2 - panY) * (newScale / scale);
  scale = newScale;
  updateWorldTransform();
});

document.getElementById('zoomReset').addEventListener('click', () => {
  panX = 0; panY = 0; scale = 1;
  updateWorldTransform();
});

// ─── Modal (settings panel) ──────────────────────────────────
function selectNode(id) {
  selectedNodeId = id;
  const node = nodes[id];
  if (!node) return;
  modalTitle.textContent = `⚙️ ${node.type === 'generator' ? 'Generator' : 'Load'} Settings`;
  infoType.textContent = node.type === 'generator' ? 'Generator' : 'Load';
  powerSlider.value = node.power;
  powerSliderValue.textContent = `${node.power.toFixed(1)} MW`;
  updateModalStatus();
  settingsModal.classList.remove('hidden');
}

function updateModalStatus() {
  if (!selectedNodeId) return;
  const node = nodes[selectedNodeId];
  const totalLoad = Object.values(nodes).filter(n => n.type === 'load').reduce((s, n) => s + n.power, 0);
  const totalGen = Object.values(nodes).filter(n => n.type === 'generator').reduce((s, n) => s + n.power, 0);
  const ratio = totalGen > 0 ? totalLoad / totalGen : 1;
  if (ratio <= 0.5) {
    infoStatus.textContent = '✅ Balanced';
    infoStatus.className = 'status-ok';
  } else if (ratio <= 0.8) {
    infoStatus.textContent = '⚠️ Moderate';
    infoStatus.className = 'status-warn';
  } else {
    infoStatus.textContent = '🔴 Overloaded';
    infoStatus.className = 'status-overload';
  }
  infoPower.textContent = `${node.power.toFixed(1)} MW`;
  // Update the node's displayed value
  const el = nodesContainer.querySelector(`[data-id="${selectedNodeId}"] .value`);
  if (el) el.textContent = `${node.power.toFixed(1)} MW`;
}

powerSlider.addEventListener('input', () => {
  if (!selectedNodeId) return;
  nodes[selectedNodeId].power = parseFloat(powerSlider.value);
  powerSliderValue.textContent = `${nodes[selectedNodeId].power.toFixed(1)} MW`;
  updateModalStatus();
  updateConnections();
});

closeModal.addEventListener('click', () => {
  settingsModal.classList.add('hidden');
  selectedNodeId = null;
});

// Draggable modal
let modalDrag = null;
modalHeader.addEventListener('pointerdown', (e) => {
  modalDrag = {
    sx: e.clientX, sy: e.clientY,
    lx: settingsModal.offsetLeft, ly: settingsModal.offsetTop,
  };
});
document.addEventListener('pointermove', (e) => {
  if (!modalDrag) return;
  settingsModal.style.left = `${modalDrag.lx + e.clientX - modalDrag.sx}px`;
  settingsModal.style.top = `${modalDrag.ly + e.clientY - modalDrag.sy}px`;
  settingsModal.style.right = 'auto';
});
document.addEventListener('pointerup', () => { modalDrag = null; });

// ─── Add / Remove buttons ───────────────────────────────────
document.getElementById('addLoadBtn').addEventListener('click', () => {
  createNode('load', Math.random() * 600 + 200, Math.random() * 400 + 100, 10);
  updateConnections();
});

document.getElementById('addGenBtn').addEventListener('click', () => {
  createNode('generator', Math.random() * 600 + 200, Math.random() * 400 + 100, 10);
  updateConnections();
});

// ─── Save / Load ─────────────────────────────────────────────
document.getElementById('saveBtn').addEventListener('click', () => {
  const data = {
    nodes: Object.values(nodes).map(n => ({ id: n.id, type: n.type, x: Math.round(n.x), y: Math.round(n.y), power: n.power })),
    connections: connections.map(c => ({ fromId: c.fromId, toId: c.toId })),
  };
  const json = JSON.stringify(data, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'power-grid.json';
  a.click();
  URL.revokeObjectURL(url);
});

// ─── Init ────────────────────────────────────────────────────
// Create initial 2-bus system
const genId = createNode('generator', 200, 250, 10);
const loadId = createNode('load', 600, 250, 10);
addConnection(genId, loadId);
updateWorldTransform();
