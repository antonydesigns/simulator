// ─── Renderer — canvas drawing, coordinates, cursor ────────────────

export class Renderer {
  constructor(store) {
    this.store = store;
  }

  resizeCanvas() {
    const { state, sim, ptr, canvas, ctx, ISLAND_COLORS, GRID_SIZE, NODE_RADIUS, JUNCTION_RADIUS } = this.store;
  
  const dpr = window.devicePixelRatio || 1;
  canvas.width = window.innerWidth * dpr;
  canvas.height = window.innerHeight * dpr;
  canvas.style.width = window.innerWidth + 'px';
  canvas.style.height = window.innerHeight + 'px';
  this.draw();
}

  screenToWorld(sx, sy) {
    const { state, sim, ptr, canvas, ctx, ISLAND_COLORS, GRID_SIZE, NODE_RADIUS, JUNCTION_RADIUS } = this.store;
   return { x: (sx - state.view.x) / state.view.scale, y: (sy - state.view.y) / state.view.scale }; }

  worldToScreen(wx, wy) {
    const { state, sim, ptr, canvas, ctx, ISLAND_COLORS, GRID_SIZE, NODE_RADIUS, JUNCTION_RADIUS } = this.store;
   return { x: wx * state.view.scale + state.view.x, y: wy * state.view.scale + state.view.y }; }

  mouseToWorld(e) {
    const { state, sim, ptr, canvas, ctx, ISLAND_COLORS, GRID_SIZE, NODE_RADIUS, JUNCTION_RADIUS } = this.store;
   const r = canvas.getBoundingClientRect(); return this.screenToWorld(e.clientX - r.left, e.clientY - r.top); }

  mouseToScreen(e) {
    const { state, sim, ptr, canvas, ctx, ISLAND_COLORS, GRID_SIZE, NODE_RADIUS, JUNCTION_RADIUS } = this.store;
   const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }

  nodeRadius(n) {
    const { state, sim, ptr, canvas, ctx, ISLAND_COLORS, GRID_SIZE, NODE_RADIUS, JUNCTION_RADIUS } = this.store;
   return n.type === 'junction' ? JUNCTION_RADIUS : NODE_RADIUS; }

  isSelected(n) {
    const { state, sim, ptr, canvas, ctx, ISLAND_COLORS, GRID_SIZE, NODE_RADIUS, JUNCTION_RADIUS } = this.store;
   return state.selectedNodeIds.has(n.id); }

  drawGrid() {
    const { state, sim, ptr, canvas, ctx, ISLAND_COLORS, GRID_SIZE, NODE_RADIUS, JUNCTION_RADIUS } = this.store;
  
  const v = state.view;
  const tl = this.screenToWorld(0, 0), br = this.screenToWorld(window.innerWidth, window.innerHeight);
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

  drawConnections() {
    const { state, sim, ptr, canvas, ctx, ISLAND_COLORS, GRID_SIZE, NODE_RADIUS, JUNCTION_RADIUS } = this.store;
  
  for (const c of state.connections) {
    const s = state.nodes.find(n => n.id === c.sourceId);
    const t = state.nodes.find(n => n.id === c.targetId);
    if (!s || !t) continue;
    const p = this.worldToScreen(s.x, s.y), q = this.worldToScreen(t.x, t.y);
    
    const sameNet = state.networks && state.networks.some(net => net.nodeIds.has(s.id) && net.nodeIds.has(t.id));

    // Tripped line — dashed grey, skip color/progress
    if (c.tripped) {
      const mx = (p.x + q.x) / 2, my = (p.y + q.y) / 2;
      ctx.beginPath();
      ctx.strokeStyle = '#999';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([6, 4]);
      ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y); ctx.stroke();
      ctx.setLineDash([]);
      // Dashed "X" mark at midpoint
      const siz = 4 * state.view.scale;
      ctx.strokeStyle = '#666'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(mx - siz, my - siz); ctx.lineTo(mx + siz, my + siz); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(mx + siz, my - siz); ctx.lineTo(mx - siz, my + siz); ctx.stroke();
      continue;
    }

    // Color by loading %
    let color = '#7a766e';
    let lineWidth = sameNet ? 2 : 1.5;
    if (sameNet && c.loadingPct !== undefined) {
      if (c.loadingPct > 120) color = '#8b0000';
      else if (c.loadingPct > 100) color = '#c0392b';
      else if (c.loadingPct > 80) color = '#e67e22';
      else if (c.loadingPct > 60) color = '#d4a017';
    } else if (!sameNet) {
      color = '#c0392b';
    }
    
    // Highlight on hover in status mode — thicker but same color
    const isHovered = state.hoverLine && state.hoverLine.conn && state.hoverLine.conn.id === c.id;
    if (isHovered && state.lineMode === 'status') {
      lineWidth = 4;
    }
    
    // Selected connection highlight (overrides hover)
    if (state.selectedConnIds && state.selectedConnIds.has(c.id)) {
      ctx.shadowColor = '#ffd700';
      ctx.shadowBlur = 6;
      lineWidth = 4;
    }
    
    ctx.beginPath();
    ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth;
    if (!sameNet) ctx.setLineDash([4, 4]);
    ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y); ctx.stroke();
    ctx.setLineDash([]);
    ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0;

    // Trip progress bar at midpoint (only overloaded lines)
    if (sameNet && c.loadingPct !== undefined && c.loadingPct > 100 && state.view.scale > 0.5) {
      const mx = (p.x + q.x) / 2, my = (p.y + q.y) / 2;
      const barW = 30 * state.view.scale, barH = 4 * state.view.scale;
      const tripTime = c.tripTimer || 0;
      // Determine max time based on loading
      let maxTime = 10;
      if (c.loadingPct >= 200) maxTime = 0.5;
      else if (c.loadingPct >= 150) maxTime = 2;
      else if (c.loadingPct >= 120) maxTime = 5;
      const pct = Math.min(1, tripTime / maxTime);
      ctx.fillStyle = 'rgba(0,0,0,0.25)';
      ctx.beginPath(); ctx.roundRect(mx - barW / 2, my + 6 * state.view.scale, barW, barH, 2); ctx.fill();
      ctx.fillStyle = pct > 0.8 ? '#c0392b' : '#e67e22';
      ctx.beginPath(); ctx.roundRect(mx - barW / 2, my + 6 * state.view.scale, barW * pct, barH, 2); ctx.fill();
    }
  }
}

  drawNodes() {
    const { state, sim, ptr, canvas, ctx, ISLAND_COLORS, GRID_SIZE, NODE_RADIUS, JUNCTION_RADIUS } = this.store;
  
  const v = state.view;
  for (const node of state.nodes) {
    const p = this.worldToScreen(node.x, node.y);
    const baseR = this.nodeRadius(node), r = baseR * v.scale;
    const sel = this.isSelected(node), pend = node.id === state.pendingSourceId;

    if (pend) {
      ctx.beginPath(); ctx.arc(p.x, p.y, r + 8, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(122, 158, 192, 0.10)'; ctx.fill();
    }

    let fillColor;
    if (node.type === 'generator') fillColor = node.mode === 'fixed' ? '#8aaa7a' : '#6aaa64';
    else if (node.type === 'storage') fillColor = '#5a8fbb';
    else if (node.type === 'junction') fillColor = '#b0aca2';
    else fillColor = '#ca9440';

    ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fillStyle = fillColor; ctx.fill();
    ctx.strokeStyle = sel || pend ? '#7a9ec0' : '#8a867e';
    ctx.lineWidth = (sel || pend) ? 3 : 1.5; 
    if (node.mode === 'fixed') ctx.setLineDash([3, 3]);
    ctx.stroke();
    ctx.setLineDash([]);

    // Tripped generator or storage: red X overlay
    if (node.tripped && (node.type === 'generator' || node.type === 'storage')) {
      const s = r * 0.6;
      ctx.strokeStyle = '#c0392b'; ctx.lineWidth = 2.5;
      ctx.beginPath(); ctx.moveTo(p.x - s, p.y - s); ctx.lineTo(p.x + s, p.y + s); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(p.x + s, p.y - s); ctx.lineTo(p.x - s, p.y + s); ctx.stroke();
    }

    const ls = Math.max(10, 11 * v.scale);
    ctx.fillStyle = '#6a665e';
    ctx.font = `${ls}px -apple-system, BlinkMacSystemFont, sans-serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';

    let label = node.shortId || (() => {
      const t = node.type === 'generator' ? 'G' : node.type === 'storage' ? 'S' : node.type === 'junction' ? 'J' : 'L';
      return t + (node.label || node.id.slice(-4));
    })();
    if (node.mode === 'fixed') label += ' 🔒';
    ctx.fillText(label, p.x, p.y + r + 4);

    if (node.type !== 'junction' && node.mw !== undefined) {
      const ms = Math.max(9, 10 * v.scale);
      ctx.fillStyle = '#8a867e';
      ctx.font = `${ms}px -apple-system, BlinkMacSystemFont, sans-serif`;
      ctx.textBaseline = 'top';
      if (node.type === 'storage') {
        const mwResp = node.mwResponse || 0;
        const pw = mwResp >= 0 ? '+' : '';
        ctx.fillText(pw + Math.round(mwResp) + ' MW', p.x, p.y + r + 4 + ls + 2);
        ctx.fillText((node.mw || 0).toFixed(2) + ' MWh', p.x, p.y + r + 4 + ls * 2 + 4);
      } else {
        ctx.fillText(Math.round(node.mw) + ' MW', p.x, p.y + r + 4 + ls + 2);
      }
    }
    // Load shedding badge
    if (node.type === 'load' && (node.shedPct || 0) > 0) {
      const ms = Math.max(8, 9 * v.scale);
      ctx.fillStyle = '#e67e22';
      ctx.font = `bold ${ms}px -apple-system, BlinkMacSystemFont, sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
      ctx.fillText('SHD ' + Math.round((node.shedPct || 0) * 100) + '%', p.x, p.y - r - 2);
    }
  }
}

  roundRect(x, y, w, h, r) {
    const { state, sim, ptr, canvas, ctx, ISLAND_COLORS, GRID_SIZE, NODE_RADIUS, JUNCTION_RADIUS } = this.store;
  
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

  drawFrequencyHud() {
    const { state, sim, ptr, canvas, ctx, ISLAND_COLORS, GRID_SIZE, NODE_RADIUS, JUNCTION_RADIUS } = this.store;
  
  const networks = state.networks && state.networks.length > 0 ? state.networks : [{ id: 'net_0', freq: state.frequency, nodeIds: new Set(state.nodes.map(n => n.id)) }];
  const pad = 14, bw = 170, bh = 48;
  const rx = window.innerWidth - bw - pad;
  let ry = pad;
  
  // Count gens per network for compact label
  for (const net of networks) {
    const netNodes = [...net.nodeIds].map(id => state.nodes.find(n => n.id === id)).filter(Boolean);
    const genCount = netNodes.filter(n => n.type === 'generator').length;
    const loadCount = netNodes.filter(n => n.type === 'load').length;
    const freq = net.freq;
    const dev = freq - 50;
    const label = networks.length > 1
      ? (genCount + loadCount > 0 ? genCount + 'G ' + loadCount + 'L' : net.nodeIds.size + ' nodes')
      : '';

    ctx.fillStyle = 'rgba(240, 236, 228, 0.92)';
    ctx.beginPath(); this.roundRect(rx, ry, bw, bh, 8); ctx.fill();
    ctx.strokeStyle = '#d6d2c8'; ctx.lineWidth = 1;
    ctx.beginPath(); this.roundRect(rx, ry, bw, bh, 8); ctx.stroke();

    // Frequency value — colour shifts when deviating
    ctx.fillStyle = Math.abs(dev) > 0.3 ? '#c0392b' : (Math.abs(dev) > 0.1 ? '#d4891a' : '#5a7a5a');
    ctx.font = 'bold 24px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(freq.toFixed(2) + ' Hz', rx + bw / 2, ry + bh / 2 - 4);

    ctx.fillStyle = '#8a867e';
    ctx.font = '10px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.textBaseline = 'top';
    const sign = dev > 0 ? '+' : '';
    ctx.fillText(label || (sign + dev.toFixed(3) + ' Hz deviation'), rx + bw / 2, ry + bh / 2 + 12);

    ry += bh + 4;
  }

  // Wholesale price (SMP) display
  if (state.smp !== null) {
    ctx.fillStyle = 'rgba(240, 236, 228, 0.92)';
    ctx.beginPath(); this.roundRect(rx, ry, bw, bh, 8); ctx.fill();
    ctx.strokeStyle = '#d6d2c8'; ctx.lineWidth = 1;
    ctx.beginPath(); this.roundRect(rx, ry, bw, bh, 8); ctx.stroke();
    ctx.fillStyle = '#2c7a2c';
    ctx.font = 'bold 24px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('$' + state.smp.toFixed(1) + '/MWh', rx + bw / 2, ry + bh / 2 - 2);
    ctx.fillStyle = '#8a867e';
    ctx.font = '10px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.textBaseline = 'top';
    ctx.fillText(state.marketLoad.toFixed(0) + ' MW load', rx + bw / 2, ry + bh / 2 + 12);
    ry += bh + 4;
  }
}

  drawPendingLine() {
    const { state, sim, ptr, canvas, ctx, ISLAND_COLORS, GRID_SIZE, NODE_RADIUS, JUNCTION_RADIUS } = this.store;
  
  if (!state.pendingSourceId || !ptr.mouseWorld) return;
  const src = state.nodes.find(n => n.id === state.pendingSourceId);
  if (!src) return;
  const s = this.worldToScreen(src.x, src.y), m = this.worldToScreen(ptr.mouseWorld.x, ptr.mouseWorld.y);
  ctx.beginPath(); ctx.setLineDash([6, 4]);
  ctx.strokeStyle = '#7a9ec0'; ctx.lineWidth = 2;
  ctx.moveTo(s.x, s.y); ctx.lineTo(m.x, m.y); ctx.stroke();
  ctx.setLineDash([]);
}

  drawHoverDot() {
    const { state, sim, ptr, canvas, ctx, ISLAND_COLORS, GRID_SIZE, NODE_RADIUS, JUNCTION_RADIUS } = this.store;
  
  if (!state.hoverLine) return;
  if (state.lineMode === 'junction') {
    const p = this.worldToScreen(state.hoverLine.x, state.hoverLine.y);
    const r = JUNCTION_RADIUS * state.view.scale;
    ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(160,156,148,0.4)'; ctx.fill();
    ctx.strokeStyle = 'rgba(160,156,148,0.5)'; ctx.lineWidth = 1.5; ctx.stroke();
  } else {
    // Status mode — show flow info tooltip
    const conn = state.hoverLine.conn;
    const p = this.worldToScreen(state.hoverLine.x, state.hoverLine.y);
    const flow = conn.mw !== undefined ? Math.abs(conn.mw).toFixed(1) : '?';
    const limit = conn.thermalLimit || 100;
    const pct = conn.loadingPct !== undefined ? conn.loadingPct.toFixed(0) : '?';
    const text = flow + ' / ' + limit + ' MW (' + pct + '%)';
    ctx.font = '11px -apple-system, BlinkMacSystemFont, sans-serif';
    const tw = ctx.measureText(text).width;
    const bx = p.x - tw / 2 - 8, by = p.y - 22;
    ctx.fillStyle = 'rgba(40,40,40,0.85)';
    ctx.beginPath(); ctx.roundRect(bx, by, tw + 16, 20, 4); ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(text, p.x, by + 10);
  }
}

  drawSelectionRect() {
    const { state, sim, ptr, canvas, ctx, ISLAND_COLORS, GRID_SIZE, NODE_RADIUS, JUNCTION_RADIUS } = this.store;
  
  if (!ptr.isSelecting || !ptr.downScreen || !ptr.mouseScreen) return;
  const x1 = ptr.downScreen.x, y1 = ptr.downScreen.y, x2 = ptr.mouseScreen.x, y2 = ptr.mouseScreen.y;
  const l = Math.min(x1, x2), t = Math.min(y1, y2), w = Math.abs(x2 - x1), h = Math.abs(y2 - y1);
  ctx.beginPath(); ctx.rect(l, t, w, h); ctx.setLineDash([6, 4]);
  ctx.strokeStyle = '#7a9ec0'; ctx.lineWidth = 1.5; ctx.stroke(); ctx.setLineDash([]);
  ctx.fillStyle = 'rgba(122,158,192,0.06)'; ctx.fillRect(l, t, w, h);
}

  drawStrandedIndicators() {
    const { state, sim, ptr, canvas, ctx, ISLAND_COLORS, GRID_SIZE, NODE_RADIUS, JUNCTION_RADIUS } = this.store;
  
  if (!state.strandedLoadIds || state.strandedLoadIds.size === 0) return;
  const blink = Math.sin(Date.now() / 300) > 0;
  const dpr = window.devicePixelRatio || 1;
  const ww = window.innerWidth, wh = window.innerHeight;
  const pad = 40;

  for (const id of state.strandedLoadIds) {
    const load = state.nodes.find(n => n.id === id);
    if (!load) continue;
    const sp = this.worldToScreen(load.x, load.y);
    const onScreen = sp.x >= 0 && sp.x <= ww && sp.y >= 0 && sp.y <= wh;

    if (onScreen) {
      // Warning sign at top-right of the node (not on top of it)
      if (blink) {
        ctx.font = '18px -apple-system, BlinkMacSystemFont, sans-serif';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillStyle = '#e74c3c';
        ctx.fillText('⚠', sp.x + 24, sp.y - 20);
      }
    } else {
      // Off-screen: triangle arrow at edge pointing toward node + ⚠
      const angle = Math.atan2(load.y - state.view.y / state.view.scale, load.x - state.view.x / state.view.scale);
      let ex = ww / 2, ey = wh / 2;
      const cosA = Math.cos(angle), sinA = Math.sin(angle);
      const t = Math.min(
        cosA > 0 ? (ww - pad - ex) / cosA : cosA < 0 ? -(ex - pad) / -cosA : Infinity,
        sinA > 0 ? (wh - pad - ey) / sinA : sinA < 0 ? -(ey - pad) / -sinA : Infinity
      );
      if (!isFinite(t)) continue;
      ex += cosA * t; ey += sinA * t;

      // Draw triangle arrowhead pointing toward the node
      const arrowSize = 16;
      const perpX = Math.cos(angle + Math.PI / 2);
      const perpY = Math.sin(angle + Math.PI / 2);
      ctx.fillStyle = '#e74c3c';
      ctx.beginPath();
      // Tip points toward the node; base is behind with two wings
      ctx.moveTo(ex + cosA * arrowSize, ey + sinA * arrowSize);
      ctx.lineTo(ex - cosA * arrowSize * 0.6 + perpX * arrowSize * 0.45, ey - sinA * arrowSize * 0.6 + perpY * arrowSize * 0.45);
      ctx.lineTo(ex - cosA * arrowSize * 0.6 - perpX * arrowSize * 0.45, ey - sinA * arrowSize * 0.6 - perpY * arrowSize * 0.45);
      ctx.closePath();
      ctx.fill();

      // Flashing ⚠ next to the arrow (offset slightly behind and to the side)
      if (blink) {
        ctx.font = '16px -apple-system, BlinkMacSystemFont, sans-serif';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillStyle = '#e74c3c';
        ctx.fillText('⚠', ex - cosA * arrowSize * 2.2 - perpX * 6, ey - sinA * arrowSize * 2.2 - perpY * 6);
      }
    }
  }
}

  drawLoadCurvePreview(previewCanvas, node) {
    const { state, sim, ptr, ctx, ISLAND_COLORS, GRID_SIZE, NODE_RADIUS, JUNCTION_RADIUS } = this.store;
  
  if (!canvas || !node) return;
  const w = 320, h = 80;
  const cx = previewCanvas.getContext('2d');
  const pad = { top: 8, bottom: 15, left: 28, right: 8 };
  const pw = w - pad.left - pad.right, ph = h - pad.top - pad.bottom;

  cx.clearRect(0, 0, w, h);
  cx.fillStyle = '#faf7f0';
  cx.fillRect(0, 0, w, h);

  const minMw = node.noiseMin || 100, maxMw = node.noiseMax || 200;
  const range = maxMw - minMw || 1;

  // Draw min/max reference lines
  cx.strokeStyle = '#ddd8ce'; cx.lineWidth = 1; cx.setLineDash([3, 3]);
  cx.beginPath(); cx.moveTo(pad.left, pad.top + ph); cx.lineTo(w - pad.right, pad.top + ph); cx.stroke();
  cx.beginPath(); cx.moveTo(pad.left, pad.top); cx.lineTo(w - pad.right, pad.top); cx.stroke();
  cx.setLineDash([]);

  // Labels
  cx.fillStyle = '#999'; cx.font = '9px -apple-system, sans-serif'; cx.textAlign = 'right';
  cx.textBaseline = 'bottom'; cx.fillText(maxMw + ' MW', pad.left - 2, pad.top + 1);
  cx.textBaseline = 'top'; cx.fillText(minMw + ' MW', pad.left - 2, pad.top + ph - 1);

  // Draw the daily curve (weekday solid, weekend dashed overlay)
  const daySteps = 240; // 24h × 10 samples
  const day = 86400;

  // Weekday curve
  cx.strokeStyle = '#6aaa64'; cx.lineWidth = 2;
  cx.beginPath();
  for (let i = 0; i <= daySteps; i++) {
    const hour = (i / daySteps) * 24;
    const todSec = (hour / 24) * day;
    const mult = engine.demandCurve(todSec);
    const mw = minMw + range * mult;
    const x = pad.left + (i / daySteps) * pw;
    const y = pad.top + ph - ((mw - minMw) / range) * ph;
    i === 0 ? cx.moveTo(x, y) : cx.lineTo(x, y);
  }
  cx.stroke();

  // Weekend curve (dashed overlay)
  cx.strokeStyle = '#4a90d9'; cx.lineWidth = 1.5; cx.setLineDash([4, 4]);
  cx.beginPath();
  for (let i = 0; i <= daySteps; i++) {
    const hour = (i / daySteps) * 24;
    const todSec = (hour / 24) * day + 5 * day;
    const mult = engine.demandCurve(todSec);
    const mw = minMw + range * mult;
    const x = pad.left + (i / daySteps) * pw;
    const y = pad.top + ph - ((mw - minMw) / range) * ph;
    i === 0 ? cx.moveTo(x, y) : cx.lineTo(x, y);
  }
  cx.stroke();
  cx.setLineDash([]);

  // Current position (if simulation is running)
  if (sim.simTime > 0) {
    const patSec = sim.simTime * 720;
    const curHour = (((patSec % day) / day) * 24 + 24) % 24;
    const curMult = engine.demandCurve(patSec);
    const curMw = minMw + range * curMult;
    const cx2 = pad.left + (curHour / 24) * pw;
    const cy = pad.top + ph - ((curMw - minMw) / range) * ph;

    // Vertical line
    cx.strokeStyle = 'rgba(231,76,60,0.5)'; cx.lineWidth = 1;
    cx.beginPath(); cx.moveTo(cx2, pad.top); cx.lineTo(cx2, pad.top + ph); cx.stroke();

    // Dot
    cx.fillStyle = '#e74c3c';
    cx.beginPath(); cx.arc(cx2, cy, 4, 0, Math.PI * 2); cx.fill();

    // Hour label
    cx.fillStyle = '#e74c3c'; cx.font = '9px -apple-system, sans-serif'; cx.textAlign = 'center'; cx.textBaseline = 'top';
    cx.fillText(Math.floor(curHour).toString().padStart(2,'0') + ':00', cx2, pad.top + ph + 2);
  }

  // Hour ticks
  cx.fillStyle = '#bbb'; cx.font = '8px -apple-system, sans-serif'; cx.textAlign = 'center'; cx.textBaseline = 'top';
  for (let h = 0; h <= 24; h += 6) {
    const x = pad.left + (h / 24) * pw;
    cx.fillText(h.toString().padStart(2,'0') + ':00', x, pad.top + ph + 2);
  }
}

  draw() {
    const { state, sim, ptr, canvas, ctx, ISLAND_COLORS, GRID_SIZE, NODE_RADIUS, JUNCTION_RADIUS } = this.store;
  
  const dpr = window.devicePixelRatio || 1;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
  this.drawGrid(); this.drawIslands(); this.drawConnections(); this.drawNodes(); this.drawPendingLine(); this.drawHoverDot(); this.drawSelectionRect(); this.drawStrandedIndicators();

  // Redraw load preview canvases (updates position marker)
  if (sim.simTime > 0) {
    for (const c of document.querySelectorAll('.demand-preview')) {
      const id = c.getAttribute('data-node-id');
      const node = state.nodes.find(n => n.id === id);
      if (node) this.drawLoadCurvePreview(c, node);
    }
  }
}

  drawIslands() {
    const { state, sim, ptr, canvas, ctx, ISLAND_COLORS, GRID_SIZE, NODE_RADIUS, JUNCTION_RADIUS } = this.store;
  
  const nets = state.networks || [];
  const isHovered = id => (id === this.store.hoveredIslandId && this.store.hoveredIslandHeader) || id === this.store.selectedNetworkId;

  for (const net of nets) {
    if (!net.valid) continue;
    const bb = net.boundingBox;
    if (!bb || bb.w < 1 || bb.h < 1) continue;

    const tl = this.worldToScreen(bb.x, bb.y);
    const br = this.worldToScreen(bb.x + bb.w, bb.y + bb.h);
    const w = br.x - tl.x, h = br.y - tl.y;
    if (br.x < -200 || br.y < -200 || tl.x > window.innerWidth + 200 || tl.y > window.innerHeight + 200) continue;

    const color = net.color || ISLAND_COLORS[0];
    const showFull = isHovered(net.id);
    const headerH = 28;

    if (showFull) {
      // Full bounding box: fill + outline
      ctx.fillStyle = color + '0d';
      ctx.strokeStyle = color + '50';
      ctx.lineWidth = net.id === this.store.selectedNetworkId ? 2.5 : 1.5;
      ctx.setLineDash(net.id === this.store.selectedNetworkId ? [] : [4, 4]);
      ctx.beginPath(); this.roundRectCtx(ctx, tl.x, tl.y, w, h, 14); ctx.fill(); ctx.stroke();
      ctx.setLineDash([]);
    }

    // Header bar (always drawn)
    ctx.fillStyle = color + '25';
    ctx.beginPath(); this.roundRectCtx(ctx, tl.x, tl.y, w, headerH, 14); ctx.fill();

    // Name + frequency label
    const label = (net.id === this.store.selectedNetworkId ? '▶ ' : '🏝 ') + (net.customName || net.id);
    const freq = net.freq !== undefined ? net.freq.toFixed(2) : '—';

    // Figure out direction arrow
    let arrow = '';
    if (net.freqPrev !== undefined && net.freq !== undefined) {
      const diff = net.freq - net.freqPrev;
      if (diff > 0.005) arrow = '▲';
      else if (diff < -0.005) arrow = '▼';
      else arrow = '▸';
    }

    const freqLabel = freq + ' Hz ' + arrow;

    ctx.textBaseline = 'middle';

    // Name on left
    ctx.fillStyle = '#444';
    ctx.font = '12px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(label, tl.x + 10, tl.y + headerH / 2);

    // Frequency + arrow on right
    const dev = (net.freq || 50) - 50;
    const freqColor = Math.abs(dev) > 0.3 ? '#c0392b' : (Math.abs(dev) > 0.1 ? '#d4891a' : '#5a7a5a');
    ctx.fillStyle = freqColor;
    ctx.font = 'bold 12px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(freqLabel, tl.x + w - 10, tl.y + headerH / 2);
  }
}

  roundRectCtx(ctx, x, y, w, h, r) {
    const { state, sim, ptr, canvas, ISLAND_COLORS, GRID_SIZE, NODE_RADIUS, JUNCTION_RADIUS } = this.store;
  
  if (typeof r === 'object') {
    const { tl, tr, bl, br } = r;
    ctx.moveTo(x + tl, y);
    ctx.lineTo(x + w - tr, y);
    ctx.arcTo(x + w, y, x + w, y + tr, tr);
    ctx.lineTo(x + w, y + h - br);
    ctx.arcTo(x + w, y + h, x + w - br, y + h, br);
    ctx.lineTo(x + bl, y + h);
    ctx.arcTo(x, y + h, x, y + h - bl, bl);
    ctx.lineTo(x, y + tl);
    ctx.arcTo(x, y, x + tl, y, tl);
    return;
  }
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h - r);
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h);
  ctx.arcTo(x, y + h, x, y + h - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
}

  updateCursor(e) {
    const { state, sim, ptr, canvas, ctx, ISLAND_COLORS, GRID_SIZE, NODE_RADIUS, JUNCTION_RADIUS } = this.store;
  
  if (state.spaceDown) { canvas.style.cursor = ptr.isPanning ? 'grabbing' : 'grab'; return; }
  if (ptr.isDragging) { canvas.style.cursor = 'move'; return; }
  if (state.hoverLine && state.lineMode === 'status') { canvas.style.cursor = 'pointer'; return; }
  if (e) {
    const hit = this.hitNode(this.mouseToWorld(e).x, this.mouseToWorld(e).y);
    if (hit && this.isSelected(hit)) { canvas.style.cursor = 'move'; return; }
  }
  canvas.style.cursor = 'crosshair';
}

  pointToSegmentDist(px, py, ax, ay, bx, by) {
    const { state, sim, ptr, canvas, ctx, ISLAND_COLORS, GRID_SIZE, NODE_RADIUS, JUNCTION_RADIUS } = this.store;
  
  const dx = bx - ax, dy = by - ay, lenSq = dx * dx + dy * dy;
  if (lenSq === 0) { const ex = px - ax, ey = py - ay; return { dist: Math.sqrt(ex*ex+ey*ey), cx: ax, cy: ay }; }
  let t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx, cy = ay + t * dy;
  const ex = px - cx, ey = py - cy;
  return { dist: Math.sqrt(ex*ex+ey*ey), cx, cy };
}

  findNearestLine(wx, wy, threshold) {
    const { state, sim, ptr, canvas, ctx, ISLAND_COLORS, GRID_SIZE, NODE_RADIUS, JUNCTION_RADIUS } = this.store;
  
  let best = null, bestDist = threshold;
  for (const conn of state.connections) {
    const src = state.nodes.find(n => n.id === conn.sourceId);
    const tgt = state.nodes.find(n => n.id === conn.targetId);
    if (!src || !tgt) continue;
    const r = this.pointToSegmentDist(wx, wy, src.x, src.y, tgt.x, tgt.y);
    if (r.dist < bestDist) {
      const dS = Math.sqrt((r.cx - src.x)**2 + (r.cy - src.y)**2);
      const dT = Math.sqrt((r.cx - tgt.x)**2 + (r.cy - tgt.y)**2);
      if (dS > this.nodeRadius(src) + 4 && dT > this.nodeRadius(tgt) + 4) { bestDist = r.dist; best = { x: r.cx, y: r.cy, conn }; }
    }
  }
  return best;
}

  hitNode(wx, wy) {
    const { state, sim, ptr, canvas, ctx, ISLAND_COLORS, GRID_SIZE, NODE_RADIUS, JUNCTION_RADIUS } = this.store;
  
  for (let i = state.nodes.length - 1; i >= 0; i--) {
    const n = state.nodes[i], r = this.nodeRadius(n) + 4;
    if ((wx - n.x)**2 + (wy - n.y)**2 <= r * r) return n;
  }
  return null;
}
}
