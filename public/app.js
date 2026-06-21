// ─── State ────────────────────────────────────────────────────────────

const state = {
  nodes: [],
  connections: [],
  selectedNodeId: null,
  pendingSourceId: null, // generator node awaiting a load connection
  dragNodeId: null,
  dragOffset: { x: 0, y: 0 },
};

// ─── DOM Refs ──────────────────────────────────────────────────────────

const canvas = document.getElementById('grid-canvas');
const ctx = canvas.getContext('2d');
const menu = document.getElementById('context-menu');

// ─── Sizing ────────────────────────────────────────────────────────────

function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const w = window.innerWidth;
  const h = window.innerHeight;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  canvas.style.width = w + 'px';
  canvas.style.height = h + 'px';
  ctx.scale(dpr, dpr);
  draw();
}

// ─── Grid Coords ───────────────────────────────────────────────────────

function mouseToCanvas(e) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: e.clientX - rect.left,
    y: e.clientY - rect.top,
  };
}

// ─── Drawing ───────────────────────────────────────────────────────────

const GRID_SIZE = 40;

function drawGrid() {
  const w = window.innerWidth;
  const h = window.innerHeight;

  ctx.strokeStyle = '#e8e8e8';
  ctx.lineWidth = 1;

  for (let x = 0; x <= w; x += GRID_SIZE) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.stroke();
  }
  for (let y = 0; y <= h; y += GRID_SIZE) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
  }
}

function drawConnections() {
  for (const conn of state.connections) {
    const source = state.nodes.find(n => n.id === conn.sourceId);
    const target = state.nodes.find(n => n.id === conn.targetId);
    if (!source || !target) continue;

    ctx.beginPath();
    ctx.strokeStyle = '#555';
    ctx.lineWidth = 2;
    ctx.moveTo(source.x, source.y);
    ctx.lineTo(target.x, target.y);
    ctx.stroke();
  }
}

function drawNodes() {
  for (const node of state.nodes) {
    const isSelected = node.id === state.selectedNodeId;
    const isPending = node.id === state.pendingSourceId;

    // Shadow for selected/pending
    if (isPending) {
      ctx.beginPath();
      ctx.arc(node.x, node.y, 20, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(0, 120, 255, 0.12)';
      ctx.fill();
    }

    // Node circle
    ctx.beginPath();
    ctx.arc(node.x, node.y, 14, 0, Math.PI * 2);
    ctx.fillStyle = node.type === 'generator' ? '#2ecc71' : '#f39c12';
    ctx.fill();
    ctx.strokeStyle = isSelected ? '#0078ff' : (isPending ? '#0078ff' : '#333');
    ctx.lineWidth = isSelected || isPending ? 3 : 1.5;
    ctx.stroke();

    // Label
    ctx.fillStyle = '#111';
    ctx.font = '11px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const label = node.type === 'generator' ? 'G' : 'L';
    ctx.fillText(label + (node.label || node.id.slice(-3)), node.x, node.y + 18);
  }
}

function drawPendingLine() {
  if (!state.pendingSourceId) return;
  const source = state.nodes.find(n => n.id === state.pendingSourceId);
  if (!source || !state._mousePos) return;

  ctx.beginPath();
  ctx.setLineDash([6, 4]);
  ctx.strokeStyle = '#0078ff';
  ctx.lineWidth = 2;
  ctx.moveTo(source.x, source.y);
  ctx.lineTo(state._mousePos.x, state._mousePos.y);
  ctx.stroke();
  ctx.setLineDash([]);
}

function draw() {
  ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
  drawGrid();
  drawConnections();
  drawNodes();
  drawPendingLine();
}

// ─── Node Hit Testing ──────────────────────────────────────────────────

function hitNode(x, y) {
  // Check in reverse so topmost (last drawn) is hit first
  for (let i = state.nodes.length - 1; i >= 0; i--) {
    const n = state.nodes[i];
    const dx = x - n.x;
    const dy = y - n.y;
    if (dx * dx + dy * dy <= 18 * 18) {
      return n;
    }
  }
  return null;
}

// ─── ID Generation ─────────────────────────────────────────────────────

let idCounter = Date.now();
function uid() {
  return 'n' + (idCounter++).toString(36);
}

// ─── Add Node ──────────────────────────────────────────────────────────

function addNode(type, x, y) {
  const node = {
    id: uid(),
    type,
    x,
    y,
    label: '',
  };
  state.nodes.push(node);
  state.selectedNodeId = node.id;
  persist();
  draw();
  return node;
}

// ─── Delete Node ───────────────────────────────────────────────────────

function deleteNode(id) {
  state.nodes = state.nodes.filter(n => n.id !== id);
  state.connections = state.connections.filter(
    c => c.sourceId !== id && c.targetId !== id
  );
  if (state.selectedNodeId === id) state.selectedNodeId = null;
  if (state.pendingSourceId === id) state.pendingSourceId = null;
  persist();
  draw();
}

// ─── Add Connection ────────────────────────────────────────────────────

function addConnection(sourceId, targetId) {
  // Don't duplicate
  const exists = state.connections.some(
    c => (c.sourceId === sourceId && c.targetId === targetId) ||
         (c.sourceId === targetId && c.targetId === sourceId)
  );
  if (exists) return;

  state.connections.push({ sourceId, targetId });
  state.pendingSourceId = null;
  persist();
  draw();
}

// ─── Persistence ───────────────────────────────────────────────────────

async function persist() {
  try {
    await fetch('/api/grid', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        nodes: state.nodes,
        connections: state.connections,
      }),
    });
  } catch (e) {
    console.error('Failed to persist:', e);
  }
}

async function load() {
  try {
    const res = await fetch('/api/grid');
    const data = await res.json();
    state.nodes = data.nodes || [];
    state.connections = data.connections || [];
  } catch (e) {
    console.error('Failed to load:', e);
  }
}

// ─── Context Menu ──────────────────────────────────────────────────────

function showMenu(e) {
  e.preventDefault();
  const pos = mouseToCanvas(e);

  // Store position for menu actions
  menu.dataset.x = pos.x;
  menu.dataset.y = pos.y;

  // Position menu within viewport
  const menuW = 160;
  const menuH = 80;
  let mx = e.clientX;
  let my = e.clientY;
  if (mx + menuW > window.innerWidth) mx = window.innerWidth - menuW - 8;
  if (my + menuH > window.innerHeight) my = window.innerHeight - menuH - 8;

  menu.style.left = mx + 'px';
  menu.style.top = my + 'px';
  menu.classList.remove('hidden');
}

function hideMenu() {
  menu.classList.add('hidden');
}

// ─── Event Handlers ────────────────────────────────────────────────────

canvas.addEventListener('contextmenu', (e) => {
  const pos = mouseToCanvas(e);
  const hit = hitNode(pos.x, pos.y);

  if (hit) {
    // Right-click on a node: show delete option
    // For now, just delete on right-click (double-check: we'll add to menu later)
    // Actually let's keep it simple: right-click on node deletes it
    deleteNode(hit.id);
    hideMenu();
    return;
  }

  showMenu(e);
});

canvas.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return; // left click only
  hideMenu();

  const pos = mouseToCanvas(e);
  const hit = hitNode(pos.x, pos.y);

  if (hit) {
    // Start dragging
    state.dragNodeId = hit.id;
    state.dragOffset = { x: pos.x - hit.x, y: pos.y - hit.y };
    return;
  }

  // Click on empty space → deselect
  state.selectedNodeId = null;
  draw();
});

canvas.addEventListener('mousemove', (e) => {
  const pos = mouseToCanvas(e);
  state._mousePos = pos;

  // Dragging
  if (state.dragNodeId) {
    const node = state.nodes.find(n => n.id === state.dragNodeId);
    if (node) {
      node.x = pos.x - state.dragOffset.x;
      node.y = pos.y - state.dragOffset.y;
      draw();
    }
    return;
  }

  // Update pending line
  if (state.pendingSourceId) {
    draw();
  }
});

canvas.addEventListener('mouseup', (e) => {
  if (e.button !== 0) return;

  const pos = mouseToCanvas(e);

  if (state.dragNodeId) {
    // Finished dragging — persist new positions
    state.dragNodeId = null;
    persist();
    draw();
    return;
  }
});

canvas.addEventListener('click', (e) => {
  hideMenu();
  const pos = mouseToCanvas(e);
  const hit = hitNode(pos.x, pos.y);

  if (!hit) {
    state.pendingSourceId = null;
    state.selectedNodeId = null;
    draw();
    return;
  }

  // Clicked on a node
  if (hit.type === 'generator') {
    // Clicking a generator starts a pending connection
    if (state.pendingSourceId === hit.id) {
      // Deselect
      state.pendingSourceId = null;
    } else {
      state.pendingSourceId = hit.id;
    }
    state.selectedNodeId = hit.id;
    draw();
  } else if (hit.type === 'load') {
    if (state.pendingSourceId) {
      // Complete the connection
      addConnection(state.pendingSourceId, hit.id);
      state.selectedNodeId = null;
    } else {
      state.selectedNodeId = hit.id;
      draw();
    }
  }
});

// Menu action handlers
document.querySelectorAll('.context-menu-item').forEach(item => {
  item.addEventListener('click', () => {
    const action = item.dataset.action;
    const x = parseFloat(menu.dataset.x);
    const y = parseFloat(menu.dataset.y);

    if (action === 'add-generator') {
      addNode('generator', x, y);
    } else if (action === 'add-load') {
      addNode('load', x, y);
    }

    hideMenu();
  });
});

// Hide menu on any click outside
document.addEventListener('click', (e) => {
  if (!menu.contains(e.target)) {
    hideMenu();
  }
});

// Keyboard shortcuts
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    state.pendingSourceId = null;
    state.selectedNodeId = null;
    hideMenu();
    draw();
  }
  if ((e.key === 'Backspace' || e.key === 'Delete') && state.selectedNodeId) {
    deleteNode(state.selectedNodeId);
  }
});

// ─── Init ──────────────────────────────────────────────────────────────

async function init() {
  await load();
  resizeCanvas();
  draw();
}

window.addEventListener('resize', resizeCanvas);
init();
