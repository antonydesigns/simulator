import { state, sim } from './state.js';
import { findNetworks, recomputeNetworks } from './simulation.js';
import { draw } from './renderer.js';
import { persist } from './storage.js';
import { updateControls, updateStatsPanel } from './panels.js';

export function openBalanceModal() {
  if (sim.running) return;
  const nets = findNetworks();
  if (!nets.length) return;

  // Save originals for cancel
  const origBaselines = {};
  const origMw = {};
  const origShed = {};
  for (const n of state.nodes) {
    if (n.type === 'generator') {
      origBaselines[n.id] = n.baselineContract || 0;
      origMw[n.id] = n.mw;
      origShed[n.id] = n.shedPct || 0;
    } else if (n.type === 'storage') {
      origBaselines[n.id] = n.baselineContract || 0;
    } else if (n.type === 'load') {
      origMw[n.id] = n.mw;
      origShed[n.id] = n.shedPct || 0;
    }
  }
  const origConnTripped = {};
  for (const c of state.connections) origConnTripped[c.id] = c.tripped;
  const origNetsFreq = {};
  for (const net of nets) origNetsFreq[net.id] = net.freq || 50;

  const overlay = document.createElement('div');
  overlay.className = 'balance-overlay';
  overlay.innerHTML = `<div class="balance-modal">
    <div class="balance-header">⚖️ Balance Setup</div>
    <div class="balance-body" id="balance-body"></div>
    <div class="balance-footer">
      <button class="balance-apply-btn">✓ Apply</button>
      <button class="balance-cancel-btn">✕ Cancel</button>
    </div>
  </div>`;
  document.body.appendChild(overlay);

  const bodyEl = overlay.querySelector('#balance-body');
  const applyBtn = overlay.querySelector('.balance-apply-btn');
  const cancelBtn = overlay.querySelector('.balance-cancel-btn');

  const islandStates = [];

  for (const net of nets) {
    const netNodes = [...net.nodeIds].map(id => state.nodes.find(n => n.id === id)).filter(Boolean);
    const loads = netNodes.filter(n => n.type === 'load');
    const gens = netNodes.filter(n => n.type === 'generator');
    const storages = netNodes.filter(n => n.type === 'storage');

    const islandState = {
      netId: net.id,
      loadEntries: [],
      flexGenEntries: [],
      flexStorEntries: [],
      fixedEntries: [],
      remainingEl: null,
    };

    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    const section = document.createElement('div');
    section.className = 'balance-island';

    const header = document.createElement('div');
    header.className = 'balance-island-header';
    header.innerHTML = `<span class="balance-island-name">Island ${net.id.slice(-4)}</span>`;
    const headerStats = document.createElement('span');
    headerStats.className = 'balance-island-stats';
    header.appendChild(headerStats);
    section.appendChild(header);

    function updateSummary() {
      function isLocked(e) { return e.lockBtn.classList.contains('balance-locked'); }
      let totalDemand = 0, fixedSupply = 0, lockedSupply = 0;
      for (const e of islandState.loadEntries) totalDemand += Number(e.slider.value);
      for (const e of islandState.fixedEntries) fixedSupply += e.value;
      for (const e of islandState.flexGenEntries) { if (isLocked(e)) lockedSupply += Number(e.slider.value); }
      for (const e of islandState.flexStorEntries) { if (isLocked(e)) lockedSupply += Number(e.slider.value); }
      const remaining = totalDemand - fixedSupply - lockedSupply;
      headerStats.textContent = `Load ${totalDemand} MW  •  Fixed ${fixedSupply} MW  •  Locked ${lockedSupply} MW`;
      if (islandState.remainingEl) {
        islandState.remainingEl.textContent = remaining >= 0
          ? `→ Remaining: ${Math.round(remaining)} MW`
          : `→ Surplus: ${Math.round(-remaining)} MW`;
      }
    }

    for (const load of loads) {
      const row = document.createElement('div');
      row.className = 'balance-node-row';
      row.innerHTML = `<span>${load.shortId || load.id.slice(-4)}</span>
        <input type="range" class="balance-slider" min="0" max="${(node.noiseMax || 200) * 2 || 500}" value="${load.mw || 10}" data-type="load">
        <span class="balance-value">${Math.round(load.mw || 10)} MW</span>`;
      const slider = row.querySelector('.balance-slider');
      const valSpan = row.querySelector('.balance-value');
      const entry = { slider, lockBtn: null, node: load };
      islandState.loadEntries.push(entry);
      slider.addEventListener('input', () => {
        valSpan.textContent = Math.round(slider.value) + ' MW';
        load.mw = parseFloat(slider.value);
        updateSummary();
      });
      section.appendChild(row);
    }

    for (const gen of gens) {
      if (gen.mode === 'fixed') {
        islandState.fixedEntries.push({ value: Math.min(gen.baselineContract || 0, gen.rating || 100), node: gen });
      } else {
        const row = document.createElement('div');
        row.className = 'balance-node-row';
        row.innerHTML = `<span>${gen.shortId || gen.id.slice(-4)}</span>
          <input type="range" class="balance-slider" min="0" max="${gen.rating || 100}" value="${gen.baselineContract || 0}" data-type="flex-gen">
          <span class="balance-value">${Math.round(gen.baselineContract || 0)} MW</span>
          <button class="balance-lock-btn">🔓</button>`;
        const slider = row.querySelector('.balance-slider');
        const valSpan = row.querySelector('.balance-value');
        const lockBtn = row.querySelector('.balance-lock-btn');
        const entry = { slider, lockBtn, node: gen };
        islandState.flexGenEntries.push(entry);
        slider.addEventListener('input', () => {
          valSpan.textContent = Math.round(slider.value) + ' MW';
          gen.baselineContract = parseFloat(slider.value);
          gen.mw = gen.baselineContract;
          updateSummary();
        });
        lockBtn.addEventListener('click', () => {
          lockBtn.classList.toggle('balance-locked');
          lockBtn.textContent = lockBtn.classList.contains('balance-locked') ? '🔒' : '🔓';
          updateSummary();
        });
        section.appendChild(row);
      }
    }

    for (const st of storages) {
      if (st.mode === 'fixed') {
        islandState.fixedEntries.push({ value: st.baselineContract || 0, node: st });
      } else {
        const row = document.createElement('div');
        row.className = 'balance-node-row';
        const bc = st.baselineContract || 0;
        const rate = st.dischargeRate || 500;
        row.innerHTML = `<span>${st.shortId || st.id.slice(-4)}</span>
          <input type="range" class="balance-slider" min="${-(st.chargeRate || 500)}" max="${st.dischargeRate || 500}" value="${bc}" data-type="flex-stor">
          <span class="balance-value">${(bc >= 0 ? '+' : '') + Math.round(bc)} MW</span>
          <button class="balance-lock-btn">🔓</button>`;
        const slider = row.querySelector('.balance-slider');
        const valSpan = row.querySelector('.balance-value');
        const lockBtn = row.querySelector('.balance-lock-btn');
        const entry = { slider, lockBtn, node: st };
        islandState.flexStorEntries.push(entry);
        slider.addEventListener('input', () => {
          const v = parseFloat(slider.value);
          valSpan.textContent = (v >= 0 ? '+' : '') + Math.round(v) + ' MW';
          st.baselineContract = v;
          st.mwResponse = v;
          updateSummary();
        });
        lockBtn.addEventListener('click', () => {
          lockBtn.classList.toggle('balance-locked');
          lockBtn.textContent = lockBtn.classList.contains('balance-locked') ? '🔒' : '🔓';
          updateSummary();
        });
        section.appendChild(row);
      }
    }

    // Remaining label
    const remainingEl = document.createElement('div');
    remainingEl.className = 'balance-summary';
    islandState.remainingEl = remainingEl;
    section.appendChild(remainingEl);
    bodyEl.appendChild(section);
    updateSummary();
    islandStates.push(islandState);
  }

  applyBtn.addEventListener('click', () => {
    // Apply all non-locked flexible entries to proportional auto-balance
    const allNets = findNetworks();
    const taken = {};

    // Compute totals
    for (const is of islandStates) {
      const matchedNet = allNets.find(n => n.id === is.netId);
      if (!matchedNet) continue;
      const netNodes = [...matchedNet.nodeIds].map(id => state.nodes.find(n => n.id === id)).filter(Boolean);
      const loads = netNodes.filter(n => n.type === 'load');
      const gens = netNodes.filter(n => n.type === 'generator');
      const storages = netNodes.filter(n => n.type === 'storage');

      let totalDemand = 0, fixedSupply = 0, lockedSupply = 0;
      for (const e of is.loadEntries) totalDemand += Number(e.slider.value);
      for (const e of is.fixedEntries) fixedSupply += e.value;
      for (const e of is.flexGenEntries) { if (e.lockBtn.classList.contains('balance-locked')) lockedSupply += Number(e.slider.value); }
      for (const e of is.flexStorEntries) { if (e.lockBtn.classList.contains('balance-locked')) lockedSupply += Number(e.slider.value); }

      const remaining = totalDemand - fixedSupply - lockedSupply;
      const flexGens = is.flexGenEntries.filter(e => !e.lockBtn.classList.contains('balance-locked') && e.node.type === 'generator');
      const flexStors = is.flexStorEntries.filter(e => !e.lockBtn.classList.contains('balance-locked') && e.node.type === 'storage');

      const totalFlexGen = flexGens.reduce((s, e) => s + (e.node.rating || 100), 0);
      const totalFlexStor = flexStors.reduce((s, e) => s + (e.node.dischargeRate || 50), 0);
      const totalFlex = totalFlexGen + totalFlexStor;

      if (totalFlex > 0 && remaining > 0) {
        for (const e of flexGens) {
          const share = (e.node.rating || 100) / totalFlex;
          const v = Math.round(remaining * share * 10) / 10;
          e.node.baselineContract = Math.min(v, e.node.rating || Infinity);
          e.node.mw = e.node.baselineContract;
          e.slider.value = e.node.baselineContract;
          e.slider.nextElementSibling.textContent = Math.round(e.node.baselineContract) + ' MW';
        }
        for (const e of flexStors) {
          const share = (e.node.dischargeRate || 50) / totalFlex;
          const v = Math.round(remaining * share * 10) / 10;
          e.node.baselineContract = Math.min(v, e.node.dischargeRate || 50);
          e.node.mwResponse = e.node.baselineContract;
          e.slider.value = e.node.baselineContract;
          e.slider.nextElementSibling.textContent = Math.round(e.node.baselineContract) + ' MW';
        }
      } else if (totalFlex > 0 && remaining <= 0 && flexStors.length > 0) {
        // Surplus: charge storage
        const surplus = -remaining;
        const totalRate = flexStors.reduce((s, e) => s + (e.node.chargeRate || 50), 0);
        for (const e of flexStors) {
          const cr = e.node.chargeRate || 50;
          const v = -Math.min(Math.round(surplus * (cr / totalRate) * 10) / 10, cr);
          e.node.baselineContract = v;
          e.node.mwResponse = v;
          e.slider.value = v;
          e.slider.nextElementSibling.textContent = Math.round(v) + ' MW';
        }
      }
    }

    recomputeNetworks();
    persist();
    draw();
    updateControls();
    updateStatsPanel();
    document.body.removeChild(overlay);
  });

  cancelBtn.addEventListener('click', () => {
    for (const n of state.nodes) {
      if (n.type === 'generator') {
        n.baselineContract = origBaselines[n.id] || 0;
        n.mw = origMw[n.id] || 0;
        n.shedPct = origShed[n.id] || 0;
      } else if (n.type === 'storage') {
        n.baselineContract = origBaselines[n.id] || 0;
      } else if (n.type === 'load') {
        n.mw = origMw[n.id] || 10;
        if (n.baseMw) n.baseMw = n.mw;
      }
    }
    for (const c of state.connections) c.tripped = origConnTripped[c.id] || false;
    for (const net of nets) { net.freq = origNetsFreq[net.id] || 50; net.freqPrev = origNetsFreq[net.id] || 50; }
    recomputeNetworks();
    persist();
    draw();
    updateControls();
    updateStatsPanel();
    document.body.removeChild(overlay);
  });

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) cancelBtn.click();
  });
}
