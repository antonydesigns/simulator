// ─── StatsPanel — stats, charts ──────────────────────────────────

export class StatsPanel {
  constructor(store) {
    this.store = store;
    this._freqDragX = 0;
    this._freqDragLeft = 0;
    this._meritBars = [];
    this._meritHoverIdx = -1;
  }

  toggleBreakdown(nodeId) {
    const { state } = this.store;
    if (state.statsBreakdownExpanded.has(nodeId)) {
      state.statsBreakdownExpanded.delete(nodeId);
    } else {
      state.statsBreakdownExpanded.add(nodeId);
    }
    this.update();
  }

  update() {
    const { state } = this.store;
    const body = document.getElementById('stats-body');
    if (!body || !this.store.statsPanelVisible) return;

    const nets = state.networks && state.networks.length > 0 ? state.networks : [];
    let html = '';

    if (nets.length > 0) {
      html += '<div class="stats-island-select">';
      html += '<select id="island-select" style="width:100%;padding:4px;font-size:13px;border:1px solid #d6d2c8;border-radius:4px;background:#faf8f4">';
      if (nets.length > 1) {
        html += '<option value="all"' + (this.store.selectedNetworkId === 'all' ? ' selected' : '') + '>All islands</option>';
      }
      for (const net of nets) {
        const netNodes = [...net.nodeIds].map(id => state.nodes.find(n => n.id === id)).filter(Boolean);
        const gCount = netNodes.filter(n => n.type === 'generator').length;
        const lCount = netNodes.filter(n => n.type === 'load').length;
        const sCount = netNodes.filter(n => n.type === 'storage').length;
        let label = net.id;
        const parts = [];
        if (gCount) parts.push(gCount + 'G');
        if (lCount) parts.push(lCount + 'L');
        if (sCount) parts.push(sCount + 'S');
        if (parts.length) label += ' (' + parts.join(', ') + ')';
        html += '<option value="' + net.id + '"' + (this.store.selectedNetworkId === net.id ? ' selected' : '') + '>' + label + '</option>';
      }
      html += '</select>';

      // Black Start buttons + progress
      for (const net of nets) {
        const netNodes = [...net.nodeIds].map(id => state.nodes.find(n => n.id === id)).filter(Boolean);
        const gfStorages = netNodes.filter(n => n.type === 'storage' && n.mode === 'grid-forming' && (n.mw || 0) > 0.5);
        const anyOnlineGens = netNodes.filter(n => n.type === 'generator' && !n.tripped);
        const anyOnlineNonGfsStor = netNodes.filter(n => n.type === 'storage' && n.mode !== 'grid-forming' && !n.tripped);
        const isEligible = gfStorages.length > 0 && anyOnlineGens.length === 0 && anyOnlineNonGfsStor.length === 0 && !net.blackStart;
        if (isEligible) {
          html += '<button class="blackstart-btn" data-net-id="' + net.id + '" style="width:100%;padding:8px;margin-top:6px;background:#e67e22;color:#fff;border:none;border-radius:4px;cursor:pointer;font-weight:bold;font-size:13px">';
          html += '&#9889; Black Start ' + net.id;
          html += '</button>';
        }
        if (net.blackStart) {
          const bs = net.blackStart;
          const pct = Math.round(bs.progress * 100);
          const phaseLabels = { 'gfs-only': 'Energizing bus...', 'gen-restart': 'Restoring gens & loads...', 'handover': 'Handover to market...' };
          const label = phaseLabels[bs.phase] || 'Restoring...';
          html += '<div class="blackstart-progress" style="margin-top:6px;padding:8px;background:#fef5e7;border-radius:4px;text-align:center">';
          html += '<div style="font-size:12px;color:#e67e22;font-weight:bold;margin-bottom:4px">' + label + '</div>';
          html += '<div style="height:8px;background:#f0e6d3;border-radius:4px;overflow:hidden">';
          html += '<div style="height:100%;width:' + pct + '%;background:#e67e22;border-radius:4px;transition:width 0.3s"></div></div>';
          html += '<div style="font-size:11px;color:#888;margin-top:2px">' + pct + '%</div></div>';
        }
      }

      html += '</div>';
    }

    const nodeFilter = this.store.selectedNetworkId === 'all' || !nets.length
      ? n => true
      : n => nets.find(net => net.id === this.store.selectedNetworkId)?.nodeIds.has(n.id);

    const gens = state.nodes.filter(n => n.type === 'generator' && nodeFilter(n));
    const loads = state.nodes.filter(n => n.type === 'load' && nodeFilter(n));
    const storages = state.nodes.filter(n => n.type === 'storage' && nodeFilter(n));
    const totalGen = gens.reduce((s, g) => s + (g.mw || 0), 0);
    const totalLoad = loads.reduce((s, l) => s + (l.mw || 0), 0);
    const totalStor = storages.reduce((s, st) => s + (st.mwResponse || 0), 0);
    const netImbalance = totalGen + totalStor - totalLoad;

    const islandFreq = this.store.selectedNetworkId !== 'all' && nets.length
      ? (nets.find(net => net.id === this.store.selectedNetworkId)?.freq || 50)
      : state.frequency;

    // --- Supply ---
    html += '<div class="stats-section">';
    html += '<div class="stats-section-title">Supply</div>';
    for (const gen of gens) {
      const base = gen.baselineContract || 0;
      const tag = gen.mode === 'fixed' ? '<span class="merchant-tag">LOCK</span>' : (gen.mode === 'fcr-only' ? '<span class="merchant-tag">FCR</span>' : '');
      html += '<div class="stats-row">';
      html += '<span><span class="gen-name">' + (gen.shortId || gen.id.slice(-4)) + '</span>' + tag + '</span>';
      html += '<span class="value">' + Math.round(gen.mw || 0) + ' MW</span>';
      html += '</div>';
      const dev = (islandFreq - 50) / 50;
      const govMod = -(1 / (gen.droop || 0.04)) * dev * (gen.rating || 100);
      const agcComp = gen.agcOffset || 0;
      const genExpanded = state.statsBreakdownExpanded.has(gen.id);
      if (genExpanded) {
        html += '<div class="stats-breakdown-row">';
        html += '<span class="stats-toggle" data-toggle="' + gen.id + '">▼ </span>';
        html += '<span class="stats-breakdown-value">base ' + Math.round(base) + ' + FCR ' + (govMod >= 0 ? '+' : '') + Math.round(govMod) + ' + AGC ' + (agcComp >= 0 ? '+' : '') + Math.round(agcComp) + '</span>';
        html += '</div>';
      } else {
        html += '<div class="stats-breakdown-row">';
        html += '<span class="stats-toggle" data-toggle="' + gen.id + '">▶</span>';
        html += '<span class="stats-breakdown-value"></span>';
        html += '</div>';
      }
    }
    html += '<div class="stats-row total"><span>Total supply</span><span class="value">' + Math.round(totalGen) + ' MW</span></div>';
    html += '</div>';

    // --- Demand ---
    html += '<div class="stats-section">';
    html += '<div class="stats-section-title">Demand</div>';
    for (const load of loads) {
      html += '<div class="stats-row"><span>' + (load.shortId || load.id.slice(-4)) + '</span><span class="value">' + Math.round(load.mw || 0) + ' MW</span></div>';
    }
    html += '<div class="stats-row total"><span>Total demand</span><span class="value">' + Math.round(totalLoad) + ' MW</span></div>';
    html += '</div>';

    // --- Storage ---
    if (storages.length > 0) {
      html += '<div class="stats-section">';
      html += '<div class="stats-section-title">Storage</div>';
      for (const st of storages) {
        const tag = st.mode === 'fixed' ? ' LOCK' : (st.mode === 'idle' ? ' ZZZ' : '');
        const mw = st.mwResponse || 0;
        const dir = mw > 0.5 ? 'discharge' : (mw < -0.5 ? 'charge' : 'idle');
        html += '<div class="stats-row"><span>' + (st.shortId || st.id.slice(-4)) + tag + ' (' + dir + ')</span><span class="value">' + (mw >= 0 ? '+' : '') + Math.round(mw) + ' MW</span></div>';
        html += '<div style="padding-left:12px;font-size:12px;color:#999;">SoC: ' + (st.mw || 0).toFixed(2) + '/' + Math.round(st.maxCapacity || 100) + ' MWh</div>';
        const bc = st.baselineContract || 0;
        const sDev = (islandFreq - 50) / 50;
        const sGovMod = -(1 / (st.droop || 0.04)) * sDev * (st.dischargeRate || 500);
        const sAgc = st.agcOffset || 0;
        const stExpanded = state.statsBreakdownExpanded.has(st.id);
        if (stExpanded) {
          html += '<div class="stats-breakdown-row">';
          html += '<span class="stats-toggle" data-toggle="' + st.id + '">▼ </span>';
          html += '<span class="stats-breakdown-value">base ' + Math.round(bc) + ' + FCR ' + (sGovMod >= 0 ? '+' : '') + Math.round(sGovMod) + ' + AGC ' + (sAgc >= 0 ? '+' : '') + Math.round(sAgc) + '</span>';
          html += '</div>';
        } else {
          html += '<div class="stats-breakdown-row">';
          html += '<span class="stats-toggle" data-toggle="' + st.id + '">▶</span>';
          html += '<span class="stats-breakdown-value"></span>';
          html += '</div>';
        }
      }
      html += '<div class="stats-row total"><span>Net storage</span><span class="value">' + (totalStor >= 0 ? '+' : '') + Math.round(totalStor) + ' MW</span></div>';
      html += '</div>';
    }

    // --- System ---
    html += '<div class="stats-section">';
    html += '<div class="stats-section-title">System</div>';
    if (nets.length > 1 && this.store.selectedNetworkId === 'all') {
      html += '<div class="stats-row"><span>Islands</span><span class="value">' + nets.length + '</span></div>';
    }
    html += '<div class="stats-row"><span>Frequency</span><span class="value">' + islandFreq.toFixed(3) + ' Hz</span></div>';
    const imbClass = netImbalance > 0.5 ? 'positive' : (netImbalance < -0.5 ? 'negative' : '');
    html += '<div class="stats-row"><span>Net imbalance</span><span class="value ' + imbClass + '">' + (netImbalance > 0 ? '+' : '') + netImbalance.toFixed(1) + ' MW</span></div>';
    html += '<div class="stats-row"><span>Rated headroom</span><span class="value">' + gens.reduce((s, g) => s + Math.max(0, (g.rating || 100) - (g.mw || 0)), 0).toFixed(0) + ' MW</span></div>';
    html += '</div>';

    // --- Chart toggle button ---
    html += '<button id="freq-chart-toggle" class="stats-chart-btn">Frequency Graph</button>';

    body.innerHTML = html;

    // Wire up event listeners
    const sel = document.getElementById('island-select');
    if (sel) sel.addEventListener('change', () => { this.store.selectedNetworkId = sel.value; this.update(); });

    // Black start button
    body.querySelectorAll('.blackstart-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const netId = btn.dataset.netId;
        const net = state.networks.find(n => n.id === netId);
        if (!net || net.blackStart) return;
        const netNodes = [...net.nodeIds].map(id => state.nodes.find(n => n.id === id)).filter(Boolean);
        const gfStorages = netNodes.filter(n => n.type === 'storage' && n.mode === 'grid-forming' && (n.mw || 0) > 0.5);
        if (gfStorages.length === 0) return;
        for (const load of netNodes.filter(n => n.type === 'load')) {
          load._preBlackoutBaseMw = load._preBlackoutBaseMw || load.baseMw || load.mw || 0;
        }
        net.blackStart = { progress: 0, phase: 'gfs-only', duration: 15, genOrder: [], currentGenIdx: 0, genRampStartProgress: 0 };
        for (const st of gfStorages) {
          if (st.tripped) { st.tripped = false; st.mwResponse = 0; }
        }
        state.blackStartNets.add(netId);
      });
    });

    // Wire up toggle buttons
    body.querySelectorAll('[data-toggle]').forEach(el => {
      el.addEventListener('click', () => this.toggleBreakdown(el.dataset.toggle));
    });

    // Wire up chart toggle
    const ct = document.getElementById('freq-chart-toggle');
    if (ct) ct.addEventListener('click', () => {
      this.store.freqChartVisible = !this.store.freqChartVisible;
      document.getElementById('freq-chart-panel').classList.toggle('hidden', !this.store.freqChartVisible);
      if (this.store.freqChartVisible) this.drawFreqChart();
    });
  }

  getFreq(d, freqChartSelectedNetworkId) {
    if (freqChartSelectedNetworkId !== 'all' && d.networks && d.networks[freqChartSelectedNetworkId] !== undefined) {
      return d.networks[freqChartSelectedNetworkId];
    }
    return d.frequency;
  }

  _initFreqChart() {
    const canvas = document.getElementById('freq-chart-canvas');
    if (!canvas || canvas.dataset._freqInit) return;
    canvas.dataset._freqInit = '1';

    const sim = this.store.sim;
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const store = this.store;
      const defaultPoints = 250;
      let range = store.freqViewRight || defaultPoints;
      const zoomFactor = e.deltaY > 0 ? 1.2 : 1 / 1.2;
      range = Math.max(20, Math.min(sim.dataBuffer.length, Math.round(range * zoomFactor)));
      store.freqViewRight = range;
      // Keep view anchored at right edge
      store.freqViewLeft = 0;
      this.drawFreqChart();
    }, { passive: false });

    let dragStartX = 0, dragStartLeft = 0;
    canvas.addEventListener('mousedown', (e) => {
      if (e.target.closest('.freq-chart-close')) return;
      dragStartX = e.clientX;
      dragStartLeft = this.store.freqViewLeft || 0;
    });
    document.addEventListener('mousemove', (e) => {
      if (e.buttons !== 1 || dragStartX === 0) return;
      const dx = e.clientX - dragStartX;
      const panel = document.getElementById('freq-chart-panel');
      const pw = (panel ? panel.clientWidth : 400) - 43;
      const store = this.store;
      const range = store.freqViewRight || sim.dataBuffer.length;
      const idxDelta = Math.round((dx / pw) * range);
      store.freqViewLeft = Math.max(0, (store.freqViewLeft || 0) - idxDelta);
      const data = sim.dataBuffer;
      if (store.freqViewLeft + range > data.length) {
        store.freqViewLeft = Math.max(0, data.length - range);
      }
      this.drawFreqChart();
    });
    document.addEventListener('mouseup', () => {
      dragStartX = 0;
    });

    // Scrollbar
    const scrollbar = document.getElementById('freq-scrollbar');
    if (scrollbar) {
      scrollbar.addEventListener('input', () => {
        const data = this.store.sim.dataBuffer;
        const range = this.store.freqViewRight || 250;
        const max = Math.max(0, data.length - range);
        this.store.freqViewLeft = Math.min(max, parseInt(scrollbar.value));
        // Stop auto-follow when user touches scrollbar
        this.drawFreqChart();
      });
    }

    // Hover crosshair
    canvas.addEventListener('mousemove', (e) => {
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      if (mx >= 35 && mx <= canvas.width - 8) {
        canvas.dataset._freqHoverX = mx;
      } else {
        delete canvas.dataset._freqHoverX;
      }
      this.drawFreqChart();
    });
    canvas.addEventListener('mouseleave', () => {
      delete canvas.dataset._freqHoverX;
      this.drawFreqChart();
    });
  }

  drawFreqChart() {
    this._initFreqChart();
    const { state, sim } = this.store;
    const store = this.store;
    const panel = document.getElementById('freq-chart-panel');
    if (!panel || panel.classList.contains('hidden') || !store.freqChartVisible) return;
    const canvas = document.getElementById('freq-chart-canvas');
    if (!canvas) return;
    canvas.width = panel.clientWidth;
    canvas.height = panel.clientHeight;
    const ctx = canvas.getContext('2d');
    const w = panel.clientWidth - 4, h = panel.clientHeight - 4;
    if (w <= 0 || h <= 0) return;
    ctx.save();
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Background
    ctx.fillStyle = '#faf8f4';
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = '#d6d2c8';
    ctx.lineWidth = 0.5;
    ctx.strokeRect(1, 1, w - 2, h - 2);

    const data = sim.dataBuffer;
    if (data.length < 2) { ctx.restore(); return; }

    const padL = 35, padR = 8, padT = 10, padB = 30;
    const pw = w - padL - padR, ph = h - padT - padB;

    // Determine visible range
    const total = data.length;
    const defaultRange = 250;
    let range = store.freqViewRight || defaultRange;
    let viewLeft = store.freqViewLeft || 0;

    // Auto-follow if at right edge
    if (!store.freqViewLeft && total > range) {
      viewLeft = total - range;
    }
    // Clamp
    if (viewLeft + range > total) viewLeft = Math.max(0, total - range);
    if (viewLeft < 0) viewLeft = 0;
    viewLeft = Math.floor(viewLeft);
    const viewEnd = Math.min(total, viewLeft + range);
    const visibleData = data.slice(viewLeft, viewEnd);
    if (visibleData.length < 2) { ctx.restore(); return; }

    // Auto-scale Y-axis based on visible data
    const vals = visibleData.map(d => d.frequency);
    let yMin = Math.min(...vals);
    let yMax = Math.max(...vals);
    // Add margin + ensure 50 Hz is always visible
    const margin = Math.max((yMax - yMin) * 0.15, 0.1);
    yMin = Math.min(yMin - margin, 49.5);
    yMax = Math.max(yMax + margin, 50.5);
    // Round to nice values
    yMin = Math.floor(yMin * 10) / 10;
    yMax = Math.ceil(yMax * 10) / 10;
    if (yMax - yMin < 0.5) { yMin -= 0.25; yMax += 0.25; }
    if (50 < yMin) yMin = 49.5;
    if (50 > yMax) yMax = 50.5;
    store.freqYMin = yMin;
    store.freqYMax = yMax;

    const yScale = ph / (yMax - yMin);

    // 50 Hz reference line
    const y50 = padT + (yMax - 50) * yScale;
    ctx.strokeStyle = '#e0dcd0';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(padL, y50);
    ctx.lineTo(padL + pw, y50);
    ctx.stroke();
    ctx.setLineDash([]);

    // Y-axis labels (5 ticks)
    ctx.fillStyle = '#999';
    ctx.font = '11px sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    const tickStep = (yMax - yMin) / 5;
    for (let t = 0; t <= 5; t++) {
      const val = yMin + t * tickStep;
      const y = padT + (yMax - val) * yScale;
      if (y < padT - 5 || y > padT + ph + 5) continue;
      ctx.fillText(val.toFixed(1), padL - 6, y);
      ctx.strokeStyle = '#e0dcd0';
      ctx.lineWidth = 0.5;
      ctx.beginPath();
      ctx.moveTo(padL - 3, y);
      ctx.lineTo(padL, y);
      ctx.stroke();
      // Grid line
      ctx.strokeStyle = '#e8e4da';
      ctx.lineWidth = 0.5;
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(padL + pw, y);
      ctx.stroke();
    }

    // Plot the line trace
    ctx.strokeStyle = '#4a90d9';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    const xScale = pw / (visibleData.length - 1);
    for (let i = 0; i < visibleData.length; i++) {
      const x = padL + i * xScale;
      const y = padT + (yMax - visibleData[i].frequency) * yScale;
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Current frequency label at the right edge
    const lastVal = visibleData[visibleData.length - 1].frequency;
    const curX = padL + pw;
    const curY = padT + (yMax - lastVal) * yScale;
    ctx.fillStyle = '#333';
    ctx.font = 'bold 11px sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'bottom';
    ctx.fillText(lastVal.toFixed(3) + ' Hz', curX - 4, curY - 4);

    // Update scrollbar
    const scrollbar = document.getElementById('freq-scrollbar');
    if (scrollbar && scrollbar !== document.activeElement) {
      const maxScroll = Math.max(0, total - range);
      scrollbar.max = maxScroll;
      scrollbar.value = Math.min(maxScroll, viewLeft);
    }

    // Time-of-day from sim (matches demandCurve cycle)
    const simDt = (1 / sim.tickHz) * sim.speed;
    const fmtTod = (idx) => {
      const t = idx * simDt;
      const todSec = t % 86400;
      const h = Math.floor(todSec / 3600);
      const m = Math.floor((todSec % 3600) / 60);
      return h.toString().padStart(2, '0') + ':' + m.toString().padStart(2, '0');
    };

    // X-axis baseline
    ctx.strokeStyle = '#bbb';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padL, padT + ph);
    ctx.lineTo(padL + pw, padT + ph);
    ctx.stroke();

    // X-axis time-of-day labels with tick marks (3 evenly spaced)
    ctx.fillStyle = '#555';
    ctx.font = '11px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const labelCount = 3;
    for (let l = 0; l < labelCount; l++) {
      const frac = l / (labelCount - 1);
      const idx = viewLeft + Math.round(frac * (visibleData.length - 1));
      const x = padL + frac * pw;

      // Tick mark
      ctx.strokeStyle = '#bbb';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, padT + ph);
      ctx.lineTo(x, padT + ph + 4);
      ctx.stroke();

      ctx.fillText(fmtTod(idx), x, padT + ph + 6);
    }

    // Time info (time-of-day range)
    ctx.fillStyle = '#666';
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(fmtTod(viewLeft) + ' .. ' + fmtTod(viewEnd - 1) + ' / ' + fmtTod(total - 1), padL + 4, padT + ph + 24);

    // Hover crosshair + tooltip
    const hoverX = canvas.dataset._freqHoverX;
    if (hoverX !== undefined) {
      const hx = parseFloat(hoverX);
      const i = Math.round((hx - padL) / xScale);
      if (i >= 0 && i < visibleData.length) {
        const dp = visibleData[i];
        const freqVal = dp.frequency;
        const chartY = padT + (yMax - freqVal) * yScale;
                const seconds = fmtTod(i);

        // Vertical line
        ctx.strokeStyle = '#e74c3c';
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(hx, padT);
        ctx.lineTo(hx, padT + ph);
        ctx.stroke();
        ctx.setLineDash([]);

        // Tooltip box
        const tooltipW = 130, tooltipH = 42;
        let tooltipX = hx + 8;
        if (tooltipX + tooltipW > padL + pw) tooltipX = hx - tooltipW - 8;
        const tooltipY = padT + 4;
        ctx.fillStyle = 'rgba(40,40,40,0.9)';
        ctx.beginPath();
        ctx.roundRect(tooltipX, tooltipY, tooltipW, tooltipH, 4);
        ctx.fill();

        ctx.fillStyle = '#fff';
        ctx.font = 'bold 12px sans-serif';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.fillText(freqVal.toFixed(3) + ' Hz', tooltipX + 6, tooltipY + 4);
        ctx.font = '11px sans-serif';
        ctx.fillStyle = '#bbb';
        ctx.fillText('t = ' + seconds, tooltipX + 6, tooltipY + 21);
      }
    }

    ctx.restore();
  }

  drawMeritOrderChart() {
    const { state, sim } = this.store;
    if (!this.store.meritChartVisible) return;
    const panel = document.getElementById('merit-panel');
    if (!panel || panel.classList.contains('hidden')) return;
    const canvas = document.getElementById('merit-canvas');
    if (!canvas) return;
    canvas.width = panel.clientWidth;
    canvas.height = panel.clientHeight;
    const ctx = canvas.getContext('2d');
    const w = canvas.width - 4, h = canvas.height - 4;
    if (w <= 0 || h <= 0) return;
    ctx.save();
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#faf8f4';
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = '#d6d2c8';
    ctx.lineWidth = 0.5;
    ctx.strokeRect(1, 1, w - 2, h - 2);

    // Build merit order stack from current generator state
    const genBids = state.nodes
      .filter(n => n.type === 'generator' && !n.tripped)
      .map(g => ({
        price: (g.mode === 'fixed' || g.mode === 'load-follow') ? -10 : (g.bidPrice || 50),
        qty: (g.mode === 'fixed' || g.mode === 'load-follow')
          ? (g.rating || 100)
          : (g.committedMW || g.rating || 100),
        label: g.shortId || g.id.slice(-5),
      }));
    const bids = genBids
      .sort((a, b) => a.price - b.price);
    if (!bids.length) { ctx.restore(); return; }

    const pad = 40, pw = w - 2 * pad, ph = h - 2 * pad - 5;
    const maxQty = Math.max(bids.reduce((s, b) => s + b.qty, 0), 1);
    const minPrice = Math.min(...bids.map(b => b.price), -10);
    const maxPrice = Math.max(...bids.map(b => b.price), 50) * 1.2;

    // Axes
    ctx.strokeStyle = '#d6d2c8';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(pad, pad);
    ctx.lineTo(pad, pad + ph);
    ctx.lineTo(pad + pw, pad + ph);
    ctx.stroke();

    // Y-axis labels ($/MWh)
    ctx.fillStyle = '#999';
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    const chartBottom = minPrice;
    const chartRange = maxPrice - chartBottom;
    for (let p = 0; p <= 5; p++) {
      const val = chartBottom + (p / 5) * chartRange;
      const y = pad + ph - (p / 5) * ph;
      ctx.fillText('$' + Math.round(val), pad - 5, y);
      ctx.strokeStyle = '#eee';
      ctx.lineWidth = 0.5;
      ctx.beginPath();
      ctx.moveTo(pad - 3, y);
      ctx.lineTo(pad, y);
      ctx.stroke();
    }

    // Stacked bid blocks
    let cx = pad;
    const colors = ['#7eb87e', '#6aa86a', '#5a985a', '#8ec88e', '#a0d8a0', '#70b070', '#4a904a', '#3a803a'];
    this._meritBars = new Array(bids.length);
    for (let i = 0; i < bids.length; i++) {
      const b = bids[i];
      const bw = Math.max((b.qty / maxQty) * pw, 1);
      const bh = Math.max(((b.price - chartBottom) / chartRange) * ph, 14);
      this._meritBars[i] = { cx, y: pad + ph - bh, bw, bh, label: b.label, price: b.price, qty: b.qty };
      const isHovered = i === this._meritHoverIdx;
      ctx.fillStyle = isHovered ? '#9ad89a' : colors[i % colors.length];
      ctx.fillRect(cx, pad + ph - bh, bw, bh);
      ctx.strokeStyle = isHovered ? '#222' : '#555';
      ctx.lineWidth = isHovered ? 2 : 0.5;
      ctx.strokeRect(cx, pad + ph - bh, bw, bh);
      // Label if wide enough
      if (bw > 20) {
        ctx.fillStyle = '#fff';
        ctx.font = '8px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(b.label, cx + bw / 2, pad + ph - bh / 2);
      }
      // Hover info bar at top of chart
      if (isHovered) {
        const priceStr = b.price === -10 ? '\u2014' : '$' + b.price;
        const info = b.label + '  ' + priceStr + '  ' + Math.round(b.qty) + 'MW';
        ctx.fillStyle = 'rgba(34,34,34,0.85)';
        ctx.fillRect(pad, 2, ctx.measureText(info).width + 10, 16);
        ctx.fillStyle = '#fff';
        ctx.font = 'bold 10px sans-serif';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.fillText(info, pad + 5, 4);
      }
      cx += bw;
    }    // Demand vertical line
    const totalLoad = state.nodes.filter(n => n.type === 'load').reduce((s, l) => s + (l.mw || 0), 0);
    const demandX = pad + Math.min((totalLoad / maxQty) * pw, pw);
    ctx.strokeStyle = '#4a90d9';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([6, 3]);
    ctx.beginPath();
    ctx.moveTo(demandX, pad);
    ctx.lineTo(demandX, pad + ph);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#4a90d9';
    ctx.font = 'bold 10px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText('Demand ' + Math.round(totalLoad) + ' MW', demandX, pad + ph + 14);

    // SMP line
    const smp = state.smp;
    if (smp != null) {
      const smpY = pad + ph - ((smp - chartBottom) / chartRange) * ph;
      ctx.strokeStyle = '#d94a4a';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(pad, smpY);
      ctx.lineTo(pad + pw, smpY);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = '#d94a4a';
      ctx.font = '11px sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'bottom';
      ctx.fillText('SMP $' + smp.toFixed(1), pad + 4, smpY - 3);
    }


    // Merit chart hover - add once
    if (!this._meritListenersAdded) {
      this._meritListenersAdded = true;
      const mc = document.getElementById('merit-canvas');
      if (mc) {
        mc.addEventListener('mousemove', (e) => {
          const rect = mc.getBoundingClientRect();
          const mx = e.clientX - rect.left;
          const my = e.clientY - rect.top;
          let found = -1;
          for (let i = 0; i < (this._meritBars||[]).length; i++) {
            const b = this._meritBars[i];
            if (mx >= b.cx && mx <= b.cx + b.bw && my >= b.y && my <= b.y + b.bh) { found = i; break; }
          }
          if (found !== this._meritHoverIdx) {
            this._meritHoverIdx = found;
            this.drawMeritOrderChart();
          }
        });
        mc.addEventListener('mouseleave', () => {
          if (this._meritHoverIdx >= 0) {
            this._meritHoverIdx = -1;
            this.drawMeritOrderChart();
          }
        });
      }
    }

    ctx.restore();
  }
}
