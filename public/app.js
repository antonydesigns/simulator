// ─── State ────────────────────────────────────────────────────────────

const state = {
  nodes: [],
  connections: [],
  selectedNodeIds: new Set(),
  pendingSourceId: null,
  hoverLine: null,
  view: { x: 0, y: 0, scale: 1 },
  spaceDown: false,
  frequency: 50,
};

// ─── Simulation ───────────────────────────────────────────────────────

const sim = {
  running: false,
  interval: null,
  tickHz: 10,
  dataBuffer: [],
  captureAccum: 0,
};

function simTick() {
  const gens = state.nodes.filter(n => n.type === 'generator');
  const loads = state.nodes.filter(n => n.type === 'load');
  const storages = state.nodes.filter(n => n.type === 'storage');

  if (gens.length === 0) return;
  if (loads.length === 0 && storages.length === 0) return;

  const dt = 1 / sim.tickHz;
  const f0 = 50;

  // --- Step 1: Governor droop (instant primary response) ---
  // Merchant-locked gens: fixed output, no frequency response.
  // Balancing gens: mw = baseSetpoint + govMod
  // govMod = -(1/droop) × ((f-f0)/f0) × rating  (+ when low freq, - when high)
  // Both are capped at rating — a 100 MVA gen cannot output 150 MW.
  for (const gen of gens) {
    const maxMw = gen.rating || Infinity;
    if (gen.merchantLock) {
      gen.mw = Math.min(gen.dispatchTarget || gen._baseSetpoint || 0, maxMw);
    } else {
      const droop = gen.droop || 0.04;
      const rating = gen.rating || 100;
      const base = gen._baseSetpoint || 0;
      const dev = (state.frequency - f0) / f0;
      const govMod = -(1 / droop) * dev * rating;
      gen.mw = Math.min(Math.max(0, base + govMod), maxMw);
    }
  }

  const totalGen = gens.reduce((s, g) => s + (g.mw || 0), 0);
  const totalLoad = loads.reduce((s, l) => s + (l.mw || 0), 0);

  // --- Step 2: Storage acts before frequency (it's part of the grid) ---
  // Charging = consuming power, discharging = supplying power
  let netStorage = 0; // + when discharging (supplying grid), - when charging (consuming)
  let surplus = totalGen - totalLoad;

  if (storages.length > 0 && Math.abs(surplus) > 0.001) {
    for (const st of storages) {
      if (surplus > 0) {
        const rate = (st.chargeRate || 5);
        const maxC = rate * dt;
        const capLeft = (st.maxCapacity || 100) - (st.mw || 0);
        const a = Math.min(maxC, surplus, capLeft);
        if (a > 0.001) { st.mw = (st.mw || 0) + a; surplus -= a; netStorage -= a; }
      } else {
        const rate = (st.dischargeRate || 5);
        const maxD = rate * dt;
        const avail = st.mw || 0;
        const need = -surplus;
        const a = Math.min(maxD, need, avail);
        if (a > 0.001) { st.mw = (st.mw || 0) - a; surplus += a; netStorage += a; }
      }
    }
  }

  // --- Step 3: Frequency from FULL grid balance (gens + storage - loads) ---
  const imbalance = totalGen + netStorage - totalLoad;

  let totalInertiaEnergy = 0;
  for (const gen of gens) totalInertiaEnergy += (gen.inertia || 5) * (gen.rating || 100);

  let dfdt = 0;
  if (totalInertiaEnergy > 0) dfdt = (imbalance * f0) / (2 * totalInertiaEnergy);
  state.frequency += dfdt * dt;
  state.frequency = Math.max(45, Math.min(55, state.frequency));

  let changed = true;

  // --- Step 4: Ramp base setpoint toward dispatch target ---
  // Each gen ramps toward its user-set dispatchTarget, not toward load share.
  // The governor + frequency deviation provide the fast balancing on top.
  // Merchant-locked gens skip this — their output is fixed.
  for (const gen of gens) {
    if (gen.merchantLock) continue;
    const base = gen._baseSetpoint || 0;
    const target = gen.dispatchTarget || 0;
    const diff = target - base;
    const maxDelta = (gen.rampRate || 5) * dt;
    const delta = Math.max(-maxDelta, Math.min(maxDelta, diff));
    if (Math.abs(delta) > 0.001) {
      gen._baseSetpoint = Math.max(0, base + delta);
      changed = true;
    }
  }

  // --- Step 4a: AGC (aFRR) — secondary frequency control ---
  // Ramps dispatchTargets of balancing gens to relieve FCR headroom
  // and converge frequency toward 50 Hz. Rate-limited to the ramp rate
  // so dispatchTarget never outruns what the gen can physically follow.
  // Merchant-locked gens are excluded — their output is fixed.
  {
    const freqErr = f0 - state.frequency;
    const balancingGens = gens.filter(g => !g.merchantLock);
    if (balancingGens.length > 0 && Math.abs(freqErr) > 0.0001) {
      const rampRate = (balancingGens[0].rampRate || 5);
      const maxAgcDelta = rampRate * dt;  // can't change faster than ramp
      const totalBalRating = balancingGens.reduce((s, g) => s + (g.rating || 100), 0);
      const agcUnclamped = 50 * freqErr * dt;
      const agcTotal = Math.max(-maxAgcDelta, Math.min(maxAgcDelta, agcUnclamped));
      if (Math.abs(agcTotal) > 0.0001) {
        for (const gen of balancingGens) {
          const share = (gen.rating || 100) / totalBalRating;
          gen.dispatchTarget = Math.round(Math.min(Math.max(0, gen.dispatchTarget + agcTotal * share), gen.rating || Infinity) * 1000) / 1000;
          changed = true;
        }
      }
    }
  }

  // --- Step 5: Update open settings panels ---
  for (const nodeId of Object.keys(openPanels)) {
    const gen = state.nodes.find(n => n.id === nodeId && n.type === 'generator');
    if (gen) {
      const entry = openPanels[nodeId];
      if (entry.outputEl) entry.outputEl.textContent = Math.round(gen.mw || 0) + ' MW';
      if (entry.dispatchSlider && entry.dispatchVal) {
        const d = gen.dispatchTarget || 0;
        if (d > parseInt(entry.dispatchSlider.max)) entry.dispatchSlider.max = d;
        entry.dispatchSlider.value = d;
        entry.dispatchVal.textContent = d.toFixed(1);
      }
    }
    const st = state.nodes.find(n => n.id === nodeId && n.type === 'storage');
    if (st) {
      const entry = openPanels[nodeId];
      if (entry.socEl) entry.socEl.textContent = Math.round(st.mw || 0) + ' MWh';
    }
  }

  // --- Step 5a: Update FCR / aFRR status badges ---
  {
    const fcrBadge = document.getElementById('fcr-badge');
    const afrrBadge = document.getElementById('afrr-badge');
    const balancingGens = gens.filter(g => !g.merchantLock);
    const fcrActive = balancingGens.some(g => Math.abs(g.mw - g._baseSetpoint) > 0.5);
    fcrBadge.className = 'status-badge ' + (fcrActive ? 'fcr-active' : 'fcr-inactive');
    const afrrActive = Math.abs(f0 - state.frequency) > 0.001 && balancingGens.length > 0;
    afrrBadge.className = 'status-badge ' + (afrrActive ? 'afrr-active' : 'afrr-inactive');
  }

  // --- Step 6: Time-series capture at 1/4 s intervals ---
  sim.captureAccum += dt;
  if (sim.captureAccum >= 0.25) {
    sim.captureAccum -= 0.25;
    const entry = { t: sim.dataBuffer.length * 0.25, frequency: state.frequency, nodes: {} };
    for (const node of state.nodes) {
      entry.nodes[node.id] = { type: node.type, mw: node.mw || 0 };
      if (node.type === 'generator') {
        entry.nodes[node.id].dispatchTarget = node.dispatchTarget || 0;
        entry.nodes[node.id]._baseSetpoint = node._baseSetpoint || 0;
        entry.nodes[node.id].merchantLock = !!node.merchantLock;
        entry.nodes[node.id].rating = node.rating || 100;
        entry.nodes[node.id].droop = node.droop || 0.04;
      }
    }
    sim.dataBuffer.push(entry);
  }

  if (changed) draw();
}

function startSim() {
  if (sim.running) return;
  sim.running = true;
  sim.interval = setInterval(simTick, 1000 / sim.tickHz);
}

function stopSim() {
  sim.running = false;
  if (sim.interval) { clearInterval(sim.interval); sim.interval = null; }
}

function restartSim() {
  stopSim();
  sim.dataBuffer = [];
  sim.captureAccum = 0;
  for (const gen of state.nodes.filter(n => n.type === 'generator')) {
    gen._baseSetpoint = gen.dispatchTarget || 0;
    gen.mw = gen._baseSetpoint;
  }
  state.frequency = 50;
  draw();
  updateControls();
}

async function saveSnapshot() {
  const snapshot = {
    savedAt: Date.now(),
    tickHz: sim.tickHz,
    captureInterval: 0.25,
    timeseries: sim.dataBuffer,
  };
  try {
    const res = await fetch('/api/save-snapshot', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(snapshot),
    });
    const data = await res.json();
    if (data.ok) {
      const btn = document.getElementById('save-data-btn');
      const orig = btn.textContent;
      btn.textContent = '✅ ' + data.filename;
      btn.disabled = true;
      setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 2000);
    }
  } catch (e) {
    console.error('Save failed:', e);
  }
}

// ─── Pointer state ────────────────────────────────────────────────────

const ptr = {
  downWorld: null, downScreen: null, downTime: 0, downNodeId: null,
  dragOffset: { x: 0, y: 0 }, isDragging: false, isPanning: false, isSelecting: false,
  _panOffsetX: 0, _panOffsetY: 0, lastClickTime: 0, lastClickNodeId: null,
  mouseWorld: null, mouseScreen: null, moved: false,
};

const DRAG_THRESHOLD = 4;

// ─── DOM Refs ──────────────────────────────────────────────────────────

const canvas = document.getElementById('grid-canvas');
const ctx = canvas.getContext('2d');
const menu = document.getElementById('context-menu');
const menuItems = document.getElementById('context-menu-items');

const openPanels = {};

let dragPanel = null, dragOff = { x: 0, y: 0 };
let resizePanel = null, resizeStart = { x: 0, y: 0, w: 0, h: 0 };

// ─── Sizing ────────────────────────────────────────────────────────────

function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = window.innerWidth * dpr;
  canvas.height = window.innerHeight * dpr;
  canvas.style.width = window.innerWidth + 'px';
  canvas.style.height = window.innerHeight + 'px';
  draw();
}

// ─── Coords ────────────────────────────────────────────────────────────

function screenToWorld(sx, sy) { return { x: (sx - state.view.x) / state.view.scale, y: (sy - state.view.y) / state.view.scale }; }
function worldToScreen(wx, wy) { return { x: wx * state.view.scale + state.view.x, y: wy * state.view.scale + state.view.y }; }
function mouseToWorld(e) { const r = canvas.getBoundingClientRect(); return screenToWorld(e.clientX - r.left, e.clientY - r.top); }
function mouseToScreen(e) { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }

// ─── Drawing ───────────────────────────────────────────────────────────

const GRID_SIZE = 40, NODE_RADIUS = 14, JUNCTION_RADIUS = 4;

function nodeRadius(n) { return n.type === 'junction' ? JUNCTION_RADIUS : NODE_RADIUS; }
function isSelected(n) { return state.selectedNodeIds.has(n.id); }

function drawGrid() {
  const v = state.view;
  const tl = screenToWorld(0, 0), br = screenToWorld(window.innerWidth, window.innerHeight);
  ctx.strokeStyle = '#ddd8ce'; ctx.lineWidth = 1;
  for (let wx = Math.floor(tl.x / GRID_SIZE) * GRID_SIZE; wx <= br.x; wx += GRID_SIZE) {
    const sx = wx * v.scale + v.x;
    ctx.beginPath(); ctx.moveTo(sx, 0); ctx.lineTo(sx, window.innerHeight); ctx.stroke();
  }
  for (let wy = Math.floor(tl.y / GRID_SIZE) * GRID_SIZE; wy <= br.y; wy += GRID_SIZE) {
    const sy = wy * v.scale + v.y;
    ctx.beginPath(); ctx.moveTo(0, sy); ctx.lineTo(window.innerWidth, sy); ctx.stroke();
  }
}

function drawConnections() {
  for (const c of state.connections) {
    const s = state.nodes.find(n => n.id === c.sourceId);
    const t = state.nodes.find(n => n.id === c.targetId);
    if (!s || !t) continue;
    const p = worldToScreen(s.x, s.y), q = worldToScreen(t.x, t.y);
    ctx.beginPath(); ctx.strokeStyle = '#7a766e'; ctx.lineWidth = 2;
    ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y); ctx.stroke();
  }
}

function drawNodes() {
  const v = state.view;
  for (const node of state.nodes) {
    const p = worldToScreen(node.x, node.y);
    const baseR = nodeRadius(node), r = baseR * v.scale;
    const sel = isSelected(node), pend = node.id === state.pendingSourceId;

    if (pend) {
      ctx.beginPath(); ctx.arc(p.x, p.y, r + 8, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(122, 158, 192, 0.10)'; ctx.fill();
    }

    let fillColor;
    if (node.type === 'generator') fillColor = node.merchantLock ? '#8aaa7a' : '#6aaa64';
    else if (node.type === 'storage') fillColor = '#5a8fbb';
    else if (node.type === 'junction') fillColor = '#b0aca2';
    else fillColor = '#ca9440';

    ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fillStyle = fillColor; ctx.fill();
    ctx.strokeStyle = sel || pend ? '#7a9ec0' : '#8a867e';
    ctx.lineWidth = (sel || pend) ? 3 : 1.5; 
    if (node.merchantLock) ctx.setLineDash([3, 3]);
    ctx.stroke();
    ctx.setLineDash([]);

    const ls = Math.max(10, 11 * v.scale);
    ctx.fillStyle = '#6a665e';
    ctx.font = `${ls}px -apple-system, BlinkMacSystemFont, sans-serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';

    let label;
    if (node.type === 'generator') label = 'G';
    else if (node.type === 'storage') label = 'S';
    else if (node.type === 'junction') label = 'J';
    else label = 'L';
    label += (node.label || node.id.slice(-3));
    if (node.merchantLock) label += ' 🔒';
    ctx.fillText(label, p.x, p.y + r + 4);

    if (node.type !== 'junction' && node.mw !== undefined) {
      const ms = Math.max(9, 10 * v.scale);
      ctx.fillStyle = '#8a867e';
      ctx.font = `${ms}px -apple-system, BlinkMacSystemFont, sans-serif`;
      ctx.textBaseline = 'top';
      const suffix = node.type === 'storage' ? 'MWh' : 'MW';
      ctx.fillText(Math.round(node.mw) + suffix, p.x, p.y + r + 4 + ls + 2);
    }
  }
}

function roundRect(x, y, w, h, r) {
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
}

function drawFrequencyHud() {
  const freq = state.frequency;
  const dev = freq - 50;

  const pad = 14, bw = 170, bh = 48;
  const rx = window.innerWidth - bw - pad, ry = pad;

  ctx.fillStyle = 'rgba(240, 236, 228, 0.92)';
  ctx.beginPath(); roundRect(rx, ry, bw, bh, 8); ctx.fill();
  ctx.strokeStyle = '#d6d2c8'; ctx.lineWidth = 1;
  ctx.beginPath(); roundRect(rx, ry, bw, bh, 8); ctx.stroke();

  // Frequency value — colour shifts when deviating
  ctx.fillStyle = Math.abs(dev) > 0.3 ? '#c0392b' : (Math.abs(dev) > 0.1 ? '#d4891a' : '#5a7a5a');
  ctx.font = 'bold 24px -apple-system, BlinkMacSystemFont, sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(freq.toFixed(2) + ' Hz', rx + bw / 2, ry + bh / 2 - 4);

  ctx.fillStyle = '#8a867e';
  ctx.font = '10px -apple-system, BlinkMacSystemFont, sans-serif';
  ctx.textBaseline = 'top';
  const sign = dev > 0 ? '+' : '';
  ctx.fillText(sign + dev.toFixed(3) + ' Hz deviation', rx + bw / 2, ry + bh / 2 + 12);
}

function drawPendingLine() {
  if (!state.pendingSourceId || !ptr.mouseWorld) return;
  const src = state.nodes.find(n => n.id === state.pendingSourceId);
  if (!src) return;
  const s = worldToScreen(src.x, src.y), m = worldToScreen(ptr.mouseWorld.x, ptr.mouseWorld.y);
  ctx.beginPath(); ctx.setLineDash([6, 4]);
  ctx.strokeStyle = '#7a9ec0'; ctx.lineWidth = 2;
  ctx.moveTo(s.x, s.y); ctx.lineTo(m.x, m.y); ctx.stroke();
  ctx.setLineDash([]);
}

function drawHoverDot() {
  if (!state.hoverLine) return;
  const p = worldToScreen(state.hoverLine.x, state.hoverLine.y);
  const r = JUNCTION_RADIUS * state.view.scale;
  ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(160,156,148,0.4)'; ctx.fill();
  ctx.strokeStyle = 'rgba(160,156,148,0.5)'; ctx.lineWidth = 1.5; ctx.stroke();
}

function drawSelectionRect() {
  if (!ptr.isSelecting || !ptr.downScreen || !ptr.mouseScreen) return;
  const x1 = ptr.downScreen.x, y1 = ptr.downScreen.y, x2 = ptr.mouseScreen.x, y2 = ptr.mouseScreen.y;
  const l = Math.min(x1, x2), t = Math.min(y1, y2), w = Math.abs(x2 - x1), h = Math.abs(y2 - y1);
  ctx.beginPath(); ctx.rect(l, t, w, h); ctx.setLineDash([6, 4]);
  ctx.strokeStyle = '#7a9ec0'; ctx.lineWidth = 1.5; ctx.stroke(); ctx.setLineDash([]);
  ctx.fillStyle = 'rgba(122,158,192,0.06)'; ctx.fillRect(l, t, w, h);
}

function draw() {
  const dpr = window.devicePixelRatio || 1;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
  drawGrid(); drawConnections(); drawNodes(); drawPendingLine(); drawHoverDot(); drawSelectionRect();
  drawFrequencyHud();
}

// ─── Cursor ────────────────────────────────────────────────────────────

function updateCursor(e) {
  if (state.spaceDown) { canvas.style.cursor = ptr.isPanning ? 'grabbing' : 'grab'; return; }
  if (ptr.isDragging) { canvas.style.cursor = 'move'; return; }
  if (e) {
    const hit = hitNode(mouseToWorld(e).x, mouseToWorld(e).y);
    if (hit && isSelected(hit)) { canvas.style.cursor = 'move'; return; }
  }
  canvas.style.cursor = 'crosshair';
}

// ─── Geometry ──────────────────────────────────────────────────────────

function pointToSegmentDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, lenSq = dx * dx + dy * dy;
  if (lenSq === 0) { const ex = px - ax, ey = py - ay; return { dist: Math.sqrt(ex*ex+ey*ey), cx: ax, cy: ay }; }
  let t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx, cy = ay + t * dy;
  const ex = px - cx, ey = py - cy;
  return { dist: Math.sqrt(ex*ex+ey*ey), cx, cy };
}

function findNearestLine(wx, wy, threshold) {
  let best = null, bestDist = threshold;
  for (const conn of state.connections) {
    const src = state.nodes.find(n => n.id === conn.sourceId);
    const tgt = state.nodes.find(n => n.id === conn.targetId);
    if (!src || !tgt) continue;
    const r = pointToSegmentDist(wx, wy, src.x, src.y, tgt.x, tgt.y);
    if (r.dist < bestDist) {
      const dS = Math.sqrt((r.cx - src.x)**2 + (r.cy - src.y)**2);
      const dT = Math.sqrt((r.cx - tgt.x)**2 + (r.cy - tgt.y)**2);
      if (dS > nodeRadius(src) + 4 && dT > nodeRadius(tgt) + 4) { bestDist = r.dist; best = { x: r.cx, y: r.cy, conn }; }
    }
  }
  return best;
}

function hitNode(wx, wy) {
  for (let i = state.nodes.length - 1; i >= 0; i--) {
    const n = state.nodes[i], r = nodeRadius(n) + 4;
    if ((wx - n.x)**2 + (wy - n.y)**2 <= r * r) return n;
  }
  return null;
}

// ─── ID ────────────────────────────────────────────────────────────────

let idCounter = Date.now();
function uid() { return 'n' + (idCounter++).toString(36); }

// ─── Add Node ──────────────────────────────────────────────────────────

function addNode(type, wx, wy) {
  let node;
  if (type === 'load') {
    node = { id: uid(), type, x: wx, y: wy, label: '', mw: 10 };
  } else if (type === 'generator') {
    node = { id: uid(), type, x: wx, y: wy, label: '', mw: 0, rampRate: 5, rating: 100, inertia: 5, droop: 0.04, dispatchTarget: 0, _baseSetpoint: 0, merchantLock: false };
  } else if (type === 'storage') {
    node = { id: uid(), type, x: wx, y: wy, label: '', mw: 0, chargeRate: 5, dischargeRate: 5, maxCapacity: 100 };
  } else {
    node = { id: uid(), type, x: wx, y: wy, label: '', mw: 0 };
  }
  state.nodes.push(node);
  state.selectedNodeIds = new Set([node.id]);
  persist(); draw();
  return node;
}

// ─── Delete Node ───────────────────────────────────────────────────────

function deleteNode(id) {
  const del = state.nodes.find(n => n.id === id);
  state.nodes = state.nodes.filter(n => n.id !== id);
  state.connections = state.connections.filter(c => c.sourceId !== id && c.targetId !== id);
  state.selectedNodeIds.delete(id);
  if (state.pendingSourceId === id) state.pendingSourceId = null;
  closeSettings(id);
  // Reset frequency if last gen removed
  if (del && del.type === 'generator' && state.nodes.filter(n => n.type === 'generator').length === 0) {
    state.frequency = 50;
  }
  persist(); draw();
}

// ─── Add Connection ────────────────────────────────────────────────────

function addConnection(sourceId, targetId) {
  if (sourceId === targetId) return;
  if (state.connections.some(c => (c.sourceId === sourceId && c.targetId === targetId) || (c.sourceId === targetId && c.targetId === sourceId))) return;
  state.connections.push({ sourceId, targetId });
  state.pendingSourceId = null;
  persist(); draw();
}

// ─── Split Connection ──────────────────────────────────────────────────

function splitConnection(conn, wx, wy) {
  const j = { id: uid(), type: 'junction', x: wx, y: wy, label: '', mw: 0 };
  state.nodes.push(j);
  state.connections = state.connections.filter(c => c !== conn);
  state.connections.push({ sourceId: conn.sourceId, targetId: j.id }, { sourceId: j.id, targetId: conn.targetId });
  state.selectedNodeIds = new Set([j.id]);
  persist(); draw();
}

// ─── Marquee ───────────────────────────────────────────────────────────

function computeMarqueeSelection(w1, w2) {
  const x1 = Math.min(w1.x, w2.x), y1 = Math.min(w1.y, w2.y), x2 = Math.max(w1.x, w2.x), y2 = Math.max(w1.y, w2.y);
  const ids = new Set();
  for (const n of state.nodes) if (n.x >= x1 && n.x <= x2 && n.y >= y1 && n.y <= y2) ids.add(n.id);
  return ids;
}

// ─── Persistence ───────────────────────────────────────────────────────

async function persist() {
  try { await fetch('/api/grid', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nodes: state.nodes, connections: state.connections }) }); }
  catch (e) { console.error('Persist failed:', e); }
}

async function load() {
  try {
    const res = await fetch('/api/grid');
    const data = await res.json();
    state.nodes = data.nodes || [];
    state.connections = data.connections || [];
    state.selectedNodeIds = new Set();
    state.frequency = 50;
    for (const n of state.nodes) {
      if (n.mw === undefined) n.mw = 0;
      if (n.type === 'load' && n.mw === 0) n.mw = 10;
      if (n.type === 'generator') {
        if (n.rampRate === undefined) n.rampRate = 5;
        if (n.rating === undefined) n.rating = 100;
        if (n.inertia === undefined) n.inertia = 5;
        if (n.droop === undefined) n.droop = 0.04;
        if (n.dispatchTarget === undefined) n.dispatchTarget = 0;
        if (n._baseSetpoint === undefined) n._baseSetpoint = n.mw || 0;
        if (n.merchantLock === undefined) n.merchantLock = false;
      }
      if (n.type === 'storage') {
        if (n.chargeRate === undefined) n.chargeRate = 5;
        if (n.dischargeRate === undefined) n.dischargeRate = 5;
        if (n.maxCapacity === undefined) n.maxCapacity = 100;
      }
    }
  } catch (e) { console.error('Load failed:', e); }
}

// ─── Context Menu ──────────────────────────────────────────────────────

function showMenu(e, nodeHit) {
  e.preventDefault();
  const world = mouseToWorld(e);
  menu.dataset.wx = world.x; menu.dataset.wy = world.y;
  menu.dataset.nodeId = nodeHit ? nodeHit.id : '';
  menuItems.innerHTML = '';

  if (nodeHit && nodeHit.type !== 'junction') {
    addMenuItem('Open settings', 'open-settings');
    addMenuSeparator();
    addMenuItem('Delete', 'delete-node');
  } else if (nodeHit) {
    addMenuItem('Delete', 'delete-node');
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

canvas.addEventListener('contextmenu', (e) => { showMenu(e, hitNode(mouseToWorld(e).x, mouseToWorld(e).y)); });

document.addEventListener('keydown', (e) => {
  if (e.key === ' ' || e.code === 'Space') { e.preventDefault(); if (!state.spaceDown) { state.spaceDown = true; updateCursor(); } }
});
document.addEventListener('keyup', (e) => {
  if (e.key === ' ' || e.code === 'Space') { e.preventDefault(); state.spaceDown = false; updateCursor(); }
});

canvas.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  hideMenu();
  const world = mouseToWorld(e), screen = mouseToScreen(e), hit = hitNode(world.x, world.y);
  ptr.downWorld = world; ptr.downScreen = screen; ptr.downTime = Date.now();
  ptr.downNodeId = hit ? hit.id : null;
  ptr.isDragging = false; ptr.isPanning = false; ptr.isSelecting = false; ptr.moved = false;
  if (hit && !isSelected(hit)) { state.selectedNodeIds = new Set([hit.id]); draw(); }
});

canvas.addEventListener('mousemove', (e) => {
  const world = mouseToWorld(e), screen = mouseToScreen(e);
  ptr.mouseWorld = world; ptr.mouseScreen = screen;

  if (ptr.isDragging) {
    const dx = world.x - ptr.downWorld.x, dy = world.y - ptr.downWorld.y;
    for (const id of state.selectedNodeIds) { const n = state.nodes.find(n => n.id === id); if (n) { n.x += dx; n.y += dy; } }
    ptr.downWorld = { x: world.x, y: world.y }; state.hoverLine = null; draw(); updateCursor(e); return;
  }
  if (ptr.isPanning) {
    state.view.x = e.clientX - ptr._panOffsetX; state.view.y = e.clientY - ptr._panOffsetY;
    state.hoverLine = null; draw(); return;
  }

  if (ptr.downWorld) {
    const d = Math.sqrt(((world.x - ptr.downWorld.x) * state.view.scale)**2 + ((world.y - ptr.downWorld.y) * state.view.scale)**2);
    if (d > DRAG_THRESHOLD) {
      ptr.moved = true;
      if (state.spaceDown) { ptr.isPanning = true; ptr._panOffsetX = e.clientX - state.view.x; ptr._panOffsetY = e.clientY - state.view.y; canvas.style.cursor = 'grabbing'; draw(); return; }
      if (ptr.downNodeId) { ptr.isDragging = true; canvas.style.cursor = 'move'; draw(); return; }
      ptr.isSelecting = true; draw(); return;
    }
  }

  state.hoverLine = findNearestLine(world.x, world.y, 15 / state.view.scale);
  draw(); updateCursor(e);
});

canvas.addEventListener('mouseup', (e) => {
  if (e.button !== 0) return;
  if (ptr.isDragging) { ptr.isDragging = false; ptr.downNodeId = null; ptr.downWorld = null; persist(); draw(); updateCursor(e); return; }
  if (ptr.isPanning) { ptr.isPanning = false; ptr.downWorld = null; draw(); updateCursor(e); return; }
  if (ptr.isSelecting) {
    ptr.isSelecting = false;
    state.selectedNodeIds = computeMarqueeSelection(screenToWorld(ptr.downScreen.x, ptr.downScreen.y), screenToWorld(ptr.mouseScreen.x, ptr.mouseScreen.y));
    ptr.downWorld = null; draw(); updateCursor(e); return;
  }

  ptr.downWorld = null;
  const cw = mouseToWorld(e), hit = hitNode(cw.x, cw.y), now = Date.now();
  const dbl = hit && hit.id === ptr.lastClickNodeId && (now - ptr.lastClickTime) < 400;
  ptr.lastClickTime = now; ptr.lastClickNodeId = hit ? hit.id : null;
  if (dbl) { onDoubleClickNode(hit); return; }

  const hover = state.hoverLine && findNearestLine(cw.x, cw.y, 15 / state.view.scale);
  if (hover) { state.hoverLine = hover; splitConnection(hover.conn, hover.x, hover.y); state.hoverLine = null; return; }
  if (!hit) { state.pendingSourceId = null; state.selectedNodeIds = new Set(); draw(); return; }
  if (state.pendingSourceId) { addConnection(state.pendingSourceId, hit.id); return; }
  state.selectedNodeIds = new Set([hit.id]); draw();
});

function onDoubleClickNode(hit) {
  if (state.pendingSourceId === hit.id) { state.pendingSourceId = null; state.selectedNodeIds = new Set(); }
  else { state.pendingSourceId = hit.id; state.selectedNodeIds = new Set([hit.id]); }
  draw();
}

canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const r = canvas.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top;
  const w = screenToWorld(mx, my), f = e.deltaY < 0 ? 1.08 : 1 / 1.08;
  const ns = Math.max(0.1, Math.min(10, state.view.scale * f));
  state.view.x = mx - w.x * ns; state.view.y = my - w.y * ns; state.view.scale = ns;
  draw();
}, { passive: false });

menu.addEventListener('click', (e) => {
  const item = e.target.closest('.context-menu-item');
  if (!item) return;
  const a = item.dataset.action, wx = parseFloat(menu.dataset.wx), wy = parseFloat(menu.dataset.wy), id = menu.dataset.nodeId;
  if (a === 'add-generator') addNode('generator', wx, wy);
  else if (a === 'add-load') addNode('load', wx, wy);
  else if (a === 'add-storage') addNode('storage', wx, wy);
  else if (a === 'add-junction') addNode('junction', wx, wy);
  else if (a === 'open-settings') openSettings(id);
  else if (a === 'delete-node' && id) deleteNode(id);
  hideMenu();
});

document.addEventListener('click', (e) => { if (!menu.contains(e.target)) hideMenu(); });

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { state.pendingSourceId = null; state.selectedNodeIds = new Set(); state.hoverLine = null; hideMenu(); draw(); }
  if ((e.key === 'Backspace' || e.key === 'Delete') && state.selectedNodeIds.size > 0) {
    const hadGen = [...state.selectedNodeIds].some(id => state.nodes.find(n => n.id === id)?.type === 'generator');
    for (const id of [...state.selectedNodeIds]) {
      state.nodes = state.nodes.filter(n => n.id !== id);
      state.connections = state.connections.filter(c => c.sourceId !== id && c.targetId !== id);
      if (state.pendingSourceId === id) state.pendingSourceId = null;
      closeSettings(id);
    }
    state.selectedNodeIds = new Set();
    if (hadGen && state.nodes.filter(n => n.type === 'generator').length === 0) state.frequency = 50;
    persist(); draw();
  }
});

// ─── Settings Panels ───────────────────────────────────────────────────

function openSettings(nodeId) {
  const node = state.nodes.find(n => n.id === nodeId);
  if (!node || node.type === 'junction') return;
  if (openPanels[nodeId]) { openPanels[nodeId].panel.style.zIndex = Date.now(); return; }

  const panel = document.createElement('div');
  panel.className = 'settings-panel'; panel.dataset.nodeId = nodeId; panel.style.zIndex = Date.now();
  const tag = node.label || node.id.slice(-4);
  const entry = { panel };

  if (node.type === 'generator') {
    panel.innerHTML = `
      <div class="settings-header"><span class="settings-title">Generator ${tag}</span><span class="settings-close" data-action="close-settings">&times;</span></div>
      <div class="settings-body">
        <div class="settings-row"><label class="settings-label">Dispatch (MW)</label><div class="settings-slider-group"><input type="range" class="dispatch-slider" min="0" max="${node.rating}" step="10" value="${node.dispatchTarget || 0}"><span class="dispatch-value">${node.dispatchTarget || 0}</span></div></div>
        <div class="settings-row"><label class="settings-label">Current Output</label><div class="settings-value-display gen-output" style="font-size:18px">${Math.round(node.mw || 0)} MW</div></div>
        <div class="settings-row"><label class="settings-label">Ramp Rate (MW/s)</label><div class="settings-slider-group"><input type="range" class="ramp-slider" min="1" max="50" step="1" value="${node.rampRate || 5}"><span class="ramp-value">${node.rampRate || 5}</span></div></div>
        <div class="settings-row"><label class="settings-label">Rating (MVA)</label><div class="settings-slider-group"><input type="range" class="rating-slider" min="10" max="500" step="10" value="${node.rating || 100}"><span class="rating-value">${node.rating || 100}</span></div></div>
        <div class="settings-row"><label class="settings-label">Inertia H (s)</label><div class="settings-slider-group"><input type="range" class="inertia-slider" min="1" max="15" step="0.5" value="${node.inertia || 5}"><span class="inertia-value">${(node.inertia || 5).toFixed(1)}</span></div></div>
        <div class="settings-row"><label class="settings-label">Droop (%)</label><div class="settings-slider-group"><input type="range" class="droop-slider" min="1" max="10" step="0.5" value="${(node.droop || 0.04) * 100}"><span class="droop-value">${((node.droop || 0.04) * 100).toFixed(1)}%</span></div></div>
        <div class="settings-row sep-top"><label class="settings-label">Merchant Lock</label><div class="settings-slider-group"><label class="toggle"><input type="checkbox" class="merchant-toggle" ${node.merchantLock ? 'checked' : ''}><span class="toggle-track"><span class="toggle-knob"></span></span></label><span class="merchant-status">${node.merchantLock ? '🔒 Fixed' : '🔓 Balancing'}</span></div></div>
      </div>
      <div class="settings-resize-handle"></div>`;

    entry.outputEl = panel.querySelector('.gen-output');

    const dispatchSlider = panel.querySelector('.dispatch-slider'), dispatchVal = panel.querySelector('.dispatch-value');
    entry.dispatchSlider = dispatchSlider;
    entry.dispatchVal = dispatchVal;
    dispatchSlider.addEventListener('input', () => { const v = Math.min(parseInt(dispatchSlider.value, 10), node.rating); dispatchVal.textContent = v; node.dispatchTarget = v; });
    dispatchSlider.addEventListener('change', () => persist());

    const rampSlider = panel.querySelector('.ramp-slider'), rampVal = panel.querySelector('.ramp-value');
    rampSlider.addEventListener('input', () => { const v = parseInt(rampSlider.value, 10); rampVal.textContent = v; node.rampRate = v; });
    rampSlider.addEventListener('change', () => persist());

    const ratSlider = panel.querySelector('.rating-slider'), ratVal = panel.querySelector('.rating-value');
    ratSlider.addEventListener('input', () => {
      const v = parseInt(ratSlider.value, 10);
      ratVal.textContent = v;
      node.rating = v;
      if (node.dispatchTarget > v) {
        node.dispatchTarget = v;
        dispatchSlider.max = v;
        dispatchSlider.value = v;
        dispatchVal.textContent = v;
      } else {
        dispatchSlider.max = v;
      }
    });
    ratSlider.addEventListener('change', () => persist());

    const inSlider = panel.querySelector('.inertia-slider'), inVal = panel.querySelector('.inertia-value');
    inSlider.addEventListener('input', () => { const v = parseFloat(inSlider.value); inVal.textContent = v.toFixed(1); node.inertia = v; });
    inSlider.addEventListener('change', () => persist());

    const drSlider = panel.querySelector('.droop-slider'), drVal = panel.querySelector('.droop-value');
    drSlider.addEventListener('input', () => { const v = parseFloat(drSlider.value); drVal.textContent = v.toFixed(1) + '%'; node.droop = v / 100; });
    drSlider.addEventListener('change', () => persist());

    // Merchant lock toggle
    const merchantToggle = panel.querySelector('.merchant-toggle');
    const merchantStatus = panel.querySelector('.merchant-status');
    if (merchantToggle) {
      merchantToggle.addEventListener('change', () => {
        node.merchantLock = merchantToggle.checked;
        if (node.merchantLock) {
          node.dispatchTarget = Math.min(node.dispatchTarget || 0, node.rating || Infinity);
          node._baseSetpoint = node.dispatchTarget;
          merchantStatus.textContent = '🔒 Fixed';
        } else {
          merchantStatus.textContent = '🔓 Balancing';
        }
        persist();
      });
    }

  } else if (node.type === 'storage') {
    panel.innerHTML = `
      <div class="settings-header"><span class="settings-title">Storage ${tag}</span><span class="settings-close" data-action="close-settings">&times;</span></div>
      <div class="settings-body">
        <div class="settings-row"><label class="settings-label">State of Charge</label><div class="settings-value-display storage-soc">${Math.round(node.mw || 0)} MWh</div></div>
        <div class="settings-row"><label class="settings-label">Charge Rate (MW)</label><div class="settings-slider-group"><input type="range" class="charge-slider" min="1" max="50" step="1" value="${node.chargeRate || 5}"><span class="charge-value">${node.chargeRate || 5}</span></div></div>
        <div class="settings-row"><label class="settings-label">Discharge Rate (MW)</label><div class="settings-slider-group"><input type="range" class="discharge-slider" min="1" max="50" step="1" value="${node.dischargeRate || 5}"><span class="discharge-value">${node.dischargeRate || 5}</span></div></div>
        <div class="settings-row"><label class="settings-label">Max Capacity (MWh)</label><div class="settings-slider-group"><input type="range" class="capacity-slider" min="10" max="500" step="10" value="${node.maxCapacity || 100}"><span class="capacity-value">${node.maxCapacity || 100}</span></div></div>
      </div>
      <div class="settings-resize-handle"></div>`;

    entry.socEl = panel.querySelector('.storage-soc');

    const chg = panel.querySelector('.charge-slider'), chgV = panel.querySelector('.charge-value');
    chg.addEventListener('input', () => { const v = parseInt(chg.value, 10); chgV.textContent = v; node.chargeRate = v; });
    chg.addEventListener('change', () => persist());

    const dchg = panel.querySelector('.discharge-slider'), dchgV = panel.querySelector('.discharge-value');
    dchg.addEventListener('input', () => { const v = parseInt(dchg.value, 10); dchgV.textContent = v; node.dischargeRate = v; });
    dchg.addEventListener('change', () => persist());

    const cap = panel.querySelector('.capacity-slider'), capV = panel.querySelector('.capacity-value');
    cap.addEventListener('input', () => { const v = parseInt(cap.value, 10); capV.textContent = v; node.maxCapacity = v; if (node.mw > v) node.mw = v; });
    cap.addEventListener('change', () => persist());

  } else {
    panel.innerHTML = `
      <div class="settings-header"><span class="settings-title">Load ${tag}</span><span class="settings-close" data-action="close-settings">&times;</span></div>
      <div class="settings-body">
        <div class="settings-row"><label class="settings-label">Demand (MW)</label><div class="settings-slider-group"><input type="range" class="mw-slider" min="0" max="500" step="10" value="${node.mw || 10}"><span class="mw-value">${node.mw || 10}</span></div></div>
      </div>
      <div class="settings-resize-handle"></div>`;

    const slider = panel.querySelector('.mw-slider'), valEl = panel.querySelector('.mw-value');
    slider.addEventListener('input', () => { const v = parseInt(slider.value, 10); valEl.textContent = v; node.mw = v; draw(); });
    slider.addEventListener('change', () => persist());
  }

  const count = Object.keys(openPanels).length;
  panel.style.left = (120 + count * 28) + 'px'; panel.style.top = (80 + count * 28) + 'px';
  document.body.appendChild(panel);

  panel.querySelector('[data-action="close-settings"]').addEventListener('click', (e) => { e.stopPropagation(); closeSettings(nodeId); });

  panel.addEventListener('mousedown', (e) => {
    if (e.target.closest('.settings-header')) { dragPanel = panel; dragOff = { x: e.clientX - panel.offsetLeft, y: e.clientY - panel.offsetTop }; panel.style.zIndex = Date.now(); e.preventDefault(); }
    if (e.target.closest('.settings-resize-handle')) { resizePanel = panel; resizeStart = { x: e.clientX, y: e.clientY, w: panel.offsetWidth, h: panel.offsetHeight }; panel.style.zIndex = Date.now(); e.preventDefault(); }
  });

  openPanels[nodeId] = entry;
}

function closeSettings(nodeId) { if (openPanels[nodeId]) { openPanels[nodeId].panel.remove(); delete openPanels[nodeId]; } }

document.addEventListener('mousemove', (e) => {
  if (dragPanel) { dragPanel.style.left = (e.clientX - dragOff.x) + 'px'; dragPanel.style.top = (e.clientY - dragOff.y) + 'px'; }
  if (resizePanel) { resizePanel.style.width = Math.max(220, resizeStart.w + e.clientX - resizeStart.x) + 'px'; resizePanel.style.height = Math.max(140, resizeStart.h + e.clientY - resizeStart.y) + 'px'; }
});
document.addEventListener('mouseup', () => { dragPanel = null; resizePanel = null; });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { for (const id of Object.keys(openPanels)) closeSettings(id); } });

// ─── Controls ──────────────────────────────────────────────────────────

function updateControls() {
  const playBtn = document.getElementById('play-btn');
  const pauseBtn = document.getElementById('pause-btn');
  const saveBtn = document.getElementById('save-data-btn');
  if (sim.running) {
    playBtn.disabled = true;
    pauseBtn.disabled = false;
    saveBtn.disabled = true;
  } else {
    playBtn.disabled = false;
    pauseBtn.disabled = true;
    saveBtn.disabled = false;
  }
}

document.getElementById('play-btn').addEventListener('click', () => { startSim(); updateControls(); });
document.getElementById('pause-btn').addEventListener('click', () => { stopSim(); updateControls(); });
document.getElementById('restart-btn').addEventListener('click', restartSim);
document.getElementById('save-data-btn').addEventListener('click', saveSnapshot);

// ─── Init ──────────────────────────────────────────────────────────────

async function init() {
  await load();
  resizeCanvas();
  draw();
  updateControls();
}

window.addEventListener('resize', resizeCanvas);
init();
