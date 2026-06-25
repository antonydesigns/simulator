import { state, sim, ISLAND_COLORS, ptr, DRAG_THRESHOLD, canvas, ctx, menu, menuItems, openPanels, dragPanel, dragOff, resizePanel, resizeStart, GRID_SIZE, NODE_RADIUS, JUNCTION_RADIUS } from './js/state.js';
import { startSim, stopSim, restartSim, balanceGrid, recomputeNetworks, findNetworks, demandCurve, computeBoundingBox } from './js/simulation.js';
import { draw, drawFreqChart, drawMeritOrderChart, updateCursor, mouseToWorld, mouseToScreen, worldToScreen, screenToWorld, findNearestLine, hitNode, hitIsland, roundRectCtx } from './js/renderer.js';
import { persist, load, saveSnapshot, uid } from './js/storage.js';
import { openSettings, closeSettings, openLineSettings, updateControls, updateStatsPanel, openBalanceModal } from './js/panels.js';
// ─── Sizing ────────────────────────────────────────────────────────────
function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = window.innerWidth * dpr;
  canvas.height = window.innerHeight * dpr;
  canvas.style.width = window.innerWidth + 'px';
  canvas.style.height = window.innerHeight + 'px';
  draw();
}
// ─── Cursor ────────────────────────────────────────────────────────────
function showMenu(e, nodeHit, simple) {
  e.preventDefault();
  const world = mouseToWorld(e);
  menu.dataset.wx = world.x; menu.dataset.wy = world.y;
  menu.dataset.nodeId = nodeHit ? nodeHit.id : '';
  menu.dataset.connId = '';
  menuItems.innerHTML = '';
  const lineHit = (!nodeHit) ? findNearestLine(world.x, world.y, 15 / state.view.scale) : null;
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
  if (e.key === ' ' || e.code === 'Space') { e.preventDefault(); if (!state.spaceDown) { state.spaceDown = true; updateCursor(); } }
});
document.addEventListener('keyup', (e) => {
  if (e.key === ' ' || e.code === 'Space') { e.preventDefault(); state.spaceDown = false; updateCursor(); }
});
canvas.addEventListener('mousedown', (e) => {
  if (e.button === 2) {
    hideMenu();
    const world = mouseToWorld(e), hit = hitNode(world.x, world.y);
    ptr.downWorld = world;
    ptr.downScreen = mouseToScreen(e);
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
  const world = mouseToWorld(e), screen = mouseToScreen(e), hit = hitNode(world.x, world.y);
  // Check island header hit for dragging
  const islandHit = hit ? null : hitIsland(world.x, world.y);
  if (islandHit && islandHit.isHeader) {
    const net = islandHit.net;
    const origPositions = [...net.nodeIds].map(id => {
      const n = state.nodes.find(nd => nd.id === id);
      return n ? { id: n.id, x: n.x, y: n.y } : null;
    }).filter(Boolean);
    state.islandDrag = { netId: net.id, startWorld: { x: world.x, y: world.y }, origPositions };
    state.selectedNetworkId = net.id;
    if (state.statsPanelVisible) updateStatsPanel();
    draw();
    return;
  }
  ptr.downWorld = world; ptr.downScreen = screen; ptr.downTime = Date.now();
  ptr.downNodeId = hit ? hit.id : null;
  ptr.isDragging = false; ptr.isPanning = false; ptr.isSelecting = false; ptr.moved = false;
  ptr.rightButton = false;
  if (hit) {
    if (e.ctrlKey || e.metaKey) {
      if (state.selectedNodeIds.has(hit.id)) state.selectedNodeIds.delete(hit.id);
      else state.selectedNodeIds.add(hit.id);
      state.selectedConnIds = new Set();
    } else if (!state.selectedNodeIds.has(hit.id)) {
      state.selectedNodeIds = new Set([hit.id]);
      state.selectedConnIds = new Set();
    }
    draw();
  }
});
canvas.addEventListener('mousemove', (e) => {
  const world = mouseToWorld(e), screen = mouseToScreen(e);
  ptr.mouseWorld = world; ptr.mouseScreen = screen;
  // Island header drag
  if (state.islandDrag) {
    const dx = world.x - state.islandDrag.startWorld.x;
    const dy = world.y - state.islandDrag.startWorld.y;
    for (const p of state.islandDrag.origPositions) {
      const n = state.nodes.find(nd => nd.id === p.id);
      if (n) { n.x = p.x + dx; n.y = p.y + dy; }
    }
    const draggedNet = state.networks.find(n => n.id === state.islandDrag.netId);
    if (draggedNet) draggedNet.boundingBox = computeBoundingBox(draggedNet);
    draw(); return;
  }
  // Right-button panning
  if (ptr.rightButton && ptr.downWorld) {
    const d = Math.sqrt(((world.x - ptr.downWorld.x) * state.view.scale)**2 + ((world.y - ptr.downWorld.y) * state.view.scale)**2);
    if (d > DRAG_THRESHOLD) {
      ptr.moved = true;
      ptr.isPanning = true;
      canvas.style.cursor = 'grabbing';
      state.view.x = e.clientX - ptr._panOffsetX;
      state.view.y = e.clientY - ptr._panOffsetY;
      state.hoverLine = null;
      draw();
      return;
    }
  }
  if (ptr.isDragging) {
    const dx = world.x - ptr.downWorld.x, dy = world.y - ptr.downWorld.y;
    for (const id of state.selectedNodeIds) { const n = state.nodes.find(n => n.id === id); if (n) { n.x += dx; n.y += dy; } }
    ptr.downWorld = { x: world.x, y: world.y }; state.hoverLine = null; draw(); updateCursor(e); return;
  }
  if (ptr.isPanning) {
    state.view.x = e.clientX - ptr._panOffsetX; state.view.y = e.clientY - ptr._panOffsetY;
    state.hoverLine = null; draw(); return;
  }
  if (ptr.downWorld && !ptr.rightButton) {
    const d = Math.sqrt(((world.x - ptr.downWorld.x) * state.view.scale)**2 + ((world.y - ptr.downWorld.y) * state.view.scale)**2);
    if (d > DRAG_THRESHOLD) {
      ptr.moved = true;
      if (state.spaceDown) { ptr.isPanning = true; ptr._panOffsetX = e.clientX - state.view.x; ptr._panOffsetY = e.clientY - state.view.y; canvas.style.cursor = 'grabbing'; draw(); return; }
      if (ptr.downNodeId) { ptr.isDragging = true; canvas.style.cursor = 'move'; draw(); return; }
      ptr.isSelecting = true; draw(); return;
    }
  }
  // Detect island hover
  const islandHit = hitIsland(world.x, world.y);
  state.hoveredIslandId = islandHit ? islandHit.net.id : null;
  state.hoveredIslandHeader = islandHit ? islandHit.isHeader : false;
  state.hoverLine = findNearestLine(world.x, world.y, 15 / state.view.scale);
  draw(); updateCursor(e);
});
canvas.addEventListener('mouseup', (e) => {
  // Right-button release
  if (e.button === 2) {
    if (ptr.isPanning) {
      ptr.isPanning = false;
      ptr.rightButton = false;
      ptr.downWorld = null;
      canvas.style.cursor = 'default';
      draw();
      updateCursor(e);
      return;
    }
    ptr.rightButton = false;
    // No movement → show context menu
    const cw = mouseToWorld(e), hit = hitNode(cw.x, cw.y);
    if (hit && hit.type !== 'junction') {
      showMenu(e, hit, true);
    } else if (hit) {
      showMenu(e, hit, false);
    } else {
      const lineHit = findNearestLine(cw.x, cw.y, 15 / state.view.scale);
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
  if (state.islandDrag) {
    state.islandDrag = null;
    recomputeNetworks(); persist(); draw(); return;
  }
  if (ptr.isDragging) { ptr.isDragging = false; ptr.downNodeId = null; ptr.downWorld = null; persist(); draw(); updateCursor(e); return; }
  if (ptr.isPanning) { ptr.isPanning = false; ptr.downWorld = null; draw(); updateCursor(e); return; }
  if (ptr.isSelecting) {
    ptr.isSelecting = false;
    const marquee = computeMarqueeSelection(screenToWorld(ptr.downScreen.x, ptr.downScreen.y), screenToWorld(ptr.mouseScreen.x, ptr.mouseScreen.y));
    state.selectedNodeIds = marquee.nodeIds;
    state.selectedConnIds = marquee.connIds;
    ptr.downWorld = null; draw(); updateCursor(e); return;
  }
  ptr.downWorld = null;
  const cw = mouseToWorld(e), hit = hitNode(cw.x, cw.y), now = Date.now();
  const dbl = hit && hit.id === ptr.lastClickNodeId && (now - ptr.lastClickTime) < 400;
  ptr.lastClickTime = now; ptr.lastClickNodeId = hit ? hit.id : null;
  if (dbl) { onDoubleClickNode(hit); return; }
  const hover = state.hoverLine && findNearestLine(cw.x, cw.y, 15 / state.view.scale);
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
      state.hoverLine = null; draw(); return;
    } else {
      splitConnection(hover.conn, hover.x, hover.y); state.hoverLine = null; return;
    }
  }
  if (!hit) { state.pendingSourceId = null; if (!e.ctrlKey && !e.metaKey) { state.selectedNodeIds = new Set(); state.selectedConnIds = new Set(); } draw(); return; }
  if (state.pendingSourceId) { addConnection(state.pendingSourceId, hit.id); return; }
  if (e.ctrlKey || e.metaKey) {
    if (state.selectedNodeIds.has(hit.id)) state.selectedNodeIds.delete(hit.id);
    else state.selectedNodeIds.add(hit.id);
    state.selectedConnIds = new Set();
  } else {
    state.selectedNodeIds = new Set([hit.id]);
    state.selectedConnIds = new Set();
  }
  draw();
});
function onDoubleClickNode(hit) {
  if (hit.type === 'junction') {
    // Junction: toggle pending connection (old behavior)
    if (state.pendingSourceId === hit.id) { state.pendingSourceId = null; state.selectedNodeIds = new Set(); }
    else { state.pendingSourceId = hit.id; state.selectedNodeIds = new Set([hit.id]); }
    state.selectedConnIds = new Set();
    draw();
  } else {
    // Gen/load/storage: open settings panel
    openSettings(hit.id);
  }
}
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const r = canvas.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top;
  const w = screenToWorld(mx, my), f = e.deltaY < 0 ? 1.08 : 1 / 1.08;
  const ns = Math.max(0.1, Math.min(10, state.view.scale * f));
  state.view.x = mx - w.x * ns; state.view.y = my - w.y * ns; state.view.scale = ns;
  draw();
}, { passive: false });
canvas.addEventListener('mouseleave', () => {
  state.hoveredIslandId = null;
  state.hoveredIslandHeader = false;
  draw();
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
    draw();
  } else if (a === 'add-generator') addNode('generator', wx, wy);
  else if (a === 'add-load') addNode('load', wx, wy);
  else if (a === 'add-storage') addNode('storage', wx, wy);
  else if (a === 'add-junction') addNode('junction', wx, wy);
  else if (a === 'open-settings') openSettings(id);
  else if (a === 'delete-node' && id) deleteNode(id);
  else if (a === 'delete-line' && connId) {
    state.connections = state.connections.filter(c => c.id !== connId);
    recomputeNetworks(); persist(); draw();
  } else if (a === 'line-settings' && connId) {
    openLineSettings(connId);
  } else if (a === 'rename-island' && netId) {
    const net = (state.networks || []).find(n => n.id === netId);
    if (net) {
      const name = prompt('Rename island:', net.customName || net.id);
      if (name && name.trim()) { net.customName = name.trim(); persist(); draw(); }
    }
  }
  hideMenu();
});
document.addEventListener('click', (e) => { if (!menu.contains(e.target)) hideMenu(); });
document.addEventListener('keydown', (e) => {
  const meta = e.ctrlKey || e.metaKey;
  if (e.key === 'Escape') { state.islandDrag = null; state.pendingSourceId = null; state.selectedNodeIds = new Set(); state.selectedConnIds = new Set(); state.hoverLine = null; hideMenu(); draw(); }
  if (e.key === 'j' || e.key === 'J') {
    state.lineMode = state.lineMode === 'junction' ? 'status' : 'junction';
    draw();
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
    recomputeNetworks();
    persist();
    draw();
    return;
  }
  // Ctrl+V — Paste connection between 2 selected nodes
  if (meta && !e.shiftKey && e.key === 'v' && state.lineClipboard && state.selectedNodeIds.size === 2) {
    e.preventDefault();
    const ids = [...state.selectedNodeIds];
    if (!state.connections.some(c => (c.sourceId === ids[0] && c.targetId === ids[1]) || (c.sourceId === ids[1] && c.targetId === ids[0]))) {
      state.connections.push({ id: uid(), sourceId: ids[0], targetId: ids[1], reactance: state.lineClipboard.reactance, thermalLimit: state.lineClipboard.thermalLimit, tripped: false, tripTimer: 0 });
      recomputeNetworks(); persist(); draw();
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
    persist(); draw();
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
    if (targets.length > 0) persist();
    draw();
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
    persist(); draw();
    return;
  }
  if ((e.key === 'Backspace' || e.key === 'Delete') && state.selectedConnIds.size > 0) {
    e.preventDefault();
    state.connections = state.connections.filter(c => !state.selectedConnIds.has(c.id));
    state.selectedConnIds = new Set();
    recomputeNetworks(); persist(); draw();
    return;
  }
  if ((e.key === 'Backspace' || e.key === 'Delete') && state.selectedNodeIds.size > 0) {
    const hadGen = [...state.selectedNodeIds].some(id => state.nodes.find(n => n.id === id)?.type === 'generator');
    for (const id of [...state.selectedNodeIds]) {
      state.nodes = state.nodes.filter(n => n.id !== id);
      state.connections = state.connections.filter(c => c.sourceId !== id && c.targetId !== id);
      if (state.pendingSourceId === id) state.pendingSourceId = null;
      closeSettings(id);
    }
    state.selectedNodeIds = new Set(); state.selectedConnIds = new Set();
    if (hadGen && state.nodes.filter(n => n.type === 'generator').length === 0) state.frequency = 50;
    recomputeNetworks(); persist(); draw();
  }
});
// ─── Init ──────────────────────────────────────────────
async function init() {
  await load();
  balanceGrid();
  resizeCanvas();
  draw();
  updateControls();
  updateStatsPanel();
}
window.addEventListener('resize', resizeCanvas);
init();