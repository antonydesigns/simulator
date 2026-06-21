// ─── State ────────────────────────────────────────────────────────────

const state = {
  nodes: [],
  connections: [],
  selectedNodeIds: new Set(),
  pendingSourceId: null,
  hoverLine: null,       // { x, y, conn } — closest point on a line
  view: { x: 0, y: 0, scale: 1 },
  spaceDown: false,
};

// ─── Pointer state (not persisted) ────────────────────────────────────

const ptr = {
  downWorld: null,       // world coords at last mousedown
  downScreen: null,      // screen coords at mousedown (for selection rect)
  downTime: 0,
  downNodeId: null,      // node hit on mousedown
  dragOffset: { x: 0, y: 0 },
  isDragging: false,     // dragging node(s)
  isPanning: false,      // spacebar + drag
  isSelecting: false,    // marquee selection
  _panOffsetX: 0,
  _panOffsetY: 0,
  lastClickTime: 0,      // for synthetic double-click
  lastClickNodeId: null,
  mouseWorld: null,      // current mouse position in world coords
  mouseScreen: null,     // current mouse position in screen coords
  moved: false,          // whether mouse moved since mousedown (beyond threshold)
};

const DRAG_THRESHOLD = 4; // screen px before drag/pan/select starts

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
  draw();
}

// ─── Coordinate Transforms ─────────────────────────────────────────────

function screenToWorld(sx, sy) {
  return {
    x: (sx - state.view.x) / state.view.scale,
    y: (sy - state.view.y) / state.view.scale,
  };
}

function worldToScreen(wx, wy) {
  return {
    x: wx * state.view.scale + state.view.x,
    y: wy * state.view.scale + state.view.y,
  };
}

function mouseToWorld(e) {
  const rect = canvas.getBoundingClientRect();
  return screenToWorld(e.clientX - rect.left, e.clientY - rect.top);
}

function mouseToScreen(e) {
  const rect = canvas.getBoundingClientRect();
  return { x: e.clientX - rect.left, y: e.clientY - rect.top };
}

// ─── Drawing ───────────────────────────────────────────────────────────

const GRID_SIZE = 40;
const NODE_RADIUS = 14;
const JUNCTION_RADIUS = 4;

function nodeRadius(node) {
  return node.type === 'junction' ? JUNCTION_RADIUS : NODE_RADIUS;
}

function isSelected(node) {
  return state.selectedNodeIds.has(node.id);
}

function drawGrid() {
  const v = state.view;
  const w = window.innerWidth;
  const h = window.innerHeight;

  const topLeft = screenToWorld(0, 0);
  const bottomRight = screenToWorld(w, h);

  const startX = Math.floor(topLeft.x / GRID_SIZE) * GRID_SIZE;
  const startY = Math.floor(topLeft.y / GRID_SIZE) * GRID_SIZE;
  const endX = bottomRight.x;
  const endY = bottomRight.y;

  ctx.strokeStyle = '#ddd8ce';
  ctx.lineWidth = 1;

  for (let wx = startX; wx <= endX; wx += GRID_SIZE) {
    const sx = wx * v.scale + v.x;
    ctx.beginPath();
    ctx.moveTo(sx, 0);
    ctx.lineTo(sx, h);
    ctx.stroke();
  }
  for (let wy = startY; wy <= endY; wy += GRID_SIZE) {
    const sy = wy * v.scale + v.y;
    ctx.beginPath();
    ctx.moveTo(0, sy);
    ctx.lineTo(w, sy);
    ctx.stroke();
  }
}

function drawConnections() {
  for (const conn of state.connections) {
    const source = state.nodes.find(n => n.id === conn.sourceId);
    const target = state.nodes.find(n => n.id === conn.targetId);
    if (!source || !target) continue;

    const s = worldToScreen(source.x, source.y);
    const t = worldToScreen(target.x, target.y);

    ctx.beginPath();
    ctx.strokeStyle = '#7a766e';
    ctx.lineWidth = 2;
    ctx.moveTo(s.x, s.y);
    ctx.lineTo(t.x, t.y);
    ctx.stroke();
  }
}

function drawNodes() {
  const v = state.view;

  for (const node of state.nodes) {
    const p = worldToScreen(node.x, node.y);
    const baseR = nodeRadius(node);
    const r = baseR * v.scale;
    const sel = isSelected(node);
    const isPending = node.id === state.pendingSourceId;

    // Glow for pending source
    if (isPending) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, r + 8, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(122, 158, 192, 0.10)';
      ctx.fill();
    }

    // Node circle
    const fillColor = node.type === 'generator' ? '#6aaa64'
                    : node.type === 'junction' ? '#b0aca2'
                    : '#ca9440';
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fillStyle = fillColor;
    ctx.fill();
    ctx.strokeStyle = sel || isPending ? '#7a9ec0' : '#8a867e';
    ctx.lineWidth = (sel || isPending) ? 3 : 1.5;
    ctx.stroke();

    // Label
    const labelSize = Math.max(10, 11 * v.scale);
    ctx.fillStyle = '#6a665e';
    ctx.font = `${labelSize}px -apple-system, BlinkMacSystemFont, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';

    let label;
    if (node.type === 'generator') label = 'G';
    else if (node.type === 'junction') label = 'J';
    else label = 'L';
    label += (node.label || node.id.slice(-3));
    ctx.fillText(label, p.x, p.y + r + 4);
  }
}

function drawPendingLine() {
  if (!state.pendingSourceId || !ptr.mouseWorld) return;
  const source = state.nodes.find(n => n.id === state.pendingSourceId);
  if (!source) return;

  const s = worldToScreen(source.x, source.y);
  const m = worldToScreen(ptr.mouseWorld.x, ptr.mouseWorld.y);

  ctx.beginPath();
  ctx.setLineDash([6, 4]);
  ctx.strokeStyle = '#7a9ec0';
  ctx.lineWidth = 2;
  ctx.moveTo(s.x, s.y);
  ctx.lineTo(m.x, m.y);
  ctx.stroke();
  ctx.setLineDash([]);
}

function drawHoverDot() {
  if (!state.hoverLine) return;
  const p = worldToScreen(state.hoverLine.x, state.hoverLine.y);
  const r = JUNCTION_RADIUS * state.view.scale;

  ctx.beginPath();
  ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(160, 156, 148, 0.4)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(160, 156, 148, 0.5)';
  ctx.lineWidth = 1.5;
  ctx.stroke();
}

function drawSelectionRect() {
  if (!ptr.isSelecting || !ptr.downScreen || !ptr.mouseScreen) return;

  const x1 = ptr.downScreen.x;
  const y1 = ptr.downScreen.y;
  const x2 = ptr.mouseScreen.x;
  const y2 = ptr.mouseScreen.y;

  const left = Math.min(x1, x2);
  const top = Math.min(y1, y2);
  const w = Math.abs(x2 - x1);
  const h = Math.abs(y2 - y1);

  ctx.beginPath();
  ctx.rect(left, top, w, h);
  ctx.setLineDash([6, 4]);
  ctx.strokeStyle = '#7a9ec0';
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.fillStyle = 'rgba(122, 158, 192, 0.06)';
  ctx.fillRect(left, top, w, h);
}

function draw() {
  const dpr = window.devicePixelRatio || 1;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);

  drawGrid();
  drawConnections();
  drawNodes();
  drawPendingLine();
  drawHoverDot();
  drawSelectionRect();
}

// ─── Cursor ────────────────────────────────────────────────────────────

function updateCursor(e) {
  if (state.spaceDown) {
    canvas.style.cursor = ptr.isPanning ? 'grabbing' : 'grab';
    return;
  }

  if (ptr.isDragging) {
    canvas.style.cursor = 'move';
    return;
  }

  if (e) {
    const world = mouseToWorld(e);
    const hit = hitNode(world.x, world.y);
    if (hit && isSelected(hit)) {
      canvas.style.cursor = 'move';
      return;
    }
  }

  canvas.style.cursor = 'crosshair';
}

// ─── Geometry Helpers ──────────────────────────────────────────────────

function pointToSegmentDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) {
    const ex = px - ax, ey = py - ay;
    return { dist: Math.sqrt(ex * ex + ey * ey), cx: ax, cy: ay };
  }
  let t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  const ex = px - cx, ey = py - cy;
  return { dist: Math.sqrt(ex * ex + ey * ey), cx, cy };
}

function findNearestLine(wx, wy, threshold) {
  let best = null;
  let bestDist = threshold;

  for (const conn of state.connections) {
    const src = state.nodes.find(n => n.id === conn.sourceId);
    const tgt = state.nodes.find(n => n.id === conn.targetId);
    if (!src || !tgt) continue;

    const result = pointToSegmentDist(wx, wy, src.x, src.y, tgt.x, tgt.y);
    if (result.dist < bestDist) {
      const distToSrc = Math.sqrt((result.cx - src.x) ** 2 + (result.cy - src.y) ** 2);
      const distToTgt = Math.sqrt((result.cx - tgt.x) ** 2 + (result.cy - tgt.y) ** 2);
      const srcMargin = nodeRadius(src) + 4;
      const tgtMargin = nodeRadius(tgt) + 4;
      if (distToSrc > srcMargin && distToTgt > tgtMargin) {
        bestDist = result.dist;
        best = { x: result.cx, y: result.cy, conn };
      }
    }
  }
  return best;
}

// ─── Node Hit Testing ──────────────────────────────────────────────────

function hitNode(wx, wy) {
  for (let i = state.nodes.length - 1; i >= 0; i--) {
    const n = state.nodes[i];
    const dx = wx - n.x;
    const dy = wy - n.y;
    const r = nodeRadius(n) + 4;
    if (dx * dx + dy * dy <= r * r) {
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

function addNode(type, wx, wy) {
  const node = { id: uid(), type, x: wx, y: wy, label: '' };
  state.nodes.push(node);
  state.selectedNodeIds = new Set([node.id]);
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
  state.selectedNodeIds.delete(id);
  if (state.pendingSourceId === id) state.pendingSourceId = null;
  persist();
  draw();
}

// ─── Add Connection ────────────────────────────────────────────────────

function addConnection(sourceId, targetId) {
  if (sourceId === targetId) return;
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

// ─── Split a Connection at a Point (create junction) ───────────────────

function splitConnection(conn, wx, wy) {
  const junction = { id: uid(), type: 'junction', x: wx, y: wy, label: '' };
  state.nodes.push(junction);

  state.connections = state.connections.filter(c => c !== conn);
  state.connections.push({ sourceId: conn.sourceId, targetId: junction.id });
  state.connections.push({ sourceId: junction.id, targetId: conn.targetId });

  state.selectedNodeIds = new Set([junction.id]);
  persist();
  draw();
}

// ─── Compute marquee selection (world coords) ─────────────────────────

function computeMarqueeSelection(w1, w2) {
  const x1 = Math.min(w1.x, w2.x);
  const y1 = Math.min(w1.y, w2.y);
  const x2 = Math.max(w1.x, w2.x);
  const y2 = Math.max(w1.y, w2.y);

  const ids = new Set();
  for (const node of state.nodes) {
    if (node.x >= x1 && node.x <= x2 && node.y >= y1 && node.y <= y2) {
      ids.add(node.id);
    }
  }
  return ids;
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
    state.selectedNodeIds = new Set();
  } catch (e) {
    console.error('Failed to load:', e);
  }
}

// ─── Context Menu ──────────────────────────────────────────────────────

function showMenu(e) {
  e.preventDefault();
  const world = mouseToWorld(e);

  menu.dataset.wx = world.x;
  menu.dataset.wy = world.y;

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

// --- Right-click ---
canvas.addEventListener('contextmenu', (e) => {
  showMenu(e);
});

// --- Keyboard: space down/up ---
document.addEventListener('keydown', (e) => {
  if (e.key === ' ' || e.code === 'Space') {
    e.preventDefault();
    if (!state.spaceDown) {
      state.spaceDown = true;
      updateCursor();
    }
  }
});

document.addEventListener('keyup', (e) => {
  if (e.key === ' ' || e.code === 'Space') {
    e.preventDefault();
    state.spaceDown = false;
    updateCursor();
  }
});

// --- Mouse down ---
canvas.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  hideMenu();

  const world = mouseToWorld(e);
  const screen = mouseToScreen(e);
  const hit = hitNode(world.x, world.y);

  ptr.downWorld = world;
  ptr.downScreen = screen;
  ptr.downTime = Date.now();
  ptr.downNodeId = hit ? hit.id : null;
  ptr.isDragging = false;
  ptr.isPanning = false;
  ptr.isSelecting = false;
  ptr.moved = false;

  if (hit) {
    // If the clicked node isn't selected, clear selection and select just this one
    if (!isSelected(hit)) {
      state.selectedNodeIds = new Set([hit.id]);
      draw();
    }
  }
});

// --- Mouse move ---
canvas.addEventListener('mousemove', (e) => {
  const world = mouseToWorld(e);
  const screen = mouseToScreen(e);
  ptr.mouseWorld = world;
  ptr.mouseScreen = screen;

  // --- Dragging selected node(s) ---
  if (ptr.isDragging) {
    const dx = world.x - ptr.downWorld.x;
    const dy = world.y - ptr.downWorld.y;
    for (const id of state.selectedNodeIds) {
      const node = state.nodes.find(n => n.id === id);
      if (node) {
        node.x += dx;
        node.y += dy;
      }
    }
    ptr.downWorld = { x: world.x, y: world.y };
    state.hoverLine = null;
    draw();
    updateCursor(e);
    return;
  }

  // --- Panning (spacebar held) ---
  if (ptr.isPanning) {
    state.view.x = e.clientX - ptr._panOffsetX;
    state.view.y = e.clientY - ptr._panOffsetY;
    state.hoverLine = null;
    draw();
    return;
  }

  // --- Check if we should start dragging, panning, or selecting ---
  if (ptr.downWorld) {
    const dx = (world.x - ptr.downWorld.x) * state.view.scale;
    const dy = (world.y - ptr.downWorld.y) * state.view.scale;
    const moved = Math.sqrt(dx * dx + dy * dy);

    if (moved > DRAG_THRESHOLD) {
      ptr.moved = true;

      if (state.spaceDown) {
        // Spacebar + drag → pan
        ptr.isPanning = true;
        ptr._panOffsetX = e.clientX - state.view.x;
        ptr._panOffsetY = e.clientY - state.view.y;
        canvas.style.cursor = 'grabbing';
        draw();
        return;
      }

      if (ptr.downNodeId) {
        // Drag on a node → move all selected nodes
        ptr.isDragging = true;
        ptr.dragOffset = { x: world.x - ptr.downWorld.x, y: world.y - ptr.downWorld.y };
        canvas.style.cursor = 'move';
        draw();
        return;
      }

      // Drag on empty space → marquee select
      ptr.isSelecting = true;
      draw();
      return;
    }
  }

  // --- Line hover (only when not dragging/panning/selecting) ---
  const threshold = 15 / state.view.scale;
  state.hoverLine = findNearestLine(world.x, world.y, threshold);
  draw();
  updateCursor(e);
});

// --- Mouse up ---
canvas.addEventListener('mouseup', (e) => {
  if (e.button !== 0) return;

  // Stop dragging → persist
  if (ptr.isDragging) {
    ptr.isDragging = false;
    ptr.downNodeId = null;
    ptr.downWorld = null;
    persist();
    draw();
    updateCursor(e);
    return;
  }

  // Stop panning
  if (ptr.isPanning) {
    ptr.isPanning = false;
    ptr.downWorld = null;
    draw();
    updateCursor(e);
    return;
  }

  // Stop selecting → compute marquee
  if (ptr.isSelecting) {
    ptr.isSelecting = false;
    const w1 = screenToWorld(ptr.downScreen.x, ptr.downScreen.y);
    const w2 = screenToWorld(ptr.mouseScreen.x, ptr.mouseScreen.y);
    state.selectedNodeIds = computeMarqueeSelection(w1, w2);
    ptr.downWorld = null;
    draw();
    updateCursor(e);
    return;
  }

  ptr.downWorld = null;

  // --- It was a click (no drag) → process ---
  const clickWorld = mouseToWorld(e);
  const hit = hitNode(clickWorld.x, clickWorld.y);
  const now = Date.now();

  // --- Double-click detection (synthetic) ---
  const isDblClick = hit && hit.id === ptr.lastClickNodeId && (now - ptr.lastClickTime) < 400;

  ptr.lastClickTime = now;
  ptr.lastClickNodeId = hit ? hit.id : null;

  if (isDblClick) {
    onDoubleClickNode(hit);
    return;
  }

  // --- Single click ---

  // Re-check line hover at click position
  const threshold = 15 / state.view.scale;
  const clickHover = state.hoverLine && findNearestLine(clickWorld.x, clickWorld.y, threshold);

  // Click on a line hover → split line
  if (clickHover) {
    state.hoverLine = clickHover;
    splitConnection(state.hoverLine.conn, state.hoverLine.x, state.hoverLine.y);
    state.hoverLine = null;
    return;
  }

  // Click on empty space → cancel pending source + clear selection
  if (!hit) {
    state.pendingSourceId = null;
    state.selectedNodeIds = new Set();
    draw();
    return;
  }

  // Click on a node while a pending source exists → connect
  if (state.pendingSourceId) {
    addConnection(state.pendingSourceId, hit.id);
    return;
  }

  // Single click on a node with no pending source → select it (clear others)
  state.selectedNodeIds = new Set([hit.id]);
  draw();
});

function onDoubleClickNode(hit) {
  if (state.pendingSourceId === hit.id) {
    // Deselect
    state.pendingSourceId = null;
    state.selectedNodeIds = new Set();
  } else {
    // Select node and enter pending connection mode
    state.pendingSourceId = hit.id;
    state.selectedNodeIds = new Set([hit.id]);
  }
  draw();
}

// --- Wheel (zoom) ---
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();

  const rect = canvas.getBoundingClientRect();
  const mx = e.clientX - rect.left;
  const my = e.clientY - rect.top;

  const world = screenToWorld(mx, my);

  const zoomFactor = e.deltaY < 0 ? 1.08 : 1 / 1.08;
  const newScale = Math.max(0.1, Math.min(10, state.view.scale * zoomFactor));

  state.view.x = mx - world.x * newScale;
  state.view.y = my - world.y * newScale;
  state.view.scale = newScale;

  draw();
}, { passive: false });

// --- Menu actions ---
document.querySelectorAll('.context-menu-item').forEach(item => {
  item.addEventListener('click', () => {
    const action = item.dataset.action;
    const wx = parseFloat(menu.dataset.wx);
    const wy = parseFloat(menu.dataset.wy);

    if (action === 'add-generator') {
      addNode('generator', wx, wy);
    } else if (action === 'add-load') {
      addNode('load', wx, wy);
    } else if (action === 'add-junction') {
      addNode('junction', wx, wy);
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

// --- Keyboard shortcuts ---
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    state.pendingSourceId = null;
    state.selectedNodeIds = new Set();
    state.hoverLine = null;
    hideMenu();
    draw();
  }
  if ((e.key === 'Backspace' || e.key === 'Delete') && state.selectedNodeIds.size > 0) {
    // Delete all selected nodes
    const ids = [...state.selectedNodeIds];
    for (const id of ids) {
      state.nodes = state.nodes.filter(n => n.id !== id);
      state.connections = state.connections.filter(
        c => c.sourceId !== id && c.targetId !== id
      );
      if (state.pendingSourceId === id) state.pendingSourceId = null;
    }
    state.selectedNodeIds = new Set();
    persist();
    draw();
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
