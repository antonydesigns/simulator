import { state, canvas, openPanels, dragPanel, dragOff } from './state.js';
import { persist, uid } from './storage.js';

export function openSettings(nodeId) {
  const node = state.nodes.find(n => n.id === nodeId);
  if (!node || node.type === 'junction') return;
  if (openPanels[nodeId]) { openPanels[nodeId].panel.style.zIndex = Date.now(); return; }

  const panel = document.createElement('div');
  panel.className = 'settings-panel'; panel.dataset.nodeId = nodeId; panel.style.zIndex = Date.now();
  const tag = node.label || node.shortId || node.id.slice(-4);
  const entry = { panel };

  if (node.type === 'generator') {
    panel.innerHTML = `
      <div class="settings-header"><span class="settings-title">Generator ${tag}</span><span class="settings-close" data-action="close-settings">&times;</span></div>
      <div class="settings-body">
        <div class="settings-row"><label class="settings-label">Dispatched MW</label>
          <div class="settings-slider-group">
            <input type="range" class="baseline-slider" min="0" max="${node.rating || 100}" value="${node.baselineContract || 0}">
            <span class="baseline-value">${Math.round(node.baselineContract || 0)} MW</span>
          </div>
        </div>
        <div class="settings-row"><label class="settings-label">Output</label>
          <div class="settings-slider-group" style="justify-content:flex-end;"><span class="gen-output" style="font-size:14px;font-weight:600;">${Math.round(node.mw || 0)} MW</span></div>
        </div>
        <div class="settings-row market-row" style="${node.mode === 'fixed' ? 'display:none;' : ''}"><label class="settings-label">Bid Price</label>
          <div class="settings-slider-group">
            <input type="range" class="bid-price-slider" min="0" max="500" step="0.5" value="${node.bidPrice || 50}">
            <span class="bid-price-value">$${(node.bidPrice || 50).toFixed(1)}/MWh</span>
          </div>
        </div>
        <div class="settings-row market-row" style="${node.mode === 'fixed' ? 'display:none;' : ''}"><label class="settings-label">Bid Qty</label>
          <div class="settings-slider-group">
            <input type="range" class="bid-qty-slider" min="0" max="${node.rating || 100}" value="${node.bidQty || node.rating || 100}">
            <span class="bid-qty-value">${Math.round(node.bidQty || node.rating || 100)} MWh</span>
          </div>
        </div>
        <div class="settings-row"><label class="settings-label">FCR Headroom</label>
          <div class="settings-slider-group">
            <input type="range" class="fcr-headroom-slider" min="0" max="${node.rating || 100}" value="${node.fcrHeadroom || 10}">
            <span class="fcr-headroom-value">${Math.round(node.fcrHeadroom || 10)} MW</span>
          </div>
        </div>
        <div class="settings-row"><label class="settings-label">Rating</label>
          <div class="settings-slider-group">
            <input type="range" class="rating-slider" min="1" max="500" value="${node.rating || 100}">
            <span class="rating-value">${node.rating || 100} MVA</span>
          </div>
        </div>
        <div class="settings-row"><label class="settings-label">Inertia H</label>
          <div class="settings-slider-group">
            <input type="range" class="inertia-slider" min="0" max="20" step="0.5" value="${node.inertia || 5}">
            <span class="inertia-value">${(node.inertia || 5).toFixed(1)}s</span>
          </div>
        </div>
        <div class="settings-row"><label class="settings-label">Droop</label>
          <div class="settings-slider-group">
            <input type="range" class="droop-slider" min="0.5" max="20" step="0.5" value="${(node.droop || 0.04) * 100}">
            <span class="droop-value">${(node.droop || 0.04) * 100}%</span>
          </div>
        </div>
        <div class="settings-row"><label class="settings-label">Turbine TC</label>
          <div class="settings-slider-group">
            <input type="range" class="tc-slider" min="0.2" max="5" step="0.1" value="${node.turbineTimeConstant || 1}">
            <span class="tc-value">${(node.turbineTimeConstant || 1).toFixed(1)}s</span>
          </div>
        </div>
        <div class="settings-row"><label class="settings-label">Ramp-Down TC</label>
          <div class="settings-slider-group">
            <input type="range" class="rd-slider" min="0.05" max="2" step="0.05" value="${node.rampDownTC || 0.3}">
            <span class="rd-value">${(node.rampDownTC || 0.3).toFixed(2)}s</span>
          </div>
        </div>
        <div class="settings-row sep-top"><label class="settings-label">Mode</label>
          <div class="settings-slider-group">
            <select class="gen-mode-select">
              <option value="balancing" ${node.mode === 'balancing' ? 'selected' : ''}>Balancing (FCR + AGC)</option>
              <option value="fcr-only" ${node.mode === 'fcr-only' ? 'selected' : ''}>FCR Only</option>
              <option value="merchant" ${node.mode === 'merchant' ? 'selected' : ''}>Merchant (Price Only)</option>
              <option value="fixed" ${node.mode === 'fixed' ? 'selected' : ''}>Fixed</option>
            </select>
          </div>
        </div>
        <div class="settings-row sep-top"><button class="gen-shutdown-btn" style="width:100%;padding:6px 0;border:1px solid #c0392b;border-radius:4px;cursor:pointer;font-size:13px;background:${node.tripped ? '#27ae60' : 'transparent'};color:${node.tripped ? '#fff' : '#c0392b'}">${node.tripped ? '🔄 Restart' : '🛑 Shut Down'}</button></div>
      </div>`;

    entry.outputEl = panel.querySelector('.gen-output');

    const baselineSlider = panel.querySelector('.baseline-slider');
    const baselineVal = panel.querySelector('.baseline-value');
    entry.baselineSlider = baselineSlider;
    entry.baselineVal = baselineVal;
    baselineSlider.addEventListener('input', () => {
      const v = parseFloat(baselineSlider.value);
      baselineVal.textContent = Math.round(v) + ' MW';
      node.baselineContract = v;
    });
    baselineSlider.addEventListener('change', () => persist());

    const ratingSlider = panel.querySelector('.rating-slider');
    const ratingVal = panel.querySelector('.rating-value');
    ratingSlider.addEventListener('input', () => {
      const v = parseFloat(ratingSlider.value);
      ratingVal.textContent = v + ' MVA';
      node.rating = v;
      const fcrSlider = panel.querySelector('.fcr-headroom-slider');
      const bidQtySlider = panel.querySelector('.bid-qty-slider');
      if (fcrSlider) fcrSlider.max = v;
      if (bidQtySlider) bidQtySlider.max = v;
      if (baselineSlider) baselineSlider.max = v;
    });
    ratingSlider.addEventListener('change', () => persist());

    const bidPriceSlider = panel.querySelector('.bid-price-slider');
    const bidPriceVal = panel.querySelector('.bid-price-value');
    if (bidPriceSlider) {
      bidPriceSlider.addEventListener('input', () => {
        const v = parseFloat(bidPriceSlider.value);
        bidPriceVal.textContent = '$' + v.toFixed(1) + '/MWh';
        node.bidPrice = v;
      });
      bidPriceSlider.addEventListener('change', () => persist());
    }

    const bidQtySlider = panel.querySelector('.bid-qty-slider');
    const bidQtyVal = panel.querySelector('.bid-qty-value');
    if (bidQtySlider) {
      bidQtySlider.addEventListener('input', () => {
        const v = parseFloat(bidQtySlider.value);
        bidQtyVal.textContent = Math.round(v) + ' MWh';
        node.bidQty = v;
      });
      bidQtySlider.addEventListener('change', () => persist());
    }

    const fcrSlider = panel.querySelector('.fcr-headroom-slider');
    const fcrVal = panel.querySelector('.fcr-headroom-value');
    fcrSlider.addEventListener('input', () => {
      const v = parseFloat(fcrSlider.value);
      fcrVal.textContent = Math.round(v) + ' MW';
      node.fcrHeadroom = v;
    });
    fcrSlider.addEventListener('change', () => persist());

    const inertiaSlider = panel.querySelector('.inertia-slider');
    const inertiaVal = panel.querySelector('.inertia-value');
    inertiaSlider.addEventListener('input', () => {
      const v = parseFloat(inertiaSlider.value);
      inertiaVal.textContent = v.toFixed(1) + 's';
      node.inertia = v;
    });
    inertiaSlider.addEventListener('change', () => persist());

    const droopSlider = panel.querySelector('.droop-slider');
    const droopVal = panel.querySelector('.droop-value');
    droopSlider.addEventListener('input', () => {
      const d = parseFloat(droopSlider.value);
      droopVal.textContent = d + '%';
      node.droop = d / 100;
    });
    droopSlider.addEventListener('change', () => persist());

    const tcSlider = panel.querySelector('.tc-slider');
    const tcVal = panel.querySelector('.tc-value');
    tcSlider.addEventListener('input', () => {
      const v = parseFloat(tcSlider.value);
      tcVal.textContent = v.toFixed(1) + 's';
      node.turbineTimeConstant = v;
    });
    tcSlider.addEventListener('change', () => persist());

    const rdSlider = panel.querySelector('.rd-slider');
    const rdVal = panel.querySelector('.rd-value');
    rdSlider.addEventListener('input', () => {
      const v = parseFloat(rdSlider.value);
      rdVal.textContent = v.toFixed(2) + 's';
      node.rampDownTC = v;
    });
    rdSlider.addEventListener('change', () => persist());

    const modeSelect = panel.querySelector('.gen-mode-select');
    modeSelect.addEventListener('change', () => {
      node.mode = modeSelect.value;
      const marketRows = panel.querySelectorAll('.market-row');
      for (const r of marketRows) r.style.display = node.mode === 'fixed' ? 'none' : '';
      persist();
    });

    const shutdownBtn = panel.querySelector('.gen-shutdown-btn');
    shutdownBtn.addEventListener('click', () => {
      node.tripped = !node.tripped;
      if (node.tripped) { node.mw = 0; } else { node.freqTimer = 0; }
      shutdownBtn.textContent = node.tripped ? '🔄 Restart' : '🛑 Shut Down';
      shutdownBtn.style.background = node.tripped ? '#27ae60' : 'transparent';
      shutdownBtn.style.color = node.tripped ? '#fff' : '#c0392b';
      persist();
    });
  }

  if (node.type === 'storage') {
    const soch = node.maxCapacity || 100;
    const tagLabel = node.shortId || 'ST';
    panel.innerHTML = `
      <div class="settings-header"><span class="settings-title">Storage ${tagLabel}</span><span class="settings-close" data-action="close-settings">&times;</span></div>
      <div class="settings-body">
        <div class="settings-row"><label class="settings-label">SoC</label>
          <div class="settings-slider-group" style="justify-content:flex-end;"><span class="soc-value" style="font-size:14px;font-weight:600;">${(node.mw || 0).toFixed(2)} MWh</span></div>
        </div>
        <div class="settings-row"><label class="settings-label">Response MW</label>
          <div class="settings-slider-group" style="justify-content:flex-end;"><span class="mw-resp-value" style="font-size:14px;font-weight:600;">${(node.mwResponse || 0) >= 0 ? '+' : ''}${Math.round(node.mwResponse || 0)} MW</span></div>
        </div>
        <div class="settings-row"><label class="settings-label">Mode</label>
          <div class="settings-slider-group">
            <select class="st-mode-select">
              <option value="balancing" ${node.mode === 'balancing' ? 'selected' : ''}>Balancing (FCR + AGC)</option>
              <option value="fcr-only" ${node.mode === 'fcr-only' ? 'selected' : ''}>FCR Only</option>
              <option value="grid-forming" ${node.mode === 'grid-forming' ? 'selected' : ''}>Grid-Forming</option>
              <option value="fixed" ${node.mode === 'fixed' ? 'selected' : ''}>Fixed</option>
            </select>
          </div>
        </div>
        <div class="settings-row fcr-group" style="${node.mode === 'balancing' || node.mode === 'fcr-only' ? '' : 'display:none;'}"><label class="settings-label">FCR Headroom</label>
          <div class="settings-slider-group">
            <input type="range" class="st-fcr-slider" min="0" max="100" value="${node.fcrHeadroom || 10}">
            <span class="st-fcr-value">${Math.round(node.fcrHeadroom || 10)} MW</span>
          </div>
        </div>
        <div class="settings-row fcr-group" style="${node.mode === 'balancing' || node.mode === 'fcr-only' ? '' : 'display:none;'}"><label class="settings-label">Droop</label>
          <div class="settings-slider-group">
            <input type="range" class="st-droop-slider" min="0.5" max="20" step="0.5" value="${(node.droop || 0.04) * 100}">
            <span class="st-droop-value">${(node.droop || 0.04) * 100}%</span>
          </div>
        </div>
        <div class="settings-row fixed-group" style="${node.mode === 'fixed' ? '' : 'display:none;'}"><label class="settings-label">Fixed Target</label>
          <div class="settings-slider-group">
            <input type="range" class="st-fixed-slider" min="-500" max="500" value="${node.fixedTarget || 0}">
            <span class="st-fixed-value">${(node.fixedTarget || 0) >= 0 ? '+' : ''}${Math.round(node.fixedTarget || 0)} MW</span>
          </div>
        </div>
        <div class="settings-row neutral-group" style="${node.mode === 'balancing' ? '' : 'display:none;'}"><label class="settings-label">Baseline Contract</label>
          <div class="settings-slider-group">
            <input type="range" class="st-bc-slider" min="${-(node.chargeRate || 500)}" max="${node.dischargeRate || 500}" value="${node.baselineContract || 0}">
            <span class="st-bc-value">${(node.baselineContract || 0) >= 0 ? '+' : ''}${Math.round(node.baselineContract || 0)} MW</span>
          </div>
        </div>
        <div class="settings-row sep-top"><button class="st-shutdown-btn" style="width:100%;padding:6px 0;border:1px solid #c0392b;border-radius:4px;cursor:pointer;font-size:13px;background:${node.tripped ? '#27ae60' : 'transparent'};color:${node.tripped ? '#fff' : '#c0392b'}">${node.tripped ? '🔄 Restart' : '🛑 Shut Down'}</button></div>
      </div>`;

    entry.socEl = panel.querySelector('.soc-value');
    entry.mwRespEl = panel.querySelector('.mw-resp-value');
    entry.modeSelect = panel.querySelector('.st-mode-select');
    entry.fcrGroup = panel.querySelector('.fcr-group');
    entry.fixedGroup = panel.querySelector('.fixed-group');
    entry.neutralGroup = panel.querySelector('.neutral-group');
    entry.fcrSlider = panel.querySelector('.st-fcr-slider');
    entry.fcrVal = panel.querySelector('.st-fcr-value');
    entry.droopSlider = panel.querySelector('.st-droop-slider');
    entry.droopVal = panel.querySelector('.st-droop-value');
    entry.fixedSlider = panel.querySelector('.st-fixed-slider');
    entry.fixedVal = panel.querySelector('.st-fixed-value');
    entry.bcSlider = panel.querySelector('.st-bc-slider');
    entry.bcVal = panel.querySelector('.st-bc-value');
    entry.shutdownBtn = panel.querySelector('.st-shutdown-btn');

    if (entry.modeSelect) {
      entry.modeSelect.addEventListener('change', () => {
        node.mode = entry.modeSelect.value;
        entry.fcrGroup.style.display = (node.mode === 'balancing' || node.mode === 'fcr-only') ? '' : 'none';
        entry.fixedGroup.style.display = node.mode === 'fixed' ? '' : 'none';
        entry.neutralGroup.style.display = node.mode === 'balancing' ? '' : 'none';
        persist();
      });
    }
    if (entry.fcrSlider) {
      entry.fcrSlider.addEventListener('input', () => {
        const v = parseFloat(entry.fcrSlider.value);
        entry.fcrVal.textContent = Math.round(v) + ' MW';
        node.fcrHeadroom = v;
      });
      entry.fcrSlider.addEventListener('change', () => persist());
    }
    if (entry.droopSlider) {
      entry.droopSlider.addEventListener('input', () => {
        const d = parseFloat(entry.droopSlider.value);
        entry.droopVal.textContent = d + '%';
        node.droop = d / 100;
      });
      entry.droopSlider.addEventListener('change', () => persist());
    }
    if (entry.fixedSlider) {
      entry.fixedSlider.addEventListener('input', () => {
        const v = parseFloat(entry.fixedSlider.value);
        entry.fixedVal.textContent = (v >= 0 ? '+' : '') + Math.round(v) + ' MW';
        node.fixedTarget = v;
      });
      entry.fixedSlider.addEventListener('change', () => persist());
    }
    if (entry.bcSlider) {
      entry.bcSlider.addEventListener('input', () => {
        const v = parseFloat(entry.bcSlider.value);
        entry.bcVal.textContent = (v >= 0 ? '+' : '') + Math.round(v) + ' MW';
        node.baselineContract = v;
      });
      entry.bcSlider.addEventListener('change', () => persist());
    }
    if (entry.shutdownBtn) {
      entry.shutdownBtn.addEventListener('click', () => {
        node.tripped = !node.tripped;
        if (node.tripped) node.mwResponse = 0;
        entry.shutdownBtn.textContent = node.tripped ? '🔄 Restart' : '🛑 Shut Down';
        entry.shutdownBtn.style.background = node.tripped ? '#27ae60' : 'transparent';
        entry.shutdownBtn.style.color = node.tripped ? '#fff' : '#c0392b';
        persist();
      });
    }
  }

  if (node.type === 'load') {
    panel.innerHTML = `
      <div class="settings-header"><span class="settings-title">Load ${tag}</span><span class="settings-close" data-action="close-settings">&times;</span></div>
      <div class="settings-body">
        <div class="settings-row"><label class="settings-label">MW</label>
          <div class="settings-slider-group">
            <input type="range" class="load-slider" min="0" max="500" value="${node.mw || 10}">
            <span class="load-value">${Math.round(node.mw || 10)} MW</span>
          </div>
        </div>
        <div class="settings-row"><label class="settings-label">Noise</label>
          <div class="settings-slider-group" style="gap:6px;">
            <label style="font-size:12px;color:#555;"><input type="checkbox" class="noise-check" ${node.noiseEnabled ? 'checked' : ''}> Enable</label>
            <div style="display:flex;gap:4px;align-items:center;">
              <span style="font-size:10px;color:#888;">Min:</span>
              <input type="number" class="noise-min" value="${node.noiseMin || 100}" style="width:50px;font-size:11px;">
              <span style="font-size:10px;color:#888;">Max:</span>
              <input type="number" class="noise-max" value="${node.noiseMax || 200}" style="width:50px;font-size:11px;">
            </div>
            <div><canvas class="demand-preview" data-node-id="${node.id}" width="240" height="50" style="width:240px;height:50px;border:1px solid #ddd;border-radius:4px;"></canvas></div>
          </div>
        </div>
      </div>`;

    const loadSlider = panel.querySelector('.load-slider');
    const loadVal = panel.querySelector('.load-value');
    loadSlider.addEventListener('input', () => {
      const v = parseFloat(loadSlider.value);
      loadVal.textContent = Math.round(v) + ' MW';
      node.mw = v;
      node.baseMw = v;
    });
    loadSlider.addEventListener('change', () => persist());

    const noiseCheck = panel.querySelector('.noise-check');
    noiseCheck.addEventListener('change', () => { node.noiseEnabled = noiseCheck.checked; persist(); });

    const noiseMin = panel.querySelector('.noise-min');
    noiseMin.addEventListener('change', () => { node.noiseMin = parseInt(noiseMin.value) || 100; });

    const noiseMax = panel.querySelector('.noise-max');
    noiseMax.addEventListener('change', () => { node.noiseMax = parseInt(noiseMax.value) || 200; });
  }

  // Close button
  panel.querySelector('.settings-close').addEventListener('click', () => closeSettings(nodeId));

  document.body.appendChild(panel);

  // Initial position
  const offset = Object.keys(openPanels).length * 20;
  panel.style.top = (80 + offset * 2) + 'px';
  panel.style.left = (canvas.getBoundingClientRect().right - panel.offsetWidth - 20 - offset) + 'px';

  // Drag
  panel.querySelector('.settings-header').addEventListener('mousedown', (e) => {
    dragPanel = panel; dragOff = { x: e.clientX - panel.offsetLeft, y: e.clientY - panel.offsetTop };
    panel.style.zIndex = Date.now(); e.preventDefault();
  });

  openPanels[nodeId] = entry;
}

export function closeSettings(nodeId) {
  if (openPanels[nodeId]) {
    openPanels[nodeId].panel.remove();
    delete openPanels[nodeId];
  }
}

// ─── Line Settings ─────────────────────────────────────────────────────

export function openLineSettings(connId) {
  const existing = document.getElementById('line-settings-panel');
  if (existing) existing.remove();

  const conn = state.connections.find(c => c.id === connId);
  if (!conn) return;
  const src = state.nodes.find(n => n.id === conn.sourceId);
  const tgt = state.nodes.find(n => n.id === conn.targetId);
  const label = (src ? src.shortId || src.id.slice(-4) : '?') + ' ↔ ' + (tgt ? tgt.shortId || tgt.id.slice(-4) : '?');

  const panel = document.createElement('div');
  panel.id = 'line-settings-panel';
  panel.className = 'settings-panel';
  panel.style.zIndex = Date.now();

  panel.innerHTML = `
    <div class="settings-header"><span class="settings-title">Line ${label}</span><span class="settings-close">&times;</span></div>
    <div class="settings-body">
      <div class="settings-row"><label class="settings-label">Reactance (pu)</label>
        <div class="settings-slider-group">
          <input type="range" class="line-reactance-slider" min="0.001" max="0.5" step="0.001" value="${conn.reactance || 0.1}">
          <span class="line-reactance-value">${(conn.reactance || 0.1).toFixed(3)}</span>
        </div>
      </div>
      <div class="settings-row"><label class="settings-label">Thermal Limit (MW)</label>
        <div class="settings-slider-group">
          <input type="range" class="line-thermal-slider" min="1" max="500" value="${conn.thermalLimit || 100}">
          <span class="line-thermal-value">${Math.round(conn.thermalLimit || 100)} MW</span>
        </div>
      </div>
      <div class="settings-row"><label class="settings-label">Status</label>
        <div class="settings-slider-group" style="justify-content:flex-end;">
          <span style="font-size:13px;font-weight:500;color:${conn.tripped ? '#c0392b' : '#27ae60'};">${conn.tripped ? '🛑 Tripped' : '✅ Active'} | ${(conn.loadingPct || 0).toFixed(0)}%</span>
        </div>
      </div>
    </div>`;

  const reactSlider = panel.querySelector('.line-reactance-slider');
  const reactVal = panel.querySelector('.line-reactance-value');
  reactSlider.addEventListener('input', () => {
    const v = parseFloat(reactSlider.value);
    reactVal.textContent = v.toFixed(3);
    conn.reactance = v;
  });
  reactSlider.addEventListener('change', () => persist());

  const thermalSlider = panel.querySelector('.line-thermal-slider');
  const thermalVal = panel.querySelector('.line-thermal-value');
  thermalSlider.addEventListener('input', () => {
    const v = parseFloat(thermalSlider.value);
    thermalVal.textContent = Math.round(v) + ' MW';
    conn.thermalLimit = v;
  });
  thermalSlider.addEventListener('change', () => persist());

  panel.querySelector('.settings-close').addEventListener('click', () => panel.remove());

  document.body.appendChild(panel);
  const rect = canvas.getBoundingClientRect();
  panel.style.top = '100px'; panel.style.left = (rect.right - panel.offsetWidth - 20) + 'px';
  panel.querySelector('.settings-header').addEventListener('mousedown', (e) => {
    dragPanel = panel; dragOff = { x: e.clientX - panel.offsetLeft, y: e.clientY - panel.offsetTop };
    panel.style.zIndex = Date.now(); e.preventDefault();
  });
}

// ─── Merit Order Panel ────────────────────────────────────────────────
