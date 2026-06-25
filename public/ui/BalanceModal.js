// ─── BalanceModal ──────────────────────────────────────────────────

export class BalanceModal {
  constructor(store, engine, persister, renderer, statsPanel) {
    this.store = store;
    this.engine = engine;
    this.persister = persister;
    this.renderer = renderer;
    this.statsPanel = statsPanel;
  }

  open() {
    const { state, sim } = this.store;
    if (sim.running) return;
    const nets = this.engine.findNetworks();
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

    // Build modal
    const overlay = document.createElement('div');
    overlay.className = 'balance-overlay';
    overlay.innerHTML = '<div class="balance-modal">' +
      '<div class="balance-header">⚖️ Balance Setup</div>' +
      '<div class="balance-body" id="balance-body"></div>' +
      '<div class="balance-footer">' +
      '<button class="balance-apply-btn">✓ Apply</button>' +
      '<button class="balance-cancel-btn">✕ Cancel</button>' +
      '</div></div>';
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
      header.innerHTML = '<span class="balance-island-name">Island ' + net.id.slice(-4) + '</span>';
      const headerStats = document.createElement('span');
      headerStats.className = 'balance-island-stats';
      header.appendChild(headerStats);
      section.appendChild(header);

      const self = this;

      function updateSummary() {
        function isLocked(e) { return e.lockBtn && e.lockBtn.classList.contains('balance-locked'); }
        let totalDemand = 0, fixedSupply = 0, lockedSupply = 0;
        for (const e of islandState.loadEntries) totalDemand += Number(e.slider.value);
        for (const e of islandState.fixedEntries) {
          if (e.slider && isLocked(e)) lockedSupply += Number(e.slider.value);
          else fixedSupply += (e.value || 0);
        }
        const remaining = totalDemand - fixedSupply - lockedSupply;
        const totalDispatched = lockedSupply + fixedSupply;
        headerStats.textContent = 'Load ' + totalDemand + ' MW  •  Fixed ' + fixedSupply + ' MW  •  Locked ' + lockedSupply + ' MW';
        if (islandState.remainingEl) {
          islandState.remainingEl.textContent = remaining >= 0
            ? '→ Remaining: ' + Math.round(remaining) + ' MW'
            : '→ Surplus: ' + Math.round(-remaining) + ' MW';
        }
      }

      // Load rows
      for (const load of loads) {
        const row = document.createElement('div');
        row.className = 'balance-node-row';
        const label = document.createElement('span');
        label.className = 'balance-node-label';
        label.textContent = '📐 ' + (load.shortId || load.id.slice(-5)) + ' (' + (load.mw || 0) + ' MW)';
        const ctrlDiv = document.createElement('div');
        ctrlDiv.className = 'balance-node-controls';
        const slider = document.createElement('input');
        slider.type = 'range';
        slider.className = 'balance-node-slider';
        slider.min = 0;
        slider.max = Math.max(load.mw || 0, 500);
        slider.step = 1;
        slider.value = load.mw || 0;
        const valSpan = document.createElement('span');
        valSpan.className = 'balance-node-value';
        valSpan.textContent = Math.round(slider.value) + ' MW';
        slider.addEventListener('input', () => {
          valSpan.textContent = Math.round(slider.value) + ' MW';
          updateSummary();
        });
        ctrlDiv.appendChild(slider);
        ctrlDiv.appendChild(valSpan);
        row.appendChild(label);
        row.appendChild(ctrlDiv);
        section.appendChild(row);
        islandState.loadEntries.push({ node: load, slider, valSpan });
      }

      // Fixed gens — dispatched MW IS a control (slider + lock)
      for (const gen of gens.filter(g => g.mode === 'fixed')) {
        const row = document.createElement('div');
        row.className = 'balance-node-row';
        const label = document.createElement('span');
        label.className = 'balance-node-label';
        label.innerHTML = '🔒 ' + (gen.shortId || gen.id.slice(-5)) + ' <span class="balance-rating">(' + (gen.rating || 100) + ' MVA)</span>';
        const ctrlDiv = document.createElement('div');
        ctrlDiv.className = 'balance-node-controls';
        const lockBtn = document.createElement('button');
        lockBtn.className = 'balance-lock-btn balance-locked';
        lockBtn.textContent = '🔒';
        let locked = true;
        lockBtn.addEventListener('click', () => {
          locked = !locked;
          lockBtn.textContent = locked ? '🔒' : '🔓';
          lockBtn.classList.toggle('balance-locked', locked);
          updateSummary();
        });
        const slider = document.createElement('input');
        slider.type = 'range';
        slider.className = 'balance-node-slider';
        const maxVal = gen.rating || 100;
        slider.min = 0;
        slider.max = maxVal;
        slider.step = 1;
        slider.value = clamp(origBaselines[gen.id] || 0, 0, maxVal);
        const valSpan = document.createElement('span');
        valSpan.className = 'balance-node-value';
        valSpan.textContent = Math.round(slider.value) + ' MW';
        slider.addEventListener('input', () => {
          valSpan.textContent = Math.round(slider.value) + ' MW';
        });
        ctrlDiv.appendChild(lockBtn);
        ctrlDiv.appendChild(slider);
        ctrlDiv.appendChild(valSpan);
        row.appendChild(label);
        row.appendChild(ctrlDiv);
        section.appendChild(row);
        islandState.fixedEntries.push({ node: gen, slider, valSpan, lockBtn, locked: true, maxVal });
      }

      // Fixed storage — storage in fixed mode, dispatched MW IS a control
      for (const st of storages.filter(s => s.mode === 'fixed')) {
        const soc = st.mw || 0;
        const maxDischarge = st.dischargeRate || 50;
        const maxCharge = st.chargeRate || 50;
        const row = document.createElement('div');
        row.className = 'balance-node-row' + (soc === 0 ? ' balance-empty-row' : '');
        const label = document.createElement('span');
        label.className = 'balance-node-label';
        label.innerHTML = '🔒 ' + (st.shortId || st.id.slice(-5)) + ' <span class="balance-rating">(' + maxDischarge + ' MW, SoC ' + soc.toFixed(0) + ' MWh)</span>';
        const ctrlDiv = document.createElement('div');
        ctrlDiv.className = 'balance-node-controls';
        const lockBtn = document.createElement('button');
        lockBtn.className = 'balance-lock-btn' + (soc === 0 ? ' balance-locked' : '');
        lockBtn.textContent = soc === 0 ? '🔒' : '🔓';
        let locked = soc === 0;
        if (soc > 0) {
          lockBtn.addEventListener('click', () => {
            locked = !locked;
            lockBtn.textContent = locked ? '🔒' : '🔓';
            lockBtn.classList.toggle('balance-locked', locked);
            updateSummary();
          });
        }
        const slider = document.createElement('input');
        slider.type = 'range';
        slider.className = 'balance-node-slider';
        slider.min = -maxCharge;
        slider.max = maxDischarge;
        slider.step = 1;
        const initVal = soc === 0 ? 0 : clamp(origBaselines[st.id] || 0, -maxCharge, maxDischarge);
        slider.value = initVal;
        const valSpan = document.createElement('span');
        valSpan.className = 'balance-node-value';
        valSpan.textContent = (Number(slider.value) >= 0 ? '+' : '') + Math.round(slider.value) + ' MW';
        slider.addEventListener('input', () => {
          valSpan.textContent = (Number(slider.value) >= 0 ? '+' : '') + Math.round(slider.value) + ' MW';
        });
        ctrlDiv.appendChild(lockBtn);
        ctrlDiv.appendChild(slider);
        ctrlDiv.appendChild(valSpan);
        row.appendChild(label);
        row.appendChild(ctrlDiv);
        section.appendChild(row);
        islandState.fixedEntries.push({ node: st, slider, valSpan, lockBtn, locked, maxVal: maxDischarge });
      }

      // Merit (non-fixed) gens — dispatched MW comes from the market, NOT a control
      const meritGens = gens.filter(g => g.mode !== 'fixed');
      for (const gen of meritGens) {
        const dispatched = gen.baselineContract || 0;
        const bidPrice = gen.bidPrice != null ? '$' + gen.bidPrice.toFixed(1) + '/MWh' : '—';
        const bidQty = gen.bidQty != null ? gen.bidQty + ' MW' : '—';
        const row = document.createElement('div');
        row.className = 'balance-node-row balance-merit-row';
        row.innerHTML = '<span class="balance-node-label">⚡ ' + (gen.shortId || gen.id.slice(-5)) + ' <span class="balance-rating">(' + (gen.rating || 100) + ' MVA)</span></span>' +
          '<div class="balance-node-controls" style="gap:6px"><span style="color:#666;font-size:12px">Bid ' + bidPrice + ' x ' + bidQty + '</span><span style="color:#4a6a8a;font-size:12px;font-weight:500">dispatched ' + Math.round(dispatched) + ' MW</span></div>';
        section.appendChild(row);
        islandState.fixedEntries.push({ node: gen, value: dispatched });
      }

      // Flex storage (non-fixed) — dispatched MW comes from the market, NOT a control
      const flexStor = storages.filter(s => s.mode !== 'fixed');
      for (const st of flexStor) {
        const soc = st.mw || 0;
        const dispatched = st.baselineContract || 0;
        const row = document.createElement('div');
        row.className = 'balance-node-row' + (soc === 0 ? ' balance-empty-row' : '');
        row.innerHTML = '<span class="balance-node-label">🔋 ' + (st.shortId || st.id.slice(-5)) + ' <span class="balance-rating">(' + (st.dischargeRate || 50) + ' MW, SoC ' + soc.toFixed(0) + ' MWh)</span></span>' +
          '<div class="balance-node-controls" style="gap:6px"><span style="color:#4a6a8a;font-size:12px;font-weight:500">' + (dispatched >= 0 ? '+' : '') + Math.round(dispatched) + ' MW dispatched</span></div>';
        section.appendChild(row);
        islandState.fixedEntries.push({ node: st, value: dispatched });
      }
      // Island footer
      const footer = document.createElement('div');
      footer.className = 'balance-island-footer';
      const remainingEl = document.createElement('span');
      remainingEl.className = 'balance-remaining';
      islandState.remainingEl = remainingEl;
      const redistributeBtn = document.createElement('button');
      redistributeBtn.className = 'balance-redistribute-btn';
      redistributeBtn.textContent = '🔄 Redistribute';
      redistributeBtn.addEventListener('click', () => {
        let totalDemand = 0, fixedSupply = 0, lockedSupply = 0;
        for (const e of islandState.loadEntries) totalDemand += Number(e.slider.value);
        for (const e of islandState.fixedEntries) fixedSupply += e.value;
        for (const e of islandState.flexGenEntries) {
          if (e.lockBtn.classList.contains('balance-locked')) lockedSupply += Number(e.slider.value);
        }
        for (const e of islandState.flexStorEntries) {
          if (e.lockBtn.classList.contains('balance-locked')) lockedSupply += Number(e.slider.value);
        }
        const remaining = totalDemand - fixedSupply - lockedSupply;
        const available = islandState.flexGenEntries.filter(e => !e.lockBtn.classList.contains('balance-locked'));
        const availableStor = islandState.flexStorEntries.filter(e => !e.lockBtn.classList.contains('balance-locked'));
        if (remaining > 0 && available.length + availableStor.length > 0) {
          const totalCap = available.reduce((s, e) => s + e.maxVal, 0) +
            availableStor.reduce((s, e) => s + Math.max(0, e.maxDischarge), 0);
          if (totalCap > 0) {
            for (const e of available) {
              const share = (e.maxVal / totalCap) * remaining;
              e.slider.value = Math.round(clamp(share, 0, e.maxVal));
            }
            for (const e of availableStor) {
              const share = (Math.max(0, e.maxDischarge) / totalCap) * remaining;
              e.slider.value = Math.round(clamp(share, -e.maxCharge, e.maxDischarge));
            }
          }
        } else if (remaining < 0 && available.length > 0) {
          const surplus = -remaining;
          const totalCap = available.reduce((s, e) => s + e.maxVal, 0);
          if (totalCap > 0) {
            for (const e of available) {
              const curVal = Number(e.slider.value);
              const cut = Math.min(curVal, Math.round((curVal / totalCap) * surplus));
              e.slider.value = Math.max(0, curVal - cut);
            }
          }
        }
        for (const e of islandState.flexGenEntries) {
          e.valSpan.textContent = (Number(e.slider.value) >= 0 ? '+' : '') + Math.round(e.slider.value) + ' MW';
        }
        for (const e of islandState.flexStorEntries) {
          e.valSpan.textContent = (Number(e.slider.value) >= 0 ? '+' : '') + Math.round(e.slider.value) + ' MW';
        }
        updateSummary();
      });

      footer.appendChild(remainingEl);
      footer.appendChild(redistributeBtn);
      section.appendChild(footer);

      bodyEl.appendChild(section);
      updateSummary();
      islandStates.push(islandState);
    }

    // Apply
    applyBtn.addEventListener('click', () => {
      for (const islandState of islandStates) {
        const net = nets.find(n => n.id === islandState.netId);
        if (!net) continue;
        for (const e of islandState.fixedEntries) {
          if (e.slider != null) e.node.baselineContract = Number(e.slider.value);
        }
        for (const e of islandState.loadEntries) {
          e.node.mw = Number(e.slider.value);
          e.node.baseMw = e.node.mw;
        }
      }
      // Reset trips, shedding, and frequencies — but DON'T call balanceGrid (it wipes baselines)
      for (const n of state.nodes) {
        if (n.type === 'generator' || n.type === 'storage') {
          n.tripped = false;
          n.freqTimer = 0;
          n.agcOffset = 0;
        }
        if (n.type === 'generator') {
          n.mw = n.baselineContract || 0;
        }
        if (n.type === 'storage') {
          n.mwResponse = n.baselineContract || 0;
          n.freqRestore = 0;
        }
        if (n.type === 'load') {
          n.shedPct = 0;
        }
      }
      for (const c of state.connections) { c.tripped = false; c.tripTimer = 0; }
      overlay.remove();
      this.engine.recomputeNetworks();
      for (const net of state.networks) { net.freq = 50; net.freqPrev = 50; }
      this.persister.persist();
      this.renderer.draw();
      this.statsPanel.update();
    });

    // Cancel
    cancelBtn.addEventListener('click', () => {
      for (const n of state.nodes) {
        if (origBaselines[n.id] !== undefined) {
          if (n.type === 'generator') n.baselineContract = origBaselines[n.id];
          if (n.type === 'storage') n.baselineContract = origBaselines[n.id];
        }
        if (origMw[n.id] !== undefined) {
          if (n.type === 'load') n.mw = origMw[n.id];
        }
        if (origShed[n.id] !== undefined) {
          n.shedPct = origShed[n.id];
        }
      }
      for (const c of state.connections) {
        if (origConnTripped[c.id] !== undefined) c.tripped = origConnTripped[c.id];
      }
      for (const net of nets) {
        if (origNetsFreq[net.id] !== undefined) net.freq = origNetsFreq[net.id];
      }
      overlay.remove();
      this.engine.recomputeNetworks();
      this.renderer.draw();
    });
  }
}
