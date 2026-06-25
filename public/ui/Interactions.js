// ─── Interactions — node ops, context menu, event listeners ──────

export class Interactions {
  constructor(store, engine, renderer, settingsPanel, persister, controls, statsPanel) {
    this.store = store;
    this.engine = engine;
    this.renderer = renderer;
    this.settingsPanel = settingsPanel;
    this.persister = persister;
    this.controls = controls;
    this.statsPanel = statsPanel;
    this._init();
  }

  _init() {
    const store = this.store, engine = this.engine, renderer = this.renderer;
    const settingsPanel = this.settingsPanel, persister = this.persister;
    const controls = this.controls, statsPanel = this.statsPanel;
    const state = store.state, sim = store.sim, canvas = store.canvas;
    const ptr = store.ptr, menu = store.menu, menuItems = store.menuItems;
    const DRAG_THRESHOLD = store.DRAG_THRESHOLD;

    const uid = () => 'n' + (store._idCounter++).toString(36);

function shortId(type) {
  const prefix = { generator: 'G', load: 'L', storage: 'S', junction: 'J' }[type] || 'N';
  const digits = Math.floor(Math.random() * 900) + 100;
  const letter = String.fromCharCode(65 + Math.floor(Math.random() * 26));
  return `${prefix}-${digits}${letter}`;
}

function addNode(type, wx, wy) {
  let node;
  if (type === 'load') {
    node = { id: uid(), type, x: wx, y: wy, shortId: shortId(type), label: '', mw: 10, baseMw: 10, shedPct: 0, noiseEnabled: false, noiseMin: 100, noiseMax: 200, noisePct: 10 };
  } else if (type === 'generator') {
    node = { id: uid(), type, x: wx, y: wy, shortId: shortId(type), label: '', mw: 0, rating: 100, inertia: 5, droop: 0.04, baselineContract: 0, fcrHeadroom: 10, bidPrice: 50, bidQty: 100, mode: 'balancing', turbineTimeConstant: 1, rampDownTC: 0.3, agcOffset: 0, tripped: false, freqTimer: 0 };
  } else if (type === 'storage') {
    node = { id: uid(), type, x: wx, y: wy, shortId: shortId(type), label: '', mw: 50, chargeRate: 500, dischargeRate: 500, maxCapacity: 100, mode: 'balancing', baselineContract: 0, fcrHeadroom: 10, droop: 0.04, fixedTarget: 0, mwResponse: 0, agcOffset: 0, freqRestore: 0, freqTimer: 0 };
  } else {
    node = { id: uid(), type, x: wx, y: wy, shortId: shortId(type), label: '', mw: 0 };
  }
  state.nodes.push(node);
  state.selectedNodeIds = new Set([node.id]); state.selectedConnIds = new Set();
  engine.recomputeNetworks(); persister.persist(); renderer.draw();
  return node;
}

// ─── Delete Node ───────────────────────────────────────────────────────

function deleteNode(id) {
  const del = state.nodes.find(n => n.id === id);
  state.nodes = state.nodes.filter(n => n.id !== id);
  state.connections = state.connections.filter(c => c.sourceId !== id && c.targetId !== id);
  state.selectedNodeIds.delete(id);
  if (state.pendingSourceId === id) state.pendingSourceId = null;
  settingsPanel.close(id);
  // Reset frequency if last gen removed
  if (del && del.type === 'generator' && state.nodes.filter(n => n.type === 'generator').length === 0) {
    state.frequency = 50;
  }
  persister.persist(); renderer.draw();
}

// ─── Add Connection ────────────────────────────────────────────────────

function addConnection(sourceId, targetId) {
  if (sourceId === targetId) return;
  if (state.connections.some(c => (c.sourceId === sourceId && c.targetId === targetId) || (c.sourceId === targetId && c.targetId === sourceId))) return;
  state.connections.push({ id: uid(), sourceId, targetId, reactance: 0.1, thermalLimit: 100, tripped: false, tripTimer: 0 });
  state.pendingSourceId = null;
  engine.recomputeNetworks(); persister.persist(); renderer.draw();
}

// ─── Split Connection ──────────────────────────────────────────────────

function splitConnection(conn, wx, wy) {
  const j = { id: uid(), type: 'junction', x: wx, y: wy, shortId: shortId('junction'), label: '', mw: 0 };
  state.nodes.push(j);
  state.connections = state.connections.filter(c => c !== conn);
  const halfX = (conn.reactance || 0.1) / 2;
  state.connections.push(
    { id: uid(), sourceId: conn.sourceId, targetId: j.id, reactance: halfX, thermalLimit: conn.thermalLimit || 100, tripped: false, tripTimer: 0 },
    { id: uid(), sourceId: j.id, targetId: conn.targetId, reactance: halfX, thermalLimit: conn.thermalLimit || 100, tripped: false, tripTimer: 0 }
  );
  state.selectedNodeIds = new Set([j.id]); state.selectedConnIds = new Set();
  engine.recomputeNetworks(); persister.persist(); renderer.draw();
}

// ─── Marquee ───────────────────────────────────────────────────────────

function computeMarqueeSelection(w1, w2) {
  const x1 = Math.min(w1.x, w2.x), y1 = Math.min(w1.y, w2.y), x2 = Math.max(w1.x, w2.x), y2 = Math.max(w1.y, w2.y);
  const nodeIds = new Set();
  for (const n of state.nodes) if (n.x >= x1 && n.x <= x2 && n.y >= y1 && n.y <= y2) nodeIds.add(n.id);
  const connIds = new Set();
  for (const c of state.connections) {
    const s = state.nodes.find(n => n.id === c.sourceId);
    const t = state.nodes.find(n => n.id === c.targetId);
    if (s && t && s.x >= x1 && s.x <= x2 && s.y >= y1 && s.y <= y2 && t.x >= x1 && t.x <= x2 && t.y >= y1 && t.y <= y2) connIds.add(c.id);
  }
  return { nodeIds, connIds };
}

// ─── Context Menu ──────────────────────────────────────────────────────

function hitIsland(wx, wy) {
  const nets = state.networks || [];
  // Check from top (last drawn) to bottom
  for (let i = nets.length - 1; i >= 0; i--) {
    if (!nets[i].valid) continue;
    const bb = nets[i].boundingBox;
    if (!bb) continue;
    const headerH = 30;
    // Check if inside header
    if (wx >= bb.x && wx <= bb.x + bb.w && wy >= bb.y && wy <= bb.y + headerH) {
      return { net: nets[i], isHeader: true };
    }
    // Check if inside body
    if (wx >= bb.x && wx <= bb.x + bb.w && wy >= bb.y && wy <= bb.y + bb.h) {
      return { net: nets[i], isHeader: false };
    }
  }
  return null;
}

function showMenu(e, nodeHit, simple) {
  e.preventDefault();
  const world = renderer.mouseToWorld(e);
  menu.dataset.wx = world.x; menu.dataset.wy = world.y;
  menu.dataset.nodeId = nodeHit ? nodeHit.id : '';
  menu.dataset.connId = '';
  menuItems.innerHTML = '';

  const lineHit = (!nodeHit) ? renderer.findNearestLine(world.x, world.y, 15 / state.view.scale) : null;
  const islandHit = (nodeHit || lineHit) ? null : hitIsland(world.x, world.y);

  if (nodeHit && nodeHit.type !== 'junction') {
    if (simple) {
      addMenuItem('New connection', 'new-connection');
      addMenuSeparator();
      addMenuItem('Delete', 'delete-node');
    } else {
      addMenuItem('Open settings', 'open-settings');
      addMenuSeparator();
      addMenuItem('Delete', 'delete-node');
    }
  } else if (nodeHit) {
    addMenuItem('Delete', 'delete-node');
  } else if (lineHit) {
    menu.dataset.connId = lineHit.conn.id;
    addMenuItem('Line settings', 'line-settings');
    addMenuSeparator();
    addMenuItem('Delete line', 'delete-line');
  } else if (islandHit) {
    menu.dataset.netId = islandHit.net.id;
    addMenuItem('+ Generator', 'add-generator');
    addMenuItem('+ Load', 'add-load');
    addMenuItem('+ Storage', 'add-storage');
    addMenuSeparator();
    addMenuItem('+ Junction', 'add-junction');
    addMenuSeparator();
    addMenuItem('Rename island', 'rename-island');
  } else {
    addMenuItem('+ Generator', 'add-generator');
    addMenuItem('+ Load', 'add-load');
    addMenuItem('+ Storage', 'add-storage');
    addMenuSeparator();
    addMenuItem('+ Junction', 'add-junction');
  }

  const h = menuItems.children.length * 36 + 8;
  let mx = e.clientX, my = e.clientY;
  if (mx + 160 > window.innerWidth) mx = window.innerWidth - 168;
  if (my + h > window.innerHeight) my = window.innerHeight - h - 8;
  menu.style.left = mx + 'px'; menu.style.top = my + 'px';
  menu.classList.remove('hidden');
}

function addMenuItem(text, action) { const d = document.createElement('div'); d.className = 'context-menu-item'; d.dataset.action = action; d.textContent = text; menuItems.appendChild(d); }
function addMenuSeparator() { const d = document.createElement('div'); d.className = 'context-menu-separator'; menuItems.appendChild(d); }
function hideMenu() { menu.classList.add('hidden'); }

// ─── Events ────────────────────────────────────────────────────────────

document.addEventListener('contextmenu', (e) => { e.preventDefault(); });

document.addEventListener('keydown', (e) => {
  if (e.key === ' ' || e.code === 'Space') { e.preventDefault(); if (!state.spaceDown) { state.spaceDown = true; renderer.updateCursor(); } }
});
document.addEventListener('keyup', (e) => {
  if (e.key === ' ' || e.code === 'Space') { e.preventDefault(); state.spaceDown = false; renderer.updateCursor(); }
});

canvas.addEventListener('mousedown', (e) => {
  if (e.button === 2) {
    hideMenu();
    const world = renderer.mouseToWorld(e), hit = renderer.hitNode(world.x, world.y);
    ptr.downWorld = world;
    ptr.downScreen = renderer.mouseToScreen(e);
    ptr.downTime = Date.now();
    ptr.rightButton = true;
    ptr.isPanning = false;
    ptr.isDragging = false;
    ptr.moved = false;
    ptr._panOffsetX = e.clientX - state.view.x;
    ptr._panOffsetY = e.clientY - state.view.y;
    ptr.downNodeId = hit ? hit.id : null;
    ptr.downNodeType = hit ? hit.type : null;
    return;
  }
  if (e.button !== 0) return;
  hideMenu();
  const world = renderer.mouseToWorld(e), screen = renderer.mouseToScreen(e), hit = renderer.hitNode(world.x, world.y);

  // Check island header hit for dragging
  const islandHit = hit ? null : hitIsland(world.x, world.y);
  if (islandHit && islandHit.isHeader) {
    const net = islandHit.net;
    const origPositions = [...net.nodeIds].map(id => {
      const n = state.nodes.find(nd => nd.id === id);
      return n ? { id: n.id, x: n.x, y: n.y } : null;
    }).filter(Boolean);
    store.islandDrag = { netId: net.id, startWorld: { x: world.x, y: world.y }, origPositions };
    store.selectedNetworkId = net.id;
    if (store.statsPanelVisible) statsPanel.update();
    renderer.draw();
    return;
  }

  ptr.downWorld = world; ptr.downScreen = screen; ptr.downTime = Date.now();
  ptr.downNodeId = hit ? hit.id : null;
  ptr.isDragging = false; ptr.isPanning = false; ptr.isSelecting = false; ptr.moved = false;
  ptr.rightButton = false;
  if (hit) {
    if (e.ctrlKey || e.metaKey) {
      if (renderer.isSelected(hit)) state.selectedNodeIds.delete(hit.id);
      else state.selectedNodeIds.add(hit.id);
      state.selectedConnIds = new Set();
    } else if (!renderer.isSelected(hit)) {
      state.selectedNodeIds = new Set([hit.id]);
      state.selectedConnIds = new Set();
    }
    renderer.draw();
  }
});

canvas.addEventListener('mousemove', (e) => {
  const world = renderer.mouseToWorld(e), screen = renderer.mouseToScreen(e);
  ptr.mouseWorld = world; ptr.mouseScreen = screen;

  // Island header drag
  if (store.islandDrag) {
    const dx = world.x - store.islandDrag.startWorld.x;
    const dy = world.y - store.islandDrag.startWorld.y;
    for (const p of store.islandDrag.origPositions) {
      const n = state.nodes.find(nd => nd.id === p.id);
      if (n) { n.x = p.x + dx; n.y = p.y + dy; }
    }
    // Recompute bounding box so the box follows in real-time
    const draggedNet = state.networks.find(n => n.id === store.islandDrag.netId);
    if (draggedNet) draggedNet.boundingBox = engine.computeBoundingBox(draggedNet);
    renderer.draw(); return;
  }

  // Right-button panning
  if (ptr.rightButton && ptr.downWorld) {
    const d = Math.sqrt(((world.x - ptr.downWorld.x) * state.view.scale)**2 + ((world.y - ptr.downWorld.y) * state.view.scale)**2);
    if (d > store.DRAG_THRESHOLD) {
      ptr.moved = true;
      ptr.isPanning = true;
      canvas.style.cursor = 'grabbing';
      state.view.x = e.clientX - ptr._panOffsetX;
      state.view.y = e.clientY - ptr._panOffsetY;
      state.hoverLine = null;
      renderer.draw();
      return;
    }
  }

  if (ptr.isDragging) {
    const dx = world.x - ptr.downWorld.x, dy = world.y - ptr.downWorld.y;
    for (const id of state.selectedNodeIds) { const n = state.nodes.find(n => n.id === id); if (n) { n.x += dx; n.y += dy; } }
    ptr.downWorld = { x: world.x, y: world.y }; state.hoverLine = null; renderer.draw(); renderer.updateCursor(e); return;
  }
  if (ptr.isPanning) {
    state.view.x = e.clientX - ptr._panOffsetX; state.view.y = e.clientY - ptr._panOffsetY;
    state.hoverLine = null; renderer.draw(); return;
  }

  if (ptr.downWorld && !ptr.rightButton) {
    const d = Math.sqrt(((world.x - ptr.downWorld.x) * state.view.scale)**2 + ((world.y - ptr.downWorld.y) * state.view.scale)**2);
    if (d > store.DRAG_THRESHOLD) {
      ptr.moved = true;
      if (state.spaceDown) { ptr.isPanning = true; ptr._panOffsetX = e.clientX - state.view.x; ptr._panOffsetY = e.clientY - state.view.y; canvas.style.cursor = 'grabbing'; renderer.draw(); return; }
      if (ptr.downNodeId) { ptr.isDragging = true; canvas.style.cursor = 'move'; renderer.draw(); return; }
      ptr.isSelecting = true; renderer.draw(); return;
    }
  }

  // Detect island hover
  const islandHit = hitIsland(world.x, world.y);
  store.selectedNetworkId = islandHit ? islandHit.net.id : null;
  store.hoveredIslandHeader = islandHit ? islandHit.isHeader : false;

  state.hoverLine = renderer.findNearestLine(world.x, world.y, 15 / state.view.scale);
  renderer.draw(); renderer.updateCursor(e);
});

canvas.addEventListener('mouseup', (e) => {
  // Right-button release
  if (e.button === 2) {
    if (ptr.isPanning) {
      ptr.isPanning = false;
      ptr.rightButton = false;
      ptr.downWorld = null;
      canvas.style.cursor = 'default';
      renderer.draw();
      renderer.updateCursor(e);
      return;
    }
    ptr.rightButton = false;
    // No movement → show context menu
    const cw = renderer.mouseToWorld(e), hit = renderer.hitNode(cw.x, cw.y);
    if (hit && hit.type !== 'junction') {
      showMenu(e, hit, true);
    } else if (hit) {
      showMenu(e, hit, false);
    } else {
      const lineHit = renderer.findNearestLine(cw.x, cw.y, 15 / state.view.scale);
      if (lineHit) {
        showMenu(e, null, false); // shows line menu
      } else {
        showMenu(e, null, false); // shows add-node menu
      }
    }
    ptr.downWorld = null;
    return;
  }
  if (e.button !== 0) return;
  if (store.islandDrag) {
    store.islandDrag = null;
    engine.recomputeNetworks(); persister.persist(); renderer.draw(); return;
  }
  if (ptr.isDragging) { ptr.isDragging = false; ptr.downNodeId = null; ptr.downWorld = null; persister.persist(); renderer.draw(); renderer.updateCursor(e); return; }
  if (ptr.isPanning) { ptr.isPanning = false; ptr.downWorld = null; renderer.draw(); renderer.updateCursor(e); return; }
  if (ptr.isSelecting) {
    ptr.isSelecting = false;
    const marquee = computeMarqueeSelection(renderer.screenToWorld(ptr.downScreen.x, ptr.downScreen.y), renderer.screenToWorld(ptr.mouseScreen.x, ptr.mouseScreen.y));
    state.selectedNodeIds = marquee.nodeIds;
    state.selectedConnIds = marquee.connIds;
    ptr.downWorld = null; renderer.draw(); renderer.updateCursor(e); return;
  }

  ptr.downWorld = null;
  const cw = renderer.mouseToWorld(e), hit = renderer.hitNode(cw.x, cw.y), now = Date.now();
  const dbl = hit && hit.id === ptr.lastClickNodeId && (now - ptr.lastClickTime) < 400;
  ptr.lastClickTime = now; ptr.lastClickNodeId = hit ? hit.id : null;
  if (dbl) { onDoubleClickNode(hit); return; }

  const hover = state.hoverLine && renderer.findNearestLine(cw.x, cw.y, 15 / state.view.scale);
  if (hover) {
    state.hoverLine = hover;
    if (state.lineMode === 'status') {
      // Toggle line selection
      if (e.ctrlKey || e.metaKey || e.shiftKey) {
        if (state.selectedConnIds.has(hover.conn.id)) state.selectedConnIds.delete(hover.conn.id);
        else state.selectedConnIds.add(hover.conn.id);
      } else {
        state.selectedConnIds = new Set([hover.conn.id]);
        state.selectedNodeIds = new Set();
      }
      state.hoverLine = null; renderer.draw(); return;
    } else {
      splitConnection(hover.conn, hover.x, hover.y); state.hoverLine = null; return;
    }
  }
  if (!hit) { state.pendingSourceId = null; if (!e.ctrlKey && !e.metaKey) { state.selectedNodeIds = new Set(); state.selectedConnIds = new Set(); } renderer.draw(); return; }
  if (state.pendingSourceId) { addConnection(state.pendingSourceId, hit.id); return; }
  if (e.ctrlKey || e.metaKey) {
    if (state.selectedNodeIds.has(hit.id)) state.selectedNodeIds.delete(hit.id);
    else state.selectedNodeIds.add(hit.id);
    state.selectedConnIds = new Set();
  } else {
    state.selectedNodeIds = new Set([hit.id]);
    state.selectedConnIds = new Set();
  }
  renderer.draw();
});

function onDoubleClickNode(hit) {
  if (hit.type === 'junction') {
    // Junction: toggle pending connection (old behavior)
    if (state.pendingSourceId === hit.id) { state.pendingSourceId = null; state.selectedNodeIds = new Set(); }
    else { state.pendingSourceId = hit.id; state.selectedNodeIds = new Set([hit.id]); }
    state.selectedConnIds = new Set();
    renderer.draw();
  } else {
    // Gen/load/storage: open settings panel
    settingsPanel.open(hit.id);
  }
}

canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const r = canvas.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top;
  const w = renderer.screenToWorld(mx, my), f = e.deltaY < 0 ? 1.08 : 1 / 1.08;
  const ns = Math.max(0.1, Math.min(10, state.view.scale * f));
  state.view.x = mx - w.x * ns; state.view.y = my - w.y * ns; state.view.scale = ns;
  renderer.draw();
}, { passive: false });

canvas.addEventListener('mouseleave', () => {
  store.selectedNetworkId = null;
  store.hoveredIslandHeader = false;
  renderer.draw();
});

menu.addEventListener('click', (e) => {
  const item = e.target.closest('.context-menu-item');
  if (!item) return;
  const a = item.dataset.action, wx = parseFloat(menu.dataset.wx), wy = parseFloat(menu.dataset.wy), id = menu.dataset.nodeId;
  const netId = menu.dataset.netId;
  const connId = menu.dataset.connId;
  if (a === 'new-connection' && id) {
    state.pendingSourceId = id;
    state.selectedNodeIds = new Set([id]);
    state.selectedConnIds = new Set();
    renderer.draw();
  } else if (a === 'add-generator') addNode('generator', wx, wy);
  else if (a === 'add-load') addNode('load', wx, wy);
  else if (a === 'add-storage') addNode('storage', wx, wy);
  else if (a === 'add-junction') addNode('junction', wx, wy);
  else if (a === 'open-settings') settingsPanel.open(id);
  else if (a === 'delete-node' && id) deleteNode(id);
  else if (a === 'delete-line' && connId) {
    state.connections = state.connections.filter(c => c.id !== connId);
    engine.recomputeNetworks(); persister.persist(); renderer.draw();
  } else if (a === 'line-settings' && connId) {
    settingsPanel.openLine(connId);
  } else if (a === 'rename-island' && netId) {
    const net = (state.networks || []).find(n => n.id === netId);
    if (net) {
      const name = prompt('Rename island:', net.customName || net.id);
      if (name && name.trim()) { net.customName = name.trim(); persister.persist(); renderer.draw(); }
    }
  }
  hideMenu();
});

document.addEventListener('click', (e) => { if (!menu.contains(e.target)) hideMenu(); });

document.addEventListener('keydown', (e) => {
  const meta = e.ctrlKey || e.metaKey;

  if (e.key === 'Escape') { store.islandDrag = null; state.pendingSourceId = null; state.selectedNodeIds = new Set(); state.selectedConnIds = new Set(); state.hoverLine = null; hideMenu(); renderer.draw(); }

  if (e.key === 'j' || e.key === 'J') {
    state.lineMode = state.lineMode === 'junction' ? 'status' : 'junction';
    renderer.draw();
  }

  // Ctrl+C — Copy selected connections (only when no nodes selected)
  if (meta && e.key === 'c' && state.selectedConnIds.size > 0 && state.selectedNodeIds.size === 0) {
    e.preventDefault();
    const copied = state.connections.filter(c => state.selectedConnIds.has(c.id)).map(c => ({ ...c }));
    state.clipboard = { connections: copied };
    state.lineClipboard = copied[0] ? { reactance: copied[0].reactance, thermalLimit: copied[0].thermalLimit } : null;
    return;
  }

  // Ctrl+C — Copy selected nodes
  if (meta && e.key === 'c' && state.selectedNodeIds.size > 0) {
    e.preventDefault();
    const ids = state.selectedNodeIds;
    const copiedNodes = state.nodes.filter(n => ids.has(n.id)).map(n => ({ ...n }));
    const copiedIds = new Set(copiedNodes.map(n => n.id));
    const copiedConns = state.connections.filter(c => copiedIds.has(c.sourceId) && copiedIds.has(c.targetId)).map(c => ({ ...c }));
    state.clipboard = { nodes: copiedNodes, connections: copiedConns };
    state.lineClipboard = copiedConns[0] ? { reactance: copiedConns[0].reactance, thermalLimit: copiedConns[0].thermalLimit } : null;
    return;
  }

  // Ctrl+V — Paste copied nodes (duplicate them at offset)
  if (meta && !e.shiftKey && e.key === 'v' && state.clipboard && state.clipboard.nodes && state.clipboard.nodes.length > 0) {
    e.preventDefault();
    const offset = 40;
    const idMap = {};
    const newNodes = [];
    for (const n of state.clipboard.nodes) {
      const newId = uid();
      idMap[n.id] = newId;
      const newNode = JSON.parse(JSON.stringify(n));
      newNode.id = newId;
      newNode.x = n.x + offset;
      newNode.y = n.y + offset;
      newNode.shortId = shortId(n.type);
      newNode.label = '';
      newNodes.push(newNode);
    }
    state.nodes.push(...newNodes);
    for (const c of (state.clipboard.connections || [])) {
      if (idMap[c.sourceId] && idMap[c.targetId]) {
        state.connections.push({
          id: uid(),
          sourceId: idMap[c.sourceId],
          targetId: idMap[c.targetId],
          reactance: c.reactance,
          thermalLimit: c.thermalLimit,
          tripped: false,
          tripTimer: 0
        });
      }
    }
    state.selectedNodeIds = new Set(newNodes.map(n => n.id));
    state.selectedConnIds = new Set();
    engine.recomputeNetworks();
    persister.persist();
    renderer.draw();
    return;
  }

  // Ctrl+V — Paste connection between 2 selected nodes
  if (meta && !e.shiftKey && e.key === 'v' && state.lineClipboard && state.selectedNodeIds.size === 2) {
    e.preventDefault();
    const ids = [...state.selectedNodeIds];
    if (!state.connections.some(c => (c.sourceId === ids[0] && c.targetId === ids[1]) || (c.sourceId === ids[1] && c.targetId === ids[0]))) {
      state.connections.push({ id: uid(), sourceId: ids[0], targetId: ids[1], reactance: state.lineClipboard.reactance, thermalLimit: state.lineClipboard.thermalLimit, tripped: false, tripTimer: 0 });
      engine.recomputeNetworks(); persister.persist(); renderer.draw();
    }
    return;
  }

  // Ctrl+Shift+V — Paste settings onto selected connections
  if (meta && e.shiftKey && e.key === 'V' && state.lineClipboard && state.selectedConnIds.size > 0) {
    e.preventDefault();
    for (const c of state.connections) {
      if (state.selectedConnIds.has(c.id)) {
        c.reactance = state.lineClipboard.reactance;
        c.thermalLimit = state.lineClipboard.thermalLimit;
      }
    }
    persister.persist(); renderer.draw();
    return;
  }

  // Ctrl+Shift+V — Paste properties onto matching selected nodes
  if (meta && e.shiftKey && e.key === 'V' && state.clipboard && state.clipboard.nodes && state.clipboard.nodes.length === 1 && state.selectedNodeIds.size > 0) {
    e.preventDefault();
    const src = state.clipboard.nodes[0];
    const targets = state.nodes.filter(n => state.selectedNodeIds.has(n.id) && n.type === src.type && n.id !== src.id);
    for (const t of targets) {
      if (src.type === 'generator') {
        t.rating = src.rating; t.inertia = src.inertia; t.droop = src.droop;
        t.fcrHeadroom = src.fcrHeadroom; t.bidPrice = src.bidPrice; t.bidQty = src.bidQty;
        t.mode = src.mode; t.turbineTimeConstant = src.turbineTimeConstant; t.rampDownTC = src.rampDownTC;
        t.baselineContract = src.baselineContract;
      } else if (src.type === 'storage') {
        t.chargeRate = src.chargeRate; t.dischargeRate = src.dischargeRate;
        t.maxCapacity = src.maxCapacity; t.mode = src.mode;
        t.fcrHeadroom = src.fcrHeadroom; t.droop = src.droop; t.fixedTarget = src.fixedTarget;
      } else if (src.type === 'load') {
        t.mw = src.mw;
        t.baseMw = src.mw || 10;
        t.shedPct = 0;
      }
    }
    if (targets.length > 0) persister.persist();
    renderer.draw();
    return;
  }

  // Ctrl+V — Paste nodes from clipboard
  if (meta && !e.shiftKey && e.key === 'v' && state.clipboard && state.clipboard.nodes.length > 0) {
    e.preventDefault();
    const idMap = {};
    const pasted = [];
    for (const n of state.clipboard.nodes) {
      const oldId = n.id;
      const newId = uid();
      idMap[oldId] = newId;
      const offset = 30;
      const fresh = { ...n, id: newId, x: n.x + offset, y: n.y + offset, shortId: shortId(n.type), label: '' };
      if (fresh.type === 'generator') { fresh.tripped = false; fresh.freqTimer = 0; }
      if (fresh.type === 'load') { fresh.shedPct = 0; fresh.baseMw = fresh.mw || 10; }
      if (fresh.type === 'storage') { fresh.mwResponse = 0; fresh.agcOffset = 0; }
      pasted.push(fresh);
    }
    state.nodes.push(...pasted);
    for (const c of state.clipboard.connections) {
      state.connections.push({ id: uid(), sourceId: idMap[c.sourceId], targetId: idMap[c.targetId], reactance: c.reactance || 0.1, thermalLimit: c.thermalLimit || 100, tripped: false, tripTimer: 0 });
    }
    state.selectedNodeIds = new Set(pasted.map(n => n.id)); state.selectedConnIds = new Set();
    persister.persist(); renderer.draw();
    return;
  }

  if ((e.key === 'Backspace' || e.key === 'Delete') && state.selectedConnIds.size > 0) {
    e.preventDefault();
    state.connections = state.connections.filter(c => !state.selectedConnIds.has(c.id));
    state.selectedConnIds = new Set();
    engine.recomputeNetworks(); persister.persist(); renderer.draw();
    return;
  }

  if ((e.key === 'Backspace' || e.key === 'Delete') && state.selectedNodeIds.size > 0) {
    const hadGen = [...state.selectedNodeIds].some(id => state.nodes.find(n => n.id === id)?.type === 'generator');
    for (const id of [...state.selectedNodeIds]) {
      state.nodes = state.nodes.filter(n => n.id !== id);
      state.connections = state.connections.filter(c => c.sourceId !== id && c.targetId !== id);
      if (state.pendingSourceId === id) state.pendingSourceId = null;
      settingsPanel.close(id);
    }
    state.selectedNodeIds = new Set(); state.selectedConnIds = new Set();
    if (hadGen && state.nodes.filter(n => n.type === 'generator').length === 0) state.frequency = 50;
    engine.recomputeNetworks(); persister.persist(); renderer.draw();
  }
});

// ─── Init ──────────────────────────────────────────────


  }
}
