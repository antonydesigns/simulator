import { state } from './state.js';
import { drawFreqChart, drawMeritOrderChart } from './renderer.js';

// Expose to inline onclick handlers in HTML strings
window.drawFreqChart = drawFreqChart;
window.drawMeritOrderChart = drawMeritOrderChart;
window.updateStatsPanel = updateStatsPanel;

export function toggleStatsBreakdown(nodeId) {
  if (state.statsBreakdownExpanded.has(nodeId)) {
    state.statsBreakdownExpanded.delete(nodeId);
  } else {
    state.statsBreakdownExpanded.add(nodeId);
  }
  updateStatsPanel();
}

export function updateStatsPanel() {
  const panel = document.getElementById('stats-panel');
  if (!panel) return;
  panel.innerHTML = ''; // clear

  const header = document.createElement('div');
  header.className = 'stats-header';
  header.innerHTML = `
    <span>📊 Grid Status</span>
    <span class="stats-close" onclick="state.statsPanelVisible=false;document.getElementById('stats-panel').classList.add('hidden');">&times;</span>`;
  panel.appendChild(header);

  // --- Overall summary ---
  const summaryDiv = document.createElement('div');
  summaryDiv.className = 'stats-summary';

  const netCount = state.networks.filter(n => n.valid).length;
  const sn = state.selectedNetworkId;
  const activeNetworks = sn === 'all' ? state.networks : state.networks.filter(n => n.id === sn);
  const activeConnections = state.connections.filter(c =>
    c.sourceId && c.targetId && sn === 'all' ? true : activeNetworks.some(n => n.nodeIds.has(c.sourceId) && n.nodeIds.has(c.targetId))
  );
  const activeNodes = sn === 'all' ? state.nodes : activeNetworks.flatMap(n => [...n.nodeIds].map(id => state.nodes.find(nd => nd.id === id)).filter(Boolean));
  const allActiveNodes = [...new Set(activeNodes)];

  const totalGen = allActiveNodes.filter(n => n.type === 'generator').reduce((s, g) => s + (g.mw || 0), 0);
  const totalLoad = allActiveNodes.filter(n => n.type === 'load').reduce((s, l) => s + (l.mw || 0), 0);
  const totalStor = allActiveNodes.filter(n => n.type === 'storage').reduce((s, st) => s + (st.mwResponse || 0), 0);

  summaryDiv.innerHTML = `<strong>Islands</strong> ${netCount} &nbsp; <strong>Gen</strong> ${totalGen.toFixed(0)} MW &nbsp; <strong>Load</strong> ${totalLoad.toFixed(0)} MW &nbsp; <strong>Storage</strong> ${(totalStor >= 0 ? '+' : '') + totalStor.toFixed(0)} MW`;
  panel.appendChild(summaryDiv);

  // --- Per-node breakdown ---
  const breakdownDiv = document.createElement('div');
  breakdownDiv.className = 'stats-breakdown';
  for (const node of state.nodes) {
    if (node.type === 'junction') continue;
    if (sn !== 'all' && !state.networks.some(net => net.id === sn && net.nodeIds.has(node.id))) continue;

    const row = document.createElement('div');
    row.className = 'stats-node-row';

    const label = node.shortId || node.type.charAt(0).toUpperCase() + node.id.slice(-4);
    const stats = [];
    if (node.type === 'generator') {
      stats.push(`<span class="stats-mw">${(node.mw || 0).toFixed(0)} MW</span>`);
      stats.push(`<span class="stats-label">BC ${(node.baselineContract || 0).toFixed(0)}</span>`);
      if (node.mode === 'merchant') stats.push('<span class="stats-badge stats-merchant">MKT</span>');
      if (node.mode === 'fcr-only') stats.push('<span class="stats-badge stats-fcr">FCR</span>');
      if (node.mode === 'fixed') stats.push('<span class="stats-badge stats-fixed">FIX</span>');
      if (node.tripped) stats.push('<span class="stats-badge stats-trip">TRIP</span>');
    } else if (node.type === 'load') {
      stats.push(`<span class="stats-mw">${(node.mw || 0).toFixed(0)} MW</span>`);
      if ((node.shedPct || 0) > 0) stats.push(`<span class="stats-badge stats-shed">${(node.shedPct * 100).toFixed(0)}%</span>`);
    } else if (node.type === 'storage') {
      stats.push(`<span class="stats-mw">${(node.mw || 0).toFixed(1)} MWh</span>`);
      const resp = node.mwResponse || 0;
      stats.push(`<span class="stats-label">${(resp >= 0 ? '+' : '') + resp.toFixed(0)} MW</span>`);
      if (node.mode === 'grid-forming') stats.push('<span class="stats-badge stats-gf">GF</span>');
      if (node.tripped) stats.push('<span class="stats-badge stats-trip">TRIP</span>');
    }

    row.innerHTML = `<span class="stats-node-label" onclick="state.statsBreakdownExpanded.has('${node.id}')?state.statsBreakdownExpanded.delete('${node.id}'):state.statsBreakdownExpanded.add('${node.id}');updateStatsPanel();">${state.statsBreakdownExpanded.has(node.id) ? '▼' : '▶'} ${label}</span> ${stats.join(' ')}`;
    breakdownDiv.appendChild(row);

    // Expanded detail
    if (state.statsBreakdownExpanded.has(node.id)) {
      const detail = document.createElement('div');
      detail.className = 'stats-detail';
      if (node.type === 'generator') {
        detail.innerHTML = `
          <div>Rating: ${node.rating || 100} MVA</div>
          <div>Inertia: ${(node.inertia || 5).toFixed(1)}s</div>
          <div>Droop: ${((node.droop || 0.04) * 100).toFixed(1)}%</div>
          <div>TC: ${(node.turbineTimeConstant || 1).toFixed(1)}s</div>
          <div>Ramp-Down TC: ${(node.rampDownTC || 0.3).toFixed(2)}s</div>
          <div>FCR Headroom: ${Math.round(node.fcrHeadroom || 10)} MW</div>
          <div>AGC Offset: ${(node.agcOffset || 0).toFixed(1)} MW</div>
          <div>Bid: $${(node.bidPrice || 50).toFixed(1)}/MWh x ${Math.round(node.bidQty || node.rating || 100)} MWh</div>`;
      } else if (node.type === 'load') {
        detail.innerHTML = `
          <div>Base: ${(node.baseMw || node.mw || 10).toFixed(0)} MW</div>
          <div>Shed: ${((node.shedPct || 0) * 100).toFixed(0)}%</div>
          <div>Noise: ${node.noiseEnabled ? 'ON' : 'OFF'} ${node.noiseMin || 100}–${node.noiseMax || 200} MW ±${node.noisePct || 10}%</div>`;
      } else if (node.type === 'storage') {
        detail.innerHTML = `
          <div>SoC: ${(node.mw || 0).toFixed(1)} / ${node.maxCapacity || 100} MWh</div>
          <div>Rate: −${node.chargeRate || 500} / +${node.dischargeRate || 500} MW</div>
          <div>Droop: ${((node.droop || 0.04) * 100).toFixed(1)}%</div>
          <div>Baseline: ${(node.baselineContract || 0) >= 0 ? '+' : ''}${(node.baselineContract || 0).toFixed(0)} MW</div>
          <div>AGC Offset: ${(node.agcOffset || 0).toFixed(1)} MW</div>`;
      }
      breakdownDiv.appendChild(detail);
    }
  }
  panel.appendChild(breakdownDiv);

  // --- Chart buttons ---
  const chartRow = document.createElement('div');
  chartRow.className = 'stats-chart-row';
  chartRow.innerHTML = `<button class="stats-chart-btn" onclick="state.freqChartVisible=!state.freqChartVisible;document.getElementById('freq-chart-panel').classList.toggle('hidden',!state.freqChartVisible);if(state.freqChartVisible)drawFreqChart();">📈 Frequency Graph</button>
    <button class="stats-chart-btn" onclick="state.meritChartVisible=!state.meritChartVisible;document.getElementById('merit-panel').classList.toggle('hidden',!state.meritChartVisible);if(state.meritChartVisible)drawMeritOrderChart();">💰 Merit Order</button>`;
  panel.appendChild(chartRow);
}

// ─── Island selection click handler ─────────────────────────────────────