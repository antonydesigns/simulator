// ─── StatsPanel — stats, charts ──────────────────────────────────

export class StatsPanel {
  constructor(store) {
    this.store = store;
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
    return d.f;
  }

  drawFreqChart() {
    const { state, sim } = this.store;
    const panel = document.getElementById('freq-chart-panel');
    if (!panel || panel.classList.contains('hidden') || !this.store.freqChartVisible) return;
    const w = panel.clientWidth - 4, h = panel.clientHeight - 4;
    if (w <= 0 || h <= 0) return;
    ctx.save();
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    // Frequency chart background
    ctx.fillStyle = '#faf8f4'; ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = '#d6d2c8'; ctx.lineWidth = 0.5; ctx.strokeRect(1, 1, w - 2, h - 2);
    const data = sim.dataBuffer;
    if (data.length < 2) { ctx.restore(); return; }
    const pad = 25, pw = w - 2 * pad, ph = h - 2 * pad - 5;
    // Determine range
    const vals = data.map(d => d.f);
    let fmin = Math.min(...vals), fmax = Math.max(...vals);
    const margin = Math.max((fmax - fmin) * 0.2, 0.1);
    fmin -= margin; fmax += margin;
    // Axes
    ctx.strokeStyle = '#d6d2c8'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(pad, pad); ctx.lineTo(pad, pad + ph); ctx.lineTo(pad + pw, pad + ph); ctx.stroke();
    // Plot
    ctx.strokeStyle = '#4a90d9'; ctx.lineWidth = 1.5; ctx.beginPath();
    for (let i = 0; i < data.length; i++) {
      const x = pad + (i / (data.length - 1)) * pw;
      const y = pad + ph - ((data[i].f - fmin) / (fmax - fmin)) * ph;
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.stroke();
    // Labels
    ctx.fillStyle = '#333'; ctx.font = '10px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText(state.frequency.toFixed(3) + ' Hz', pw / 2 + pad, pad + ph + 15);
    ctx.textAlign = 'right'; ctx.fillText(fmax.toFixed(2), pad - 4, pad + 10);
    ctx.textAlign = 'right'; ctx.fillText(fmin.toFixed(2), pad - 4, pad + ph - 5);
    ctx.restore();
  }

  drawMeritOrderChart() {
    const { state, canvas, ctx } = this.store;
    const panel = document.getElementById('merit-chart-panel');
    if (!panel || panel.classList.contains('hidden') || !this.store.meritChartVisible) return;
    const w = panel.clientWidth - 4, h = panel.clientHeight - 4;
    if (w <= 0 || h <= 0) return;
    ctx.save();
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#faf8f4'; ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = '#d6d2c8'; ctx.lineWidth = 0.5; ctx.strokeRect(1, 1, w - 2, h - 2);
    const pad = 30, pw = w - 2 * pad, ph = h - 2 * pad - 5;
    const data = sim.dataBuffer;
    if (data.length < 2) { ctx.restore(); return; }
    const last = data[data.length - 1];
    const bids = last.meritBids || [];
    if (bids.length < 2) { ctx.restore(); return; }
    const maxQty = Math.max(...bids.map(b => b.q || 1)) * 1.1;
    const maxPrice = Math.max(...bids.map(b => b.p || 1)) * 1.2;
    // Axes
    ctx.strokeStyle = '#d6d2c8'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(pad, pad); ctx.lineTo(pad, pad + ph); ctx.lineTo(pad + pw, pad + ph); ctx.stroke();
    // Stack
    let cx = pad;
    ctx.fillStyle = '#7eb87e';
    for (const b of bids) {
      const bw = (b.q / maxQty) * pw;
      const bh = (b.p / maxPrice) * ph;
      ctx.fillRect(cx, pad + ph - bh, Math.max(bw, 1), bh);
      ctx.strokeStyle = '#555'; ctx.lineWidth = 0.5;
      ctx.strokeRect(cx, pad + ph - bh, Math.max(bw, 1), bh);
      cx += bw;
    }
    // SMP line
    if (last.smp) {
      const smpY = pad + ph - (last.smp / maxPrice) * ph;
      ctx.strokeStyle = '#d94a4a'; ctx.lineWidth = 1.5; ctx.setLineDash([4, 4]);
      ctx.beginPath(); ctx.moveTo(pad, smpY); ctx.lineTo(pad + pw, smpY); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = '#d94a4a'; ctx.font = '10px sans-serif'; ctx.textAlign = 'left';
      ctx.fillText('SMP $' + last.smp.toFixed(1), pad + 4, smpY - 4);
    }
    ctx.restore();
  }
}
