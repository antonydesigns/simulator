// ─── SettingsPanel ─────────────────────────────────────────────────

export class SettingsPanel {
  constructor(store, engine, renderer, persister, statsPanel) {
    this.store = store;
    this.engine = engine;
    this.renderer = renderer;
    this.persister = persister;
    this.statsPanel = statsPanel;
  }

  openSettings(nodeId) {
    const { state, sim, openPanels, ISLAND_COLORS } = this.store;
  
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

    // Baseline Contract slider (updated by market, but user can tweak)
    const baselineSlider = panel.querySelector('.baseline-slider');
    const baselineVal = panel.querySelector('.baseline-value');
    entry.baselineSlider = baselineSlider;
    entry.baselineVal = baselineVal;
    baselineSlider.addEventListener('input', () => {
      const v = parseFloat(baselineSlider.value);
      baselineVal.textContent = Math.round(v) + ' MW';
      node.baselineContract = v;
    });
    baselineSlider.addEventListener('change', () => this.persister.persist());

    // Rating slider
    const ratingSlider = panel.querySelector('.rating-slider');
    const ratingVal = panel.querySelector('.rating-value');
    ratingSlider.addEventListener('input', () => {
      const v = parseFloat(ratingSlider.value);
      ratingVal.textContent = v + ' MVA';
      node.rating = v;
      if (fcrSlider) fcrSlider.max = v;
      if (bidQtySlider) bidQtySlider.max = v;
      if (baselineSlider) baselineSlider.max = v;
    });
    ratingSlider.addEventListener('change', () => this.persister.persist());

    // Bid Price slider
    const bidPriceSlider = panel.querySelector('.bid-price-slider');
    const bidPriceVal = panel.querySelector('.bid-price-value');
    if (bidPriceSlider) {
      bidPriceSlider.addEventListener('input', () => {
        const v = parseFloat(bidPriceSlider.value);
        bidPriceVal.textContent = '$' + v.toFixed(1) + '/MWh';
        node.bidPrice = v;
      });
      bidPriceSlider.addEventListener('change', () => this.persister.persist());
    }

    // Bid Qty slider
    const bidQtySlider = panel.querySelector('.bid-qty-slider');
    const bidQtyVal = panel.querySelector('.bid-qty-value');
    if (bidQtySlider) {
      bidQtySlider.addEventListener('input', () => {
        const v = parseFloat(bidQtySlider.value);
        bidQtyVal.textContent = Math.round(v) + ' MWh';
        node.bidQty = v;
      });
      bidQtySlider.addEventListener('change', () => this.persister.persist());
    }

    // FCR Headroom slider
    const fcrSlider = panel.querySelector('.fcr-headroom-slider');
    const fcrVal = panel.querySelector('.fcr-headroom-value');
    fcrSlider.addEventListener('input', () => {
      const v = parseFloat(fcrSlider.value);
      fcrVal.textContent = Math.round(v) + ' MW';
      node.fcrHeadroom = v;
    });
    fcrSlider.addEventListener('change', () => this.persister.persist());

    // Inertia slider
    const inertiaSlider = panel.querySelector('.inertia-slider');
    const inertiaVal = panel.querySelector('.inertia-value');
    inertiaSlider.addEventListener('input', () => {
      const v = parseFloat(inertiaSlider.value);
      inertiaVal.textContent = v.toFixed(1) + 's';
      node.inertia = v;
    });
    inertiaSlider.addEventListener('change', () => this.persister.persist());

    // Droop slider
    const droopSlider = panel.querySelector('.droop-slider');
    const droopVal = panel.querySelector('.droop-value');
    droopSlider.addEventListener('input', () => {
      const d = parseFloat(droopSlider.value);
      droopVal.textContent = d + '%';
      node.droop = d / 100;
    });
    droopSlider.addEventListener('change', () => this.persister.persist());

    // Turbine TC slider
    const tcSlider = panel.querySelector('.tc-slider');
    const tcVal = panel.querySelector('.tc-value');
    tcSlider.addEventListener('input', () => {
      const v = parseFloat(tcSlider.value);
      tcVal.textContent = v.toFixed(1) + 's';
      node.turbineTimeConstant = v;
    });
    tcSlider.addEventListener('change', () => this.persister.persist());

    // Ramp-Down TC slider
    const rdSlider = panel.querySelector('.rd-slider');
    const rdVal = panel.querySelector('.rd-value');
    rdSlider.addEventListener('input', () => {
      const v = parseFloat(rdSlider.value);
      rdVal.textContent = v.toFixed(2) + 's';
      node.rampDownTC = v;
    });
    rdSlider.addEventListener('change', () => this.persister.persist());

    // Mode select
    const modeSelect = panel.querySelector('.gen-mode-select');
    if (modeSelect) {
      modeSelect.addEventListener('change', () => {
        node.mode = modeSelect.value;
        // Toggle market rows visibility (hidden for fixed mode)
        const marketRows = panel.querySelectorAll('.market-row');
        for (const row of marketRows) {
          row.style.display = modeSelect.value === 'fixed' ? 'none' : '';
        }
        this.persister.persist();
      });
    }

    // Gen shutdown button
    const genShutdownBtn = panel.querySelector('.gen-shutdown-btn');
    if (genShutdownBtn) {
      genShutdownBtn.addEventListener('click', () => {
        node.tripped = !node.tripped;
        if (node.tripped) node.mw = 0;
        this.persister.persist();
        genShutdownBtn.textContent = node.tripped ? '🔄 Restart' : '🛑 Shut Down';
        genShutdownBtn.style.background = node.tripped ? '#27ae60' : 'transparent';
        genShutdownBtn.style.color = node.tripped ? '#fff' : '#c0392b';
      });
      entry.shutdownBtn = genShutdownBtn;
    }

  } else if (node.type === 'storage') {
    const socVal = Math.round(node.mw || 0);
    const chgR = node.chargeRate || 50;
    const dchgR = node.dischargeRate || 50;
    const cap = node.maxCapacity || 100;
    const fcr = node.fcrHeadroom || 10;
    const drop = Math.round((node.droop || 0.04) * 100);
    const ft = node.fixedTarget || 0;
    const mode = node.mode || 'balancing';

    panel.innerHTML = `
      <div class="settings-header"><span class="settings-title">Storage ${tag}</span><span class="settings-close" data-action="close-settings">&times;</span></div>
      <div class="settings-body">
        <div class="settings-row"><label class="settings-label">State of Charge</label><div class="settings-slider-group"><input type="range" class="soc-slider" min="0" max="${cap}" step="0.1" value="${socVal}"><span class="settings-value-display storage-soc">${socVal} MWh</span></div></div>
        <div class="storage-fcr-group">
          <div class="settings-row"><label class="settings-label">Baseline Contract</label><div class="settings-slider-group"><input type="range" class="baseline-contract-slider" min="${-chgR}" max="${dchgR}" step="1" value="${node.baselineContract || 0}"><span class="baseline-contract-value">${(node.baselineContract || 0) >= 0 ? '+' : ''}${node.baselineContract || 0} MW</span></div></div>
          <div class="settings-row"><label class="settings-label">FCR Headroom</label><div class="settings-slider-group"><input type="range" class="fcr-headroom-slider" min="1" max="${Math.max(chgR, dchgR)}" step="1" value="${fcr}"><span class="fcr-headroom-value">${fcr} MW</span></div></div>
          <div class="settings-row"><label class="settings-label">Droop</label><div class="settings-slider-group"><input type="range" class="droop-slider" min="0.5" max="20" step="0.5" value="${drop}"><span class="droop-value">${drop}%</span></div></div>
        </div>
        <div class="storage-neutral-group" style="display:${mode === 'balancing' ? '' : 'none'}">
          <div class="settings-row" title="When enabled, AGC offset slowly decays to zero after frequency stabilizes (~60s). Prevents SoC drift and frees headroom by letting other units absorb the imbalance. Only active in Balancing mode.">
            <label class="settings-label" style="font-size:11px">Energy-Neutrality ⓘ</label>
            <div class="settings-slider-group">
              <label style="display:flex;align-items:center;gap:6px;cursor:pointer;user-select:none;font-size:12px;color:#aaa">
                <input type="checkbox" class="energy-neutral-checkbox" ${node.energyNeutral ? 'checked' : ''}>
                <span>return to baseline after disturbance</span>
              </label>
            </div>
          </div>
        </div>
        <div class="storage-fixed-group" style="display:${mode === 'fixed' ? '' : 'none'}">
          <div class="settings-row"><label class="settings-label">Target</label><div class="settings-slider-group"><input type="range" class="fixed-target-slider" min="${-chgR}" max="${dchgR}" step="1" value="${ft}"><span class="fixed-target-value">${ft >= 0 ? '+' : ''}${ft} MW</span></div></div>
        </div>
        <div class="settings-row"><label class="settings-label">Discharge Rate</label><div class="settings-slider-group"><input type="range" class="discharge-slider" min="1" max="500" step="1" value="${dchgR}"><span class="discharge-value">${dchgR} MW</span></div></div>
        <div class="settings-row"><label class="settings-label">Charge Rate</label><div class="settings-slider-group"><input type="range" class="charge-slider" min="1" max="500" step="1" value="${chgR}"><span class="charge-value">${chgR} MW</span></div></div>
        <div class="settings-row"><label class="settings-label">Max Capacity</label><div class="settings-slider-group"><input type="range" class="capacity-slider" min="10" max="1000" step="10" value="${cap}"><span class="capacity-value">${cap} MWh</span></div></div>
        <div class="settings-row sep-top"><label class="settings-label">Mode</label>
          <div class="settings-slider-group">
            <select class="storage-mode-select">
              <option value="balancing" ${mode === 'balancing' ? 'selected' : ''}>Balancing (FCR + AGC)</option>
              <option value="fcr-only" ${mode === 'fcr-only' ? 'selected' : ''}>FCR Only</option>
              <option value="grid-forming" ${mode === 'grid-forming' ? 'selected' : ''}>Grid Forming</option>
              <option value="fixed" ${mode === 'fixed' ? 'selected' : ''}>Fixed</option>
            </select>
          </div>
        </div>
        <div class="settings-row sep-top"><button class="storage-shutdown-btn" style="width:100%;padding:6px 0;border:1px solid #c0392b;border-radius:4px;cursor:pointer;font-size:13px;background:${node.tripped ? '#27ae60' : 'transparent'};color:${node.tripped ? '#fff' : '#c0392b'}">${node.tripped ? '🔄 Restart' : '🛑 Shut Down'}</button></div>
      </div>
            <div class="settings-resize-handle"></div>`;

    entry.socEl = panel.querySelector('.storage-soc');
    entry.mwRespEl = panel.querySelector('.storage-mw-response');
    entry.modeSelect = panel.querySelector('.storage-mode-select');
    entry.fcrGroup = panel.querySelector('.storage-fcr-group');
    entry.fixedGroup = panel.querySelector('.storage-fixed-group');

    // SoC slider
    const socSlider = panel.querySelector('.soc-slider');
    socSlider.addEventListener('input', () => { const v = parseFloat(socSlider.value); node.mw = Math.min(v, node.maxCapacity || 100); entry.socEl.textContent = v.toFixed(2) + ' MWh'; });
    socSlider.addEventListener('change', () => this.persister.persist());

    // Baseline contract (dispatch) slider
    const bcSlider = panel.querySelector('.baseline-contract-slider');
    const bcVal = panel.querySelector('.baseline-contract-value');
    bcSlider.addEventListener('input', () => {
      const v = parseInt(bcSlider.value, 10);
      bcVal.textContent = (v >= 0 ? '+' : '') + v + ' MW';
      node.baselineContract = v;
    });
    bcSlider.addEventListener('change', () => this.persister.persist());
    entry.bcSlider = bcSlider;
    entry.bcVal = bcVal;

    // Mode select
    entry.neutralGroup = panel.querySelector('.storage-neutral-group');
    const neutralCb = panel.querySelector('.energy-neutral-checkbox');
    neutralCb.addEventListener('change', () => {
      node.energyNeutral = neutralCb.checked;
      this.persister.persist();
    });

    entry.modeSelect.addEventListener('change', () => {
      node.mode = entry.modeSelect.value;
      entry.fcrGroup.style.display = (node.mode === 'balancing' || node.mode === 'fcr-only' || node.mode === 'grid-forming') ? '' : 'none';
      entry.fixedGroup.style.display = node.mode === 'fixed' ? '' : 'none';
      if (entry.neutralGroup) entry.neutralGroup.style.display = node.mode === 'balancing' ? '' : 'none';
      this.persister.persist();
    });

    // Storage shutdown button
    const stShutdownBtn = panel.querySelector('.storage-shutdown-btn');
    if (stShutdownBtn) {
      stShutdownBtn.addEventListener('click', () => {
        node.tripped = !node.tripped;
        if (node.tripped) { node.mwResponse = 0; node.mw = node.mw || 0; }
        this.persister.persist();
        stShutdownBtn.textContent = node.tripped ? '🔄 Restart' : '🛑 Shut Down';
        stShutdownBtn.style.background = node.tripped ? '#27ae60' : 'transparent';
        stShutdownBtn.style.color = node.tripped ? '#fff' : '#c0392b';
      });
      entry.shutdownBtn = stShutdownBtn;
    }

    // FCR headroom slider
    const fcrSlider = panel.querySelector('.fcr-headroom-slider');
    const fcrVal = panel.querySelector('.fcr-headroom-value');
    entry.fcrSlider = fcrSlider;
    entry.fcrVal = fcrVal;
    fcrSlider.addEventListener('input', () => { const v = parseInt(fcrSlider.value, 10); fcrVal.textContent = v + ' MW'; node.fcrHeadroom = v; });
    fcrSlider.addEventListener('change', () => this.persister.persist());

    // Droop slider
    const droopSlider = panel.querySelector('.droop-slider');
    const droopVal = panel.querySelector('.droop-value');
    entry.droopSlider = droopSlider;
    entry.droopVal = droopVal;
    droopSlider.addEventListener('input', () => { const v = parseFloat(droopSlider.value); droopVal.textContent = v + '%'; node.droop = v / 100; });
    droopSlider.addEventListener('change', () => this.persister.persist());

    // Fixed target slider
    const fixedSlider = panel.querySelector('.fixed-target-slider');
    const fixedVal = panel.querySelector('.fixed-target-value');
    entry.fixedSlider = fixedSlider;
    entry.fixedVal = fixedVal;
    fixedSlider.addEventListener('input', () => { const v = parseInt(fixedSlider.value, 10); fixedVal.textContent = (v >= 0 ? '+' : '') + v + ' MW'; node.fixedTarget = v; });
    fixedSlider.addEventListener('change', () => this.persister.persist());

    // Charge/discharge dual-range sliders
    const chg = panel.querySelector('.charge-slider'), chgV = panel.querySelector('.charge-value');
    const dchg = panel.querySelector('.discharge-slider'), dchgV = panel.querySelector('.discharge-value');
    chg.addEventListener('input', () => { const v = parseInt(chg.value, 10); chgV.textContent = v + ' MW'; node.chargeRate = v; fixedSlider.min = -v; });
    chg.addEventListener('change', () => this.persister.persist());
    dchg.addEventListener('input', () => { const v = parseInt(dchg.value, 10); dchgV.textContent = v + ' MW'; node.dischargeRate = v; fixedSlider.max = v; });
    dchg.addEventListener('change', () => this.persister.persist());

    // Capacity slider
    const capSlider = panel.querySelector('.capacity-slider'), capV = panel.querySelector('.capacity-value');
    capSlider.addEventListener('input', () => { const v = parseInt(capSlider.value, 10); capV.textContent = v + ' MWh'; node.maxCapacity = v; if (node.mw > v) { node.mw = v; entry.socEl.textContent = v.toFixed(2) + ' MWh'; socSlider.max = v; } });
    capSlider.addEventListener('change', () => this.persister.persist());

  } else {
    panel.innerHTML = `
      <div class="settings-header"><span class="settings-title">Load ${tag}</span><span class="settings-close" data-action="close-settings">&times;</span></div>
      <div class="settings-body">
        <div class="settings-row">
          <label class="settings-label">Auto Demand Curve</label>
          <label class="toggle-switch">
            <input type="checkbox" class="noise-toggle" ${node.noiseEnabled ? 'checked' : ''}>
            <span class="toggle-slider"></span>
          </label>
        </div>
        <div class="settings-row noise-row"${node.noiseEnabled ? '' : ' style="display:none"'}>
          <label class="settings-label">Min (MW)</label>
          <div class="settings-slider-group"><input type="range" class="noise-min-slider" min="0" max="500" step="10" value="${node.noiseMin || 100}"><span class="noise-min-value">${node.noiseMin || 100}</span></div>
        </div>
        <div class="settings-row noise-row"${node.noiseEnabled ? '' : ' style="display:none"'}>
          <label class="settings-label">Max (MW)</label>
          <div class="settings-slider-group"><input type="range" class="noise-max-slider" min="0" max="500" step="10" value="${node.noiseMax || 200}"><span class="noise-max-value">${node.noiseMax || 200}</span></div>
        </div>
        <div class="settings-row noise-row"${node.noiseEnabled ? '' : ' style="display:none"'}>
          <label class="settings-label">Noise ±%</label>
          <div class="settings-slider-group"><input type="range" class="noise-pct-slider" min="0" max="100" step="1" value="${node.noisePct || 10}"><span class="noise-pct-value">${node.noisePct || 10}%</span></div>
        </div>
        <div class="settings-row noise-row"${node.noiseEnabled ? '' : ' style="display:none"'}>
          <canvas class="demand-preview" width="320" height="80" data-node-id="${node.id}"></canvas>
        </div>
        <div class="settings-row manual-row"${node.noiseEnabled ? ' style="display:none"' : ''}>
          <label class="settings-label">Demand (MW)</label>
          <div class="settings-slider-group"><input type="range" class="mw-slider" min="0" max="500" step="10" value="${node.mw || 10}"><span class="mw-value">${node.mw || 10}</span></div>
        </div>
      </div>
      <div class="settings-row shed-row">
          <label class="settings-label">UFLS Shed</label>
          <span class="shed-status">SHD ${Math.round((node.shedPct || 0) * 100)}%</span>
          <button class="shed-restore-btn">Restore</button>
        </div>
      <div class="settings-resize-handle"></div>`;

    const slider = panel.querySelector('.mw-slider'), valEl = panel.querySelector('.mw-value');
    slider.addEventListener('input', () => { const v = parseInt(slider.value, 10); valEl.textContent = v; node.mw = v; node.baseMw = v; this.renderer.draw(); });
    slider.addEventListener('change', () => this.persister.persist());

    const noiseToggle = panel.querySelector('.noise-toggle');
    noiseToggle.addEventListener('change', () => {
      node.noiseEnabled = noiseToggle.checked;
      // Show/hide noise rows and manual row
      for (const el of panel.querySelectorAll('.noise-row')) el.style.display = noiseToggle.checked ? '' : 'none';
      const manualRow = panel.querySelector('.manual-row');
      if (manualRow) manualRow.style.display = noiseToggle.checked ? 'none' : '';
      this.renderer.draw();
      this.persister.persist();
    });

    const noiseMinSlider = panel.querySelector('.noise-min-slider');
    const noiseMinVal = panel.querySelector('.noise-min-value');
    if (noiseMinSlider) {
      noiseMinSlider.addEventListener('input', () => {
        const v = parseInt(noiseMinSlider.value, 10);
        noiseMinVal.textContent = v;
        node.noiseMin = v;
        this.renderer.drawLoadCurvePreview(panel.querySelector('.demand-preview'), node);
        this.renderer.draw();
      });
      noiseMinSlider.addEventListener('change', () => this.persister.persist());
    }

    const noiseMaxSlider = panel.querySelector('.noise-max-slider');
    const noiseMaxVal = panel.querySelector('.noise-max-value');
    if (noiseMaxSlider) {
      noiseMaxSlider.addEventListener('input', () => {
        const v = parseInt(noiseMaxSlider.value, 10);
        noiseMaxVal.textContent = v;
        node.noiseMax = v;
        this.renderer.drawLoadCurvePreview(panel.querySelector('.demand-preview'), node);
        this.renderer.draw();
      });
      noiseMaxSlider.addEventListener('change', () => this.persister.persist());
    }

    const noisePctSlider = panel.querySelector('.noise-pct-slider');
    const noisePctVal = panel.querySelector('.noise-pct-value');
    if (noisePctSlider) {
      noisePctSlider.addEventListener('input', () => {
        const v = parseInt(noisePctSlider.value, 10);
        noisePctVal.textContent = v + '%';
        node.noisePct = v;
      });
      noisePctSlider.addEventListener('change', () => this.persister.persist());
    }

    // Draw the preview canvas on open
    const previewCanvas = panel.querySelector('.demand-preview');
    if (previewCanvas) this.renderer.drawLoadCurvePreview(previewCanvas, node);

    // Load shed restore
    const shedRow = panel.querySelector('.shed-row');
    // Hide shed row initially if no active shedding
    if (shedRow) shedRow.style.display = (node.shedPct || 0) > 0 ? '' : 'none';
    const shedRestoreBtn = panel.querySelector('.shed-restore-btn');
    if (shedRestoreBtn) {
      shedRestoreBtn.addEventListener('click', () => {
        node.shedPct = 0;
        node.shedTimer = 0;
        if (!node.noiseEnabled) {
          node.mw = node.baseMw || node.mw || 10;
        }
        if (shedRow) shedRow.style.display = 'none';
        // Don't re-balance — let FCR/AGC handle the restored load naturally
        this.renderer.draw();
        this.persister.persist();
      });
    }
  }

  const count = Object.keys(openPanels).length;
  panel.style.left = (120 + count * 28) + 'px'; panel.style.top = (80 + count * 28) + 'px';
  document.body.appendChild(panel);

  panel.querySelector('[data-action="close-settings"]').addEventListener('click', (e) => { e.stopPropagation(); this.closeSettings(nodeId); });

  panel.addEventListener('mousedown', (e) => {
    if (e.target.closest('.settings-header')) { this.store.dragPanel = panel; this.store.dragOff = { x: e.clientX - panel.offsetLeft, y: e.clientY - panel.offsetTop }; panel.style.zIndex = Date.now(); e.preventDefault(); }
    if (e.target.closest('.settings-resize-handle')) { this.store.resizePanel = panel; this.store.resizeStart = { x: e.clientX, y: e.clientY, w: panel.offsetWidth, h: panel.offsetHeight }; panel.style.zIndex = Date.now(); e.preventDefault(); }
  });

  openPanels[nodeId] = entry;
}

  refreshNodePanels() {
    const { openPanels } = this.store;
    for (const [nodeId, entry] of Object.entries(openPanels)) {
      const node = this.store.state.nodes.find(n => n.id === nodeId);
      if (!node || node.type !== 'load') continue;
      const shedRow = entry.panel.querySelector('.shed-row');
      if (!shedRow) continue;
      const isShed = (node.shedPct || 0) > 0;
      shedRow.style.display = isShed ? '' : 'none';
    }
  }

  closeSettings(nodeId) {
    const { state, sim, openPanels, ISLAND_COLORS } = this.store;
   if (openPanels[nodeId]) { openPanels[nodeId].panel.remove(); delete openPanels[nodeId]; } }

  openLineSettings(connId) {
    const { state, sim, openPanels, ISLAND_COLORS } = this.store;
  
  const conn = state.connections.find(c => c.id === connId);
  if (!conn) return;
  // Close existing line settings
  if (openPanels['_line_' + connId]) { openPanels['_line_' + connId].panel.style.zIndex = Date.now(); return; }

  const panel = document.createElement('div');
  panel.className = 'settings-panel'; panel.style.zIndex = Date.now();
  panel.dataset.nodeId = '_line_' + connId;
  const src = state.nodes.find(n => n.id === conn.sourceId);
  const tgt = state.nodes.find(n => n.id === conn.targetId);
  const tag = (src ? (src.shortId || src.id.slice(-4)) : '?') + ' → ' + (tgt ? (tgt.shortId || tgt.id.slice(-4)) : '?');

  const x = (conn.reactance || 0.1);
  const t = conn.thermalLimit || 100;

  panel.innerHTML = `
    <div class="settings-header"><span class="settings-title">Line ${tag}</span><span class="settings-close" data-action="close-settings">&times;</span></div>
    <div class="settings-body">
      <div class="settings-row"><label class="settings-label">Reactance (p.u.)</label>
        <div class="settings-slider-group">
          <input type="range" min="0.001" max="1" step="0.001" value="${x}">
          <span class="settings-value-display">${x.toFixed(3)}</span>
        </div>
      </div>
      <div class="settings-row"><label class="settings-label">Thermal Limit (MW)</label>
        <div class="settings-slider-group">
          <input type="range" min="1" max="500" step="1" value="${t}">
          <span class="settings-value-display">${t} MW</span>
        </div>
      </div>
    </div>
  `;

  document.body.appendChild(panel);
  panel.style.left = Math.min(window.innerWidth - 240, Math.max(10, (window.innerWidth - 220) / 2)) + 'px';
  panel.style.top = Math.min(window.innerHeight - 200, Math.max(10, 80)) + 'px';

  const entry = { panel };
  const xSlider = panel.querySelectorAll('input[type="range"]')[0];
  const tSlider = panel.querySelectorAll('input[type="range"]')[1];
  const xVal = panel.querySelectorAll('.settings-value-display')[0];
  const tVal = panel.querySelectorAll('.settings-value-display')[1];

  xSlider.addEventListener('input', () => {
    const v = parseFloat(xSlider.value);
    xVal.textContent = v.toFixed(3);
    conn.reactance = v;
  });
  xSlider.addEventListener('change', () => this.persister.persist());

  tSlider.addEventListener('input', () => {
    const v = parseInt(tSlider.value, 10);
    tVal.textContent = v + ' MW';
    conn.thermalLimit = v;
  });
  tSlider.addEventListener('change', () => this.persister.persist());

  // Close button
  panel.querySelector('.settings-close').addEventListener('click', () => {
    panel.remove();
    delete openPanels['_line_' + connId];
  });

  // Make draggable
  panel.querySelector('.settings-header').addEventListener('mousedown', (e) => {
    if (e.target.closest('.settings-close')) return;
    this.store.dragPanel = panel;
    this.store.dragOff = { x: e.clientX - panel.offsetLeft, y: e.clientY - panel.offsetTop };
    panel.style.zIndex = Date.now();
    e.preventDefault();
  });

  openPanels['_line_' + connId] = entry;
}
}
