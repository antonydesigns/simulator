import { state, sim, ISLAND_COLORS, ptr, canvas, ctx, GRID_SIZE, NODE_RADIUS, JUNCTION_RADIUS } from './state.js';

// ─── Coords ────────────────────────────────────────────────────────────

export function screenToWorld(sx, sy) { return { x: (sx - state.view.x) / state.view.scale, y: (sy - state.view.y) / state.view.scale }; }
export function worldToScreen(wx, wy) { return { x: wx * state.view.scale + state.view.x, y: wy * state.view.scale + state.view.y }; }
export function mouseToWorld(e) { const r = canvas.getBoundingClientRect(); return screenToWorld(e.clientX - r.left, e.clientY - r.top); }
export function mouseToScreen(e) { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }

// ─── Drawing ───────────────────────────────────────────────────────────

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
  const v = state.view;
  for (const conn of state.connections) {
    const src = state.nodes.find(n => n.id === conn.sourceId);
    const tgt = state.nodes.find(n => n.id === conn.targetId);
    if (!src || !tgt) continue;
    const sx = src.x * v.scale + v.x, sy = src.y * v.scale + v.y;
    const tx = tgt.x * v.scale + v.x, ty = tgt.y * v.scale + v.y;

    let color;
    const sameNet = conn.reactance !== undefined && conn.reactance > 0;
    if (conn.tripped) {
      color = '#aaa';
    } else if (sameNet && conn.loadingPct !== undefined) {
      if (conn.loadingPct > 120) color = '#8b0000';
      else if (conn.loadingPct > 100) color = '#c0392b';
      else if (conn.loadingPct > 80) color = '#e67e22';
      else if (conn.loadingPct > 60) color = '#d4a017';
      else color = '#5a8a5a';
    } else {
      color = state.selectedConnIds.has(conn.id) ? '#3498db' : '#999';
    }

    ctx.strokeStyle = color;
    ctx.lineWidth = state.selectedConnIds.has(conn.id) ? 3 : 2;
    ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(tx, ty); ctx.stroke();

    // Trip progress bar at midpoint (only overloaded lines)
    if (sameNet && conn.loadingPct !== undefined && conn.loadingPct > 100 && state.view.scale > 0.5) {
      let maxTime;
      if (conn.loadingPct >= 200) maxTime = 0.5;
      else if (conn.loadingPct >= 150) maxTime = 2;
      else if (conn.loadingPct >= 120) maxTime = 5;
      const progress = maxTime ? (conn.tripTimer || 0) / maxTime : 0;
      if (progress > 0) {
        const mx = (sx + tx) / 2, my = (sy + ty) / 2;
        const bw = 40; ctx.fillStyle = 'rgba(0,0,0,0.6)';
        ctx.fillRect(mx - bw/2, my - 6, bw, 10);
        ctx.fillStyle = progress > 1 ? '#8b0000' : '#d4a017';
        ctx.fillRect(mx - bw/2 + 2, my - 4, Math.min(bw - 4, (bw - 4) * progress), 6);
      }
    }

    // Arrow midpoint
    if (!conn.tripped && conn.mw !== undefined && Math.abs(conn.mw) > 0.5) {
      const mw = conn.mw;
      const ang = Math.atan2(ty - sy, tx - sx);
      const mx = (sx + tx) / 2, my = (sy + ty) / 2;
      const flowDir = mw > 0 ? 1 : -1;
      ctx.translate(mx, my); ctx.rotate(ang);
      ctx.fillStyle = color; ctx.beginPath();
      ctx.moveTo(flowDir * 8, 0); ctx.lineTo(-flowDir * 4, -5); ctx.lineTo(-flowDir * 4, 5); ctx.closePath(); ctx.fill();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
    }

    // MW label at midpoint
    if (conn.tripped) {
      const mx = (sx + tx) / 2, my = (sy + ty) / 2;
      ctx.fillStyle = '#aaa'; ctx.font = '11px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
      ctx.fillText('TRIPPED', mx, my - 14);
    } else if (conn.mw !== undefined && state.view.scale > 0.4) {
      const mx = (sx + tx) / 2, my = (sy + ty) / 2;
      ctx.fillStyle = '#666'; ctx.font = '11px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
      const pct = conn.loadingPct !== undefined ? conn.loadingPct.toFixed(0) : '?';
      ctx.fillText(Math.round(conn.mw) + ' MW (' + pct + '%)', mx, my - 14);
    }
  }
}

function drawNodes() {
  for (const node of state.nodes) {
    const sx = node.x * state.view.scale + state.view.x, sy = node.y * state.view.scale + state.view.y;
    const r = nodeRadius(node);
    if (sx < -50 || sx > window.innerWidth + 50 || sy < -50 || sy > window.innerHeight + 50) continue;
    const sel = isSelected(node);

    // Type icon
    if (node.type === 'generator') {
      ctx.save(); ctx.translate(sx, sy);
      if (node.tripped) { ctx.globalAlpha = 0.3; ctx.fillStyle = '#999'; ctx.strokeStyle = '#999'; }
      else if (sel) { ctx.fillStyle = '#3498db'; ctx.strokeStyle = '#2980b9'; }
      else if (state.hoveredNodeId === node.id) { ctx.fillStyle = '#5dade2'; ctx.strokeStyle = '#3498db'; }
      else { ctx.fillStyle = '#85c1e9'; ctx.strokeStyle = '#5dade2'; }
      ctx.lineWidth = sel ? 3 : 1.5;
      // Rotor shape
      ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      // Fan
      ctx.beginPath();
      ctx.arc(0, 0, r * 0.5, 0, Math.PI * 2); ctx.closePath();
      ctx.fillStyle = '#fff'; ctx.fill(); ctx.stroke();
      // Rotor blades
      for (let i = 0; i < 3; i++) {
        ctx.save(); ctx.rotate(i * Math.PI * 2 / 3);
        ctx.beginPath(); ctx.ellipse(r * 0.4, 0, r * 0.35, r * 0.1, 0, 0, Math.PI * 2); ctx.fillStyle = '#fff'; ctx.fill(); ctx.stroke();
        ctx.restore();
      }
      ctx.restore();
      // Label
      ctx.fillStyle = node.tripped ? '#999' : '#2c3e50'; ctx.font = 'bold 11px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      const genLabel = node.shortId || 'G';
      ctx.fillText(genLabel, sx, sy + r + 4);
      // MW
      ctx.font = '10px sans-serif'; ctx.fillStyle = '#555';
      ctx.fillText((node.mw || 0).toFixed(0) + ' MW', sx, sy + r + 18);
      // Mode
      if (node.mode && node.mode !== 'balancing') {
        ctx.fillStyle = '#888'; ctx.font = '9px sans-serif';
        ctx.fillText(node.mode, sx, sy + r + 30);
      }
    } else if (node.type === 'load') {
      ctx.save(); ctx.translate(sx, sy);
      const shed = (node.shedPct || 0) > 0;
      ctx.fillStyle = shed ? '#d4a017' : '#e6b0aa';
      ctx.strokeStyle = shed ? '#b7950b' : '#c0392b';
      ctx.lineWidth = sel ? 3 : 1.5;
      // Triangle
      ctx.beginPath();
      ctx.moveTo(0, -r); ctx.lineTo(r * 0.8, r * 0.5); ctx.lineTo(-r * 0.8, r * 0.5); ctx.closePath(); ctx.fill(); ctx.stroke();
      if (shed) { ctx.fillStyle = '#fff'; ctx.font = 'bold 12px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('!', 0, 2); }
      ctx.restore();
      ctx.fillStyle = '#2c3e50'; ctx.font = 'bold 11px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      ctx.fillText(node.shortId || 'L', sx, sy + r + 4);
      ctx.font = '10px sans-serif'; ctx.fillStyle = '#555';
      ctx.fillText((node.mw || 0).toFixed(0) + ' MW', sx, sy + r + 18);
    } else if (node.type === 'storage') {
      ctx.save(); ctx.translate(sx, sy);
      if (node.tripped) { ctx.globalAlpha = 0.3; ctx.fillStyle = '#999'; ctx.strokeStyle = '#999'; }
      else if (sel) { ctx.fillStyle = '#3498db'; ctx.strokeStyle = '#2980b9'; }
      else { ctx.fillStyle = '#aed6f1'; ctx.strokeStyle = '#5dade2'; }
      ctx.lineWidth = sel ? 3 : 1.5;
      const hw = r, hh = r * 0.7;
      roundRectCtx(ctx, -hw, -hh, hw * 2, hh * 2, 4); ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#fff';
      ctx.fillRect(-hw * 0.6, -hh * 0.4, hw * 1.2, hh * 0.8);
      ctx.restore();
      ctx.fillStyle = node.tripped ? '#999' : '#2c3e50'; ctx.font = 'bold 10px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      ctx.fillText(node.shortId || 'B', sx, sy + r + 4);
      ctx.font = '10px sans-serif'; ctx.fillStyle = '#555';
      const resp = node.mwResponse || 0;
      ctx.fillText((resp >= 0 ? '+' : '') + Math.round(resp) + ' MW', sx, sy + r + 18);
    } else if (node.type === 'junction') {
      ctx.fillStyle = '#bbb'; ctx.beginPath(); ctx.arc(sx, sy, JUNCTION_RADIUS, 0, Math.PI * 2); ctx.fill();
    }
  }
}

export function roundRect(x, y, w, h, r) {
  ctx.beginPath(); roundRectCtx(ctx, x, y, w, h, r); ctx.fill(); ctx.stroke();
}

function drawFrequencyHud() {
  const f = state.frequency;
  const dev = f - 50;
  ctx.fillStyle = Math.abs(dev) > 0.3 ? '#c0392b' : (Math.abs(dev) > 0.1 ? '#d4891a' : '#5a7a5a');
  ctx.font = 'bold 18px -apple-system, BlinkMacSystemFont, sans-serif';
  ctx.textAlign = 'right'; ctx.textBaseline = 'top';
  ctx.fillText(f.toFixed(3) + ' Hz', window.innerWidth - 16, 10);
  if (Math.abs(dev) > 0.001) {
    ctx.font = '13px -apple-system, BlinkMacSystemFont, sans-serif';
    const dir = dev > 0 ? '↗' : '↘';
    ctx.fillText(dir + ' ' + Math.abs(dev).toFixed(3), window.innerWidth - 16, 36);
  }
  // Market info
  if (state.smp !== undefined && state.smp !== null) {
    ctx.font = '12px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.fillStyle = '#666'; ctx.textAlign = 'right';
    ctx.fillText('SMP: $' + state.smp.toFixed(2) + '/MWh', window.innerWidth - 16, 58);
    ctx.fillText('Load: ' + (state.marketLoad || 0).toFixed(0) + ' MW', window.innerWidth - 16, 74);
  }
}

function drawPendingLine() {
  if (!state.pendingSourceId) return;
  const src = state.nodes.find(n => n.id === state.pendingSourceId);
  if (!src) return;
  if (!ptr.mouseWorld) return;
  const sx = src.x * state.view.scale + state.view.x, sy = src.y * state.view.scale + state.view.y;
  ctx.strokeStyle = '#3498db'; ctx.lineWidth = 2; ctx.setLineDash([4, 4]);
  ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(ptr.mouseScreen.x, ptr.mouseScreen.y); ctx.stroke(); ctx.setLineDash([]);
}

function drawHoverDot() {
  if (state.hoveredNodeId) {
    const n = state.nodes.find(n => n.id === state.hoveredNodeId);
    if (n) {
      const sx = n.x * state.view.scale + state.view.x, sy = n.y * state.view.scale + state.view.y;
      ctx.beginPath(); ctx.arc(sx, sy, nodeRadius(n) + 3, 0, Math.PI * 2);
      ctx.strokeStyle = '#3498db'; ctx.lineWidth = 2; ctx.stroke();
    }
  }
}

function drawSelectionRect() {
  if (!ptr.isSelecting || !ptr.downScreen || !ptr.mouseScreen) return;
  const x = Math.min(ptr.downScreen.x, ptr.mouseScreen.x);
  const y = Math.min(ptr.downScreen.y, ptr.mouseScreen.y);
  const w = Math.abs(ptr.mouseScreen.x - ptr.downScreen.x);
  const h = Math.abs(ptr.mouseScreen.y - ptr.downScreen.y);
  ctx.fillStyle = 'rgba(52,152,219,0.1)'; ctx.strokeStyle = '#3498db'; ctx.lineWidth = 1; ctx.setLineDash([4, 4]);
  ctx.beginPath(); ctx.rect(x, y, w, h); ctx.fill(); ctx.stroke(); ctx.setLineDash([]);
}

function drawStrandedIndicators() {
  if (!state.strandedLoadIds || state.strandedLoadIds.size === 0) return;
  for (const id of state.strandedLoadIds) {
    const load = state.nodes.find(n => n.id === id);
    if (!load) continue;
    const sp = worldToScreen(load.x, load.y);
    ctx.fillStyle = '#e67e22'; ctx.font = 'bold 14px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText('⚡', sp.x, sp.y - nodeRadius(load) - 8);
  }
}

function drawLoadCurvePreview(cvs, node) {
  const win = cvs.width - 20;
  const h = cvs.height - 10;
  const ctx2 = cvs.getContext('2d');
  ctx2.clearRect(0, 0, cvs.width, cvs.height);
  ctx2.strokeStyle = '#ccc'; ctx2.lineWidth = 1;
  ctx2.beginPath();
  for (let px = 0; px <= win; px++) {
    const patSec = (px / win) * 1440 * 60;
    const mult = demandCurve(patSec);
    const base = (node.noiseMin || 100) + ((node.noiseMax || 200) - (node.noiseMin || 100)) * mult;
    const py = h - ((node.noiseMin || 100) + ((node.noiseMax || 200) - (node.noiseMin || 100)) * 1);
    const y2 = h - (base - (node.noiseMin || 100)) / ((node.noiseMax || 200) - (node.noiseMin || 100) || 1) * h;
    if (px === 0) ctx2.moveTo(px + 10, y2 + 5); else ctx2.lineTo(px + 10, y2 + 5);
  }
  ctx2.stroke();
  // Current position marker
  if (sim.simTime > 0) {
    const patSec2 = sim.simTime * 720;
    const px2 = ((patSec2 % (1440 * 60)) / (1440 * 60)) * win + 10;
    const curMult = demandCurve(patSec2);
    const py2 = h + 5 - ((node.noiseMin || 100) + ((node.noiseMax || 200) - (node.noiseMin || 100)) * curMult - (node.noiseMin || 100)) / ((node.noiseMax || 200) - (node.noiseMin || 100) || 1) * h;
    ctx2.fillStyle = '#c0392b'; ctx2.beginPath(); ctx2.arc(px2, py2, 3, 0, Math.PI * 2); ctx2.fill();
  }
}

export function draw() {
  const dpr = window.devicePixelRatio || 1;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
  drawGrid(); drawIslands(); drawConnections(); drawNodes(); drawPendingLine(); drawHoverDot(); drawSelectionRect(); drawStrandedIndicators();

  // Redraw load preview canvases (updates position marker)
  if (sim.simTime > 0) {
    for (const c of document.querySelectorAll('.demand-preview')) {
      const id = c.getAttribute('data-node-id');
      const node = state.nodes.find(n => n.id === id);
      if (node) drawLoadCurvePreview(c, node);
    }
  }
}

// ─── Islands ──────────────────────────────────────────────────────────

export const ISLAND_HEADER_H = 30;

function drawIslands() {
  const nets = state.networks || [];
  const isHovered = id => (id === state.hoveredIslandId && state.hoveredIslandHeader) || id === state.selectedNetworkId;

  for (const net of nets) {
    if (!net.valid) continue;
    const bb = net.boundingBox;
    if (!bb || bb.w < 1 || bb.h < 1) continue;

    const tl = worldToScreen(bb.x, bb.y);
    const br = worldToScreen(bb.x + bb.w, bb.y + bb.h);
    const w = br.x - tl.x, h = br.y - tl.y;
    if (br.x < -200 || br.y < -200 || tl.x > window.innerWidth + 200 || tl.y > window.innerHeight + 200) continue;

    const color = net.color || ISLAND_COLORS[0];
    const showFull = isHovered(net.id);
    const headerH = 28;

    if (showFull) {
      ctx.fillStyle = color + '0d';
      ctx.strokeStyle = color + '50';
      ctx.lineWidth = net.id === state.selectedNetworkId ? 2.5 : 1.5;
      ctx.setLineDash(net.id === state.selectedNetworkId ? [] : [4, 4]);
      ctx.beginPath(); roundRectCtx(ctx, tl.x, tl.y, w, h, 14); ctx.fill(); ctx.stroke();
      ctx.setLineDash([]);
    }

    ctx.fillStyle = color + '25';
    ctx.beginPath(); roundRectCtx(ctx, tl.x, tl.y, w, headerH, 14); ctx.fill();

    const label = (net.id === state.selectedNetworkId ? '▶ ' : '🏝 ') + (net.customName || net.id);
    const freq = net.freq !== undefined ? net.freq.toFixed(2) : '—';
    let arrow = '';
    if (net.freqPrev !== undefined && net.freq !== undefined) {
      const diff = net.freq - net.freqPrev;
      if (diff > 0.005) arrow = '▲';
      else if (diff < -0.005) arrow = '▼';
      else arrow = '▸';
    }
    const freqLabel = freq + ' Hz ' + arrow;

    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#444';
    ctx.font = '12px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(label, tl.x + 10, tl.y + headerH / 2);

    const dev = (net.freq || 50) - 50;
    const freqColor = Math.abs(dev) > 0.3 ? '#c0392b' : (Math.abs(dev) > 0.1 ? '#d4891a' : '#5a7a5a');
    ctx.fillStyle = freqColor;
    ctx.font = 'bold 12px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(freqLabel, tl.x + w - 10, tl.y + headerH / 2);
  }
}

export function roundRectCtx(ctx2, x, y, w, h, r) {
  if (typeof r === 'object') {
    const { tl, tr, bl, br } = r;
    ctx2.moveTo(x + tl, y);
    ctx2.lineTo(x + w - tr, y); ctx2.quadraticCurveTo(x + w, y, x + w, y + tr);
    ctx2.lineTo(x + w, y + h - br); ctx2.quadraticCurveTo(x + w, y + h, x + w - br, y + h);
    ctx2.lineTo(x + bl, y + h); ctx2.quadraticCurveTo(x, y + h, x, y + h - bl);
    ctx2.closePath();
    return;
  }
  r = Math.min(r, w / 2, h / 2);
  ctx2.moveTo(x + r, y);
  ctx2.lineTo(x + w - r, y);
  ctx2.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx2.lineTo(x + w, y + h - r);
  ctx2.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx2.lineTo(x + r, y + h);
  ctx2.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx2.lineTo(x, y + r);
  ctx2.quadraticCurveTo(x, y, x + r, y);
  ctx2.closePath();
}

// ─── Cursor ────────────────────────────────────────────────────────────

export function updateCursor(e) {
  if (state.spaceDown) { canvas.style.cursor = ptr.isPanning ? 'grabbing' : 'grab'; return; }
  if (ptr.isDragging) { canvas.style.cursor = 'move'; return; }
  if (state.hoverLine && state.lineMode === 'status') { canvas.style.cursor = 'pointer'; return; }
  if (e) {
    const hit = hitNode(mouseToWorld(e).x, mouseToWorld(e).y);
    if (hit && isSelected(hit)) { canvas.style.cursor = 'move'; return; }
  }
  canvas.style.cursor = 'crosshair';
}

// ─── Geometry (shared with interactions) ────────────────────────────────

export function pointToSegmentDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, lenSq = dx * dx + dy * dy;
  if (lenSq === 0) { const ex = px - ax, ey = py - ay; return { dist: Math.sqrt(ex*ex+ey*ey), cx: ax, cy: ay }; }
  let t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx, cy = ay + t * dy;
  const ex = px - cx, ey = py - cy;
  return { dist: Math.sqrt(ex*ex+ey*ey), cx, cy };
}

export function findNearestLine(wx, wy, threshold) {
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

export function hitNode(wx, wy) {
  for (let i = state.nodes.length - 1; i >= 0; i--) {
    const n = state.nodes[i], r = nodeRadius(n) + 4;
    if ((wx - n.x)**2 + (wy - n.y)**2 <= r * r) return n;
  }
  return null;
}

export function hitIsland(wx, wy) {
  const nets = state.networks || [];
  for (let i = nets.length - 1; i >= 0; i--) {
    if (!nets[i].valid) continue;
    const bb = nets[i].boundingBox;
    if (!bb) continue;
    const headerH = 30;
    if (wx >= bb.x && wx <= bb.x + bb.w && wy >= bb.y && wy <= bb.y + headerH) {
      return { net: nets[i], isHeader: true };
    }
    if (wx >= bb.x && wx <= bb.x + bb.w && wy >= bb.y && wy <= bb.y + bb.h) {
      return { net: nets[i], isHeader: false };
    }
  }
  return null;
}

// ─── Charts ────────────────────────────────────────────────────────────

export function drawFreqChart() {
  const cvs = document.getElementById('freq-chart');
  if (!cvs || !state.freqChartVisible) return;
  const w = cvs.width, h = cvs.height;
  const ctx2 = cvs.getContext('2d');
  ctx2.clearRect(0, 0, w, h);

  const maxPts = 200;
  const data = sim.dataBuffer.slice(-maxPts);
  if (data.length < 2) {
    ctx2.fillStyle = '#999'; ctx2.font = '12px sans-serif'; ctx2.textAlign = 'center';
    ctx2.fillText('Waiting for data…', w / 2, h / 2);
    return;
  }

  const padding = { top: 20, bottom: 20, left: 50, right: 10 };
  const cw = w - padding.left - padding.right, ch = h - padding.top - padding.bottom;
  const yMin = 49, yMax = 51, yRange = yMax - yMin;

  // Background
  ctx2.fillStyle = '#f9f7f3'; ctx2.fillRect(0, 0, w, h);
  ctx2.strokeStyle = '#ddd'; ctx2.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = padding.top + ch - (i / 4) * ch;
    ctx2.beginPath(); ctx2.moveTo(padding.left, y); ctx2.lineTo(w - padding.right, y); ctx2.stroke();
    ctx2.fillStyle = '#999'; ctx2.font = '10px sans-serif'; ctx2.textAlign = 'right';
    ctx2.fillText((yMin + i / 4 * yRange).toFixed(2), padding.left - 5, y + 3);
  }

  // Plot all network freqs
  for (let ni = 0; ni < state.networks.length; ni++) {
    const net = state.networks[ni];
    const color = ISLAND_COLORS[ni % ISLAND_COLORS.length];
    ctx2.strokeStyle = color; ctx2.lineWidth = 1.5; ctx2.beginPath();
    for (let i = 0; i < data.length; i++) {
      const d = data[i];
      let f;
      if (state.selectedNetworkId !== 'all' && d.networks && d.networks[state.selectedNetworkId] !== undefined) {
        f = d.networks[state.selectedNetworkId];
      } else {
        f = d.frequency;
      }
      const x = padding.left + (i / (data.length - 1)) * cw;
      const y = padding.top + ch - ((f - yMin) / yRange) * ch;
      if (i === 0) ctx2.moveTo(x, y); else ctx2.lineTo(x, y);
    }
    ctx2.stroke();
  }

  // Current value line + label
  const lastFreq = state.selectedNetworkId !== 'all' && state.networks.length > 0
    ? (state.networks.find(n => n.id === state.selectedNetworkId)?.freq || 50)
    : state.frequency;
  ctx2.strokeStyle = '#c0392b'; ctx2.lineWidth = 1; ctx2.setLineDash([3, 3]);
  const lastY = padding.top + ch - ((lastFreq - yMin) / yRange) * ch;
  ctx2.beginPath(); ctx2.moveTo(padding.left, lastY); ctx2.lineTo(w - padding.right, lastY); ctx2.stroke(); ctx2.setLineDash([]);
  ctx2.fillStyle = '#c0392b'; ctx2.font = 'bold 11px sans-serif'; ctx2.textAlign = 'left';
  ctx2.fillText(lastFreq.toFixed(3) + ' Hz', w - padding.right - 80, lastY - 4);
}

export function drawMeritOrderChart() {
  const cvs = document.getElementById('merit-chart');
  if (!cvs || !state.meritChartVisible) return;
  const w = cvs.width, h = cvs.height;
  const ctx2 = cvs.getContext('2d');
  ctx2.clearRect(0, 0, w, h);

  const gens = state.nodes.filter(n => n.type === 'generator' && !n.tripped);
  if (gens.length === 0) {
    ctx2.fillStyle = '#999'; ctx2.font = '12px sans-serif'; ctx2.textAlign = 'center';
    ctx2.fillText('No generators in grid', w / 2, h / 2);
    return;
  }

  const padding = { top: 20, bottom: 30, left: 60, right: 10 };
  const cw = w - padding.left - padding.right, ch = h - padding.top - padding.bottom;

  ctx2.fillStyle = '#f9f7f3'; ctx2.fillRect(0, 0, w, h);

  const sorted = gens.filter(g => g.mode !== 'fixed').sort((a, b) => a.bidPrice - b.bidPrice);
  const fixedGens = gens.filter(g => g.mode === 'fixed');
  const maxPrice = Math.max(200, ...gens.map(g => g.bidPrice || 50));
  const totalLoad = state.nodes.filter(n => n.type === 'load').reduce((s, l) => s + (l.mw || 0), 0);

  let x = padding.left, cumMW = 0;
  const totalFixed = fixedGens.reduce((s, g) => s + Math.min(g.baselineContract || 0, g.rating || 100), 0);
  if (totalFixed > 0) {
    const bw = (totalFixed / Math.max(totalLoad, 1)) * cw;
    ctx2.fillStyle = '#bbb'; ctx2.fillRect(x, padding.top, Math.max(bw, 2), ch);
    ctx2.fillStyle = '#555'; ctx2.font = '9px sans-serif'; ctx2.textAlign = 'left';
    ctx2.fillText('Fixed', x, padding.top - 2);
  }

  for (const gen of sorted) {
    const qty = gen.bidQty || gen.rating || 100;
    const bw = Math.max(1, (qty / Math.max(totalLoad, 1)) * cw);
    const price = gen.bidPrice || 50;
    const h2 = (price / maxPrice) * ch;
    const isDispatched = (gen.baselineContract || 0) > 0;
    ctx2.fillStyle = isDispatched ? '#5a8a5a' : '#ddd';
    ctx2.fillRect(x, padding.top + ch - h2, bw, h2);
    if (bw > 15) {
      ctx2.fillStyle = '#fff'; ctx2.font = '9px sans-serif'; ctx2.textAlign = 'center';
      ctx2.fillText('$' + price, x + bw / 2, padding.top + ch - h2 + 12);
    }
    x += bw;
  }
}
