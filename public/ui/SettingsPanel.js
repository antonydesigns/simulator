// ─── SettingsPanel ─────────────────────────────────────────────────

const $tip = (text) => `<span title="${text}" style="cursor:help;margin-left:4px;font-size:12px;color:#999">ⓘ</span>`;

function genModeFieldsHTML(node, mode) {
  const rating = node.rating || 100;
  const commMW = node.committedMW || 0;
  const fcrH = node.fcrHeadroom || 10;
  const bidPrice = node.bidPrice || 50;
  const isMarket = mode === 'merchant' || mode === 'balancing';
  const fcrLocked = mode === 'load-follow' || mode === 'balancing';
  const fcrEnabled = node.fcrEnabled !== undefined ? node.fcrEnabled : true;
  const agcEnabled = node.agcEnabled !== undefined ? node.agcEnabled : true;
  const commMin = mode === 'load-follow' ? 0 : 1;
  const commLabel = isMarket ? 'Committed MW' : 'Committed MW';
  // Only include bid price-related fields for market modes
  let priceHTML = '';
  if (isMarket) {
    priceHTML = `
      <div class="settings-row">
        <label class="settings-label">
          Offer price ($/MW) ${$tip('Price bid into merit order. Lower-priced units dispatched first. Negative prices allowed.')}
        </label>
        <div class="settings-slider-group">
          <input type="number" class="offer-price-input" step="0.1" value="${bidPrice}" style="width:80px;padding:2px 6px;background:#f5f3ee;border:1px solid #d6d2c8;border-radius:4px;text-align:right;">
          <span style="font-size:12px;color:#888">$/MWh</span>
        </div>
      </div>`;
  }
  return `
    <div class="settings-row">
      <label class="settings-label">
        ${commLabel} ${$tip('Your commitment into the market or schedule. Dispatched MW (base) in the output breakdown may differ.')}
      </label>
      <div class="settings-slider-group">
        <input type="range" class="baseline-slider" min="${commMin}" max="${rating}" value="${commMW}">
        <span class="baseline-value">${Math.round(commMW)} MW</span>
      </div>
    </div>
    ${priceHTML}
    <div class="settings-row fcr-row">
      <label class="settings-label">
        Frequency Containment Reserve ${$tip(fcrLocked ? 'Governor droop responds instantly to frequency deviations. Always active for this mode.' : 'Governor droop responds instantly to frequency deviations. Enable for primary frequency response.')}
      </label>
      <div class="settings-slider-group">
        ${fcrLocked
          ? `<span style="font-size:12px;color:#999">enabled</span>`
          : `<label style="display:flex;align-items:center;gap:6px;cursor:pointer;user-select:none;font-size:12px;color:#aaa">
              <input type="checkbox" class="fcr-toggle" ${fcrEnabled ? 'checked' : ''}>
              <span>enabled</span>
            </label>`}
      </div>
    </div>
    <div class="settings-row fcr-headroom-row" style="display:${fcrEnabled || fcrLocked ? '' : 'none'}">
      <label class="settings-label">FCR Headroom</label>
      <div class="settings-slider-group">
        <input type="range" class="fcr-headroom-slider" min="0" max="${rating}" value="${fcrH}">
        <span class="fcr-headroom-value">${Math.round(fcrH)} MW</span>
      </div>
    </div>
    ${(mode === 'load-follow' || mode === 'balancing') ? `
    <div class="settings-row agc-row">
      <label class="settings-label">
        Automatic Frequency Restoration Reserve ${$tip('Secondary control that restores frequency to 50 Hz over time.')}
      </label>
      <div class="settings-slider-group">
        <label style="display:flex;align-items:center;gap:6px;cursor:pointer;user-select:none;font-size:12px;color:#aaa">
          <input type="checkbox" class="agc-toggle" ${agcEnabled ? 'checked' : ''}>
          <span>enabled</span>
        </label>
      </div>
    </div>` : ''}`;
}

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
    const mode = node.mode || 'balancing';
    const rating = node.rating || 100;
    const bc = node.baselineContract || 0;
    const isMarket = mode === 'merchant' || mode === 'balancing';
    const fcrLocked = mode === 'load-follow' || mode === 'balancing';
    const fcrEnabled = node.fcrEnabled !== undefined ? node.fcrEnabled : true;
    const agcEnabled = node.agcEnabled !== undefined ? node.agcEnabled : true;

    // Compute initial output breakdown
    const dev = (state.frequency - 50) / 50;
    const govMod = -(1 / (node.droop || 0.04)) * dev * rating;

    panel.innerHTML = `
      <div class="settings-header"><span class="settings-title">Generator ${tag}</span><span class="settings-close" data-action="close-settings">&times;</span></div>
      <div class="settings-body">
        <div class="settings-row">
          <label class="settings-label">
            Output ${$tip('Real-time electrical output: base + FCR + AGC contributions.')}
          </label>
          <div class="settings-slider-group" style="justify-content:flex-end;">
            <span class="gen-output" style="font-size:14px;font-weight:600;">${Math.round(node.mw || 0)} MW</span>
          </div>
        </div>
        <div class="settings-row" style="margin-top:-4px">
          <div style="display:flex;gap:10px;font-size:11px;color:#999;padding-left:2px">
            <span>Base <span class="output-base">${Math.round(bc)}</span></span>
            <span>FCR <span class="output-fcr">${govMod >= 0 ? '+' : ''}${Math.round(govMod)}</span></span>
            <span>AGC <span class="output-agc">${(node.agcOffset || 0) >= 0 ? '+' : ''}${Math.round(node.agcOffset || 0)}</span></span>
          </div>
        </div>
        <!-- Mode dropdown (at top) -->
        <div class="settings-row">
          <label class="settings-label">Mode</label>
          <div class="settings-slider-group">
            <select class="gen-mode-select">
              <option value="fixed" ${mode === 'fixed' ? 'selected' : ''}>Fixed</option>
              <option value="load-follow" ${mode === 'load-follow' ? 'selected' : ''}>Load-Follow</option>
              <option value="merchant" ${mode === 'merchant' ? 'selected' : ''}>Merchant</option>
              <option value="balancing" ${mode === 'balancing' ? 'selected' : ''}>Balancing</option>
            </select>
          </div>
        </div>
        <!-- mode-specific fields -->
        <div class="mode-fields">${genModeFieldsHTML(node, mode)}</div>
        <!-- common technical settings -->
        <div class="settings-row sep-top">
          <label class="settings-label">Rating ${$tip('Maximum apparent power rating of the generator.')}</label>
          <div class="settings-slider-group">
            <input type="range" class="rating-slider" min="1" max="500" value="${rating}">
            <span class="rating-value">${rating} MVA</span>
          </div>
        </div>
        <div class="settings-row">
          <label class="settings-label">Inertia H ${$tip('Generator inertia constant (seconds). Higher = slower frequency change rate.')}</label>
          <div class="settings-slider-group">
            <input type="range" class="inertia-slider" min="0" max="20" step="0.5" value="${node.inertia || 5}">
            <span class="inertia-value">${(node.inertia || 5).toFixed(1)}s</span>
          </div>
        </div>
        <div class="settings-row">
          <label class="settings-label">Droop ${$tip('Governor droop percentage. Lower = stronger FCR response per Hz deviation.')}</label>
          <div class="settings-slider-group">
            <input type="range" class="droop-slider" min="0.5" max="20" step="0.5" value="${(node.droop || 0.04) * 100}">
            <span class="droop-value">${(node.droop || 0.04) * 100}%</span>
          </div>
        </div>
        <div class="settings-row">
          <label class="settings-label">Ramp Up TC ${$tip('Time constant for increasing output. Lower = faster ramp-up.')}</label>
          <div class="settings-slider-group">
            <input type="range" class="tc-slider" min="0.2" max="5" step="0.1" value="${node.turbineTimeConstant || 1}">
            <span class="tc-value">${(node.turbineTimeConstant || 1).toFixed(1)}s</span>
          </div>
        </div>
        <div class="settings-row">
          <label class="settings-label">Ramp Down TC ${$tip('Time constant for decreasing output. Lower = faster ramp-down.')}</label>
          <div class="settings-slider-group">
            <input type="range" class="rd-slider" min="0.05" max="2" step="0.05" value="${node.rampDownTC || 0.3}">
            <span class="rd-value">${(node.rampDownTC || 0.3).toFixed(2)}s</span>
          </div>
        </div>
        <div class="settings-row sep-top">
          <button class="gen-shutdown-btn" style="width:100%;padding:6px 0;border:1px solid #c0392b;border-radius:4px;cursor:pointer;font-size:13px;background:${node.tripped ? '#27ae60' : 'transparent'};color:${node.tripped ? '#fff' : '#c0392b'}">${node.tripped ? '🔄 Restart' : '🛑 Shut Down'}</button>
        </div>
      </div>`;

    entry.outputEl = panel.querySelector('.gen-output');
    entry.outputBase = panel.querySelector('.output-base');
    entry.outputFcr = panel.querySelector('.output-fcr');
    entry.outputAgc = panel.querySelector('.output-agc');

    // --- Committed MW slider ---
    const baselineSlider = panel.querySelector('.baseline-slider');
    const baselineVal = panel.querySelector('.baseline-value');
    entry.baselineSlider = baselineSlider;
    entry.baselineVal = baselineVal;
    baselineSlider.addEventListener('input', () => {
      const v = parseFloat(baselineSlider.value);
      baselineVal.textContent = Math.round(v) + ' MW';
      node.committedMW = v;
    });
    baselineSlider.addEventListener('change', () => this.persister.persist());

    // --- Offer price input (merchant/balancing only) ---
    const offerInput = panel.querySelector('.offer-price-input');
    if (offerInput) {
      // Prevent scroll wheel from changing value
      offerInput.addEventListener('wheel', (e) => {
        e.preventDefault();
        e.target.blur();
      });
      offerInput.addEventListener('input', () => {
        const v = parseFloat(offerInput.value);
        if (!isNaN(v)) node.bidPrice = v;
      });
      offerInput.addEventListener('change', () => this.persister.persist());
    }

    // --- FCR toggle ---
    const fcrToggle = panel.querySelector('.fcr-toggle');
    const fcrHeadroomRow = panel.querySelector('.fcr-headroom-row');
    if (fcrToggle) {
      // If mode is load-follow or balancing, fcr-only row will not have a toggle
      // (fcrLocked = true, so it's a text "enabled" instead)
      fcrToggle.addEventListener('change', () => {
        node.fcrEnabled = fcrToggle.checked;
        if (fcrHeadroomRow) {
          fcrHeadroomRow.style.display = node.fcrEnabled ? '' : 'none';
        }
        this.persister.persist();
      });
    }

    // --- FCR Headroom slider ---
    const fcrSlider = panel.querySelector('.fcr-headroom-slider');
    const fcrVal = panel.querySelector('.fcr-headroom-value');
    if (fcrSlider) {
      fcrSlider.addEventListener('input', () => {
        const v = parseFloat(fcrSlider.value);
        fcrVal.textContent = Math.round(v) + ' MW';
        node.fcrHeadroom = v;
      });
      fcrSlider.addEventListener('change', () => this.persister.persist());
    }

    // --- AGC toggle (load-follow / balancing only) ---
    const agcToggle = panel.querySelector('.agc-toggle');
    if (agcToggle) {
      agcToggle.addEventListener('change', () => {
        node.agcEnabled = agcToggle.checked;
        this.persister.persist();
      });
    }

    // --- Rating slider ---
    const ratingSlider = panel.querySelector('.rating-slider');
    const ratingVal = panel.querySelector('.rating-value');
    ratingSlider.addEventListener('input', () => {
      const v = parseFloat(ratingSlider.value);
      ratingVal.textContent = v + ' MVA';
      node.rating = v;
      if (baselineSlider) baselineSlider.max = v;
      if (fcrSlider) fcrSlider.max = v;
    });
    ratingSlider.addEventListener('change', () => this.persister.persist());

    // --- Inertia slider ---
    const inertiaSlider = panel.querySelector('.inertia-slider');
    const inertiaVal = panel.querySelector('.inertia-value');
    inertiaSlider.addEventListener('input', () => {
      const v = parseFloat(inertiaSlider.value);
      inertiaVal.textContent = v.toFixed(1) + 's';
      node.inertia = v;
    });
    inertiaSlider.addEventListener('change', () => this.persister.persist());

    // --- Droop slider ---
    const droopSlider = panel.querySelector('.droop-slider');
    const droopVal = panel.querySelector('.droop-value');
    droopSlider.addEventListener('input', () => {
      const d = parseFloat(droopSlider.value);
      droopVal.textContent = d + '%';
      node.droop = d / 100;
    });
    droopSlider.addEventListener('change', () => this.persister.persist());

    // --- Turbine TC (Ramp Up) slider ---
    const tcSlider = panel.querySelector('.tc-slider');
    const tcVal = panel.querySelector('.tc-value');
    tcSlider.addEventListener('input', () => {
      const v = parseFloat(tcSlider.value);
      tcVal.textContent = v.toFixed(1) + 's';
      node.turbineTimeConstant = v;
    });
    tcSlider.addEventListener('change', () => this.persister.persist());

    // --- Ramp Down TC slider ---
    const rdSlider = panel.querySelector('.rd-slider');
    const rdVal = panel.querySelector('.rd-value');
    rdSlider.addEventListener('input', () => {
      const v = parseFloat(rdSlider.value);
      rdVal.textContent = v.toFixed(2) + 's';
      node.rampDownTC = v;
    });
    rdSlider.addEventListener('change', () => this.persister.persist());

    // --- Mode select ---
    const modeSelect = panel.querySelector('.gen-mode-select');
    if (modeSelect) {
      modeSelect.addEventListener('change', () => {
        const oldMode = node.mode;
        node.mode = modeSelect.value;
        // Re-render mode-specific fields
        const modeFieldsContainer = panel.querySelector('.mode-fields');
        if (modeFieldsContainer) {
          modeFieldsContainer.innerHTML = genModeFieldsHTML(node, node.mode);
          // Re-bind listeners for new mode-specific widgets
          this._bindGenModeWidgets(panel, node, entry);
          // Reset output breakdown for new mode
          this._updateGenOutputBreakdown(panel, node, state);
        }
        this.persister.persist();
      });
    }

    // --- Shutdown button ---
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
    const mode = node.mode || 'balancing';

    panel.innerHTML = `
      <div class="settings-header"><span class="settings-title">Storage ${tag}</span><span class="settings-close" data-action="close-settings">&times;</span></div>
      <div class="settings-body">
        <div class="settings-row"><label class="settings-label">State of Charge</label><div class="settings-slider-group"><input type="range" class="soc-slider" min="0" max="${cap}" step="0.1" value="${socVal}"><span class="settings-value-display storage-soc">${socVal} MWh</span></div></div>
        <div class="storage-output-group" style="display:${mode === 'balancing' ? '' : 'none'}">
          <div class="settings-row">
            <label class="settings-label">Output</label>
            <div class="settings-slider-group" style="justify-content:flex-end;">
              <span class="stor-output" style="font-size:14px;font-weight:600;">${Math.round(node.mwResponse || 0)} MW</span>
            </div>
          </div>
          <div class="settings-row" style="margin-top:-4px">
            <div style="display:flex;gap:10px;font-size:11px;color:#999;padding-left:2px">
              <span>Base <span class="stor-output-base">${(node.baselineContract || 0) >= 0 ? '+' : ''}${Math.round(node.baselineContract || 0)}</span></span>
              <span>FCR <span class="stor-output-fcr">+${Math.round(-(1 / (node.droop || 0.04)) * ((state.frequency || 50) - 50) / 50 * Math.max(dchgR, chgR))}</span></span>
              <span>RR <span class="stor-output-rr">${(node.freqRestore || 0) >= 0 ? '+' : ''}${Math.round(node.freqRestore || 0)}</span></span>
              <span>AGC <span class="stor-output-agc">${(node.agcOffset || 0) >= 0 ? '+' : ''}${Math.round(node.agcOffset || 0)}</span></span>
            </div>
          </div>
        </div>
        <div class="settings-row"><label class="settings-label">Mode</label>
          <div class="settings-slider-group">
            <select class="storage-mode-select">
              <option value="balancing" ${mode === 'balancing' ? 'selected' : ''}>Balancing</option>
              <option value="grid-forming" ${mode === 'grid-forming' ? 'selected' : ''}>Grid Forming</option>
            </select>
          </div>
        </div>
        <div class="storage-baseline-group" style="display:${mode === 'grid-forming' ? '' : 'none'}">
          <div class="settings-row"><label class="settings-label">Baseline Contract</label><div class="settings-slider-group"><input type="range" class="baseline-contract-slider" min="${-chgR}" max="${dchgR}" step="1" value="${node.baselineContract || 0}"><span class="baseline-contract-value">${(node.baselineContract || 0) >= 0 ? '+' : ''}${node.baselineContract || 0} MW</span></div></div>
        </div>
        <div class="storage-afcr-group" style="display:${mode === 'balancing' ? '' : 'none'}">
          <div class="settings-row"><label class="settings-label">Frequency Containment Reserve</label><div class="settings-slider-group"><span style="font-size:12px;color:#999">enabled</span></div></div>
          <div class="settings-row"><label class="settings-label">FCR Headroom</label><div class="settings-slider-group"><input type="range" class="fcr-headroom-slider" min="1" max="${Math.max(chgR, dchgR)}" step="1" value="${fcr}"><span class="fcr-headroom-value">${fcr} MW</span></div></div>
          <div class="settings-row"><label class="settings-label">Droop</label><div class="settings-slider-group"><input type="range" class="droop-slider" min="0.5" max="20" step="0.5" value="${drop}"><span class="droop-value">${drop}%</span></div></div>
        </div>
        <div class="settings-row agc-row-storage" style="display:${mode === 'balancing' ? '' : 'none'}">
          <label class="settings-label">Automatic Frequency Restoration Reserve</label>
          <div class="settings-slider-group">
            <label style="display:flex;align-items:center;gap:6px;cursor:pointer;user-select:none;font-size:12px;color:#aaa">
              <input type="checkbox" class="agc-toggle-storage" ${node.agcEnabled !== false ? 'checked' : ''}>
              <span>enabled</span>
            </label>
          </div>
        </div>
        <div class="settings-row"><label class="settings-label">Discharge Rate</label><div class="settings-slider-group"><input type="range" class="discharge-slider" min="1" max="500" step="1" value="${dchgR}"><span class="discharge-value">${dchgR} MW</span></div></div>
        <div class="settings-row"><label class="settings-label">Charge Rate</label><div class="settings-slider-group"><input type="range" class="charge-slider" min="1" max="500" step="1" value="${chgR}"><span class="charge-value">${chgR} MW</span></div></div>
        <div class="settings-row"><label class="settings-label">Ramp Up TC</label><div class="settings-slider-group"><input type="range" class="ramp-up-slider" min="0.05" max="60" step="0.05" value="${node.rampUpTC||0.1}"><span class="ramp-up-value">${(node.rampUpTC||0.1).toFixed(2)}s</span></div></div>
        <div class="settings-row"><label class="settings-label">Ramp Down TC</label><div class="settings-slider-group"><input type="range" class="ramp-down-slider" min="0.05" max="60" step="0.05" value="${node.rampDownTC||0.1}"><span class="ramp-down-value">${(node.rampDownTC||0.1).toFixed(2)}s</span></div></div>
        <div class="settings-row"><label class="settings-label">Max Capacity</label><div class="settings-slider-group"><input type="range" class="capacity-slider" min="10" max="1000" step="10" value="${cap}"><span class="capacity-value">${cap} MWh</span></div></div>
        <div class="settings-row sep-top"><button class="storage-shutdown-btn" style="width:100%;padding:6px 0;border:1px solid #c0392b;border-radius:4px;cursor:pointer;font-size:13px;background:${node.tripped ? '#27ae60' : 'transparent'};color:${node.tripped ? '#fff' : '#c0392b'}">${node.tripped ? '🔄 Restart' : '🛑 Shut Down'}</button></div>
      </div>
            <div class="settings-resize-handle"></div>`;

    entry.socEl = panel.querySelector('.storage-soc');
    entry.mwRespEl = panel.querySelector('.storage-mw-response');
    entry.modeSelect = panel.querySelector('.storage-mode-select');
    entry.fcrGroup = panel.querySelector('.storage-fcr-group');
    entry.afcrGroup = panel.querySelector('.storage-afcr-group');
    entry.agcRow = panel.querySelector('.agc-row-storage');
    entry.outputGroup = panel.querySelector('.storage-output-group');
    entry.panel = panel;

    // SoC slider
    const socSlider = panel.querySelector('.soc-slider');
    socSlider.addEventListener('input', () => { const v = parseFloat(socSlider.value); node.mw = Math.min(v, node.maxCapacity || 100); entry.socEl.textContent = v.toFixed(2) + ' MWh'; });
    socSlider.addEventListener('change', () => this.persister.persist());

    // Mode select — shows baseline contract for grid-forming, FCR+AGC for balancing
    const baselineGroup = panel.querySelector('.storage-baseline-group');
    entry.modeSelect.addEventListener('change', () => {
      node.mode = entry.modeSelect.value;
      if (baselineGroup) baselineGroup.style.display = node.mode === 'grid-forming' ? '' : 'none';
      if (entry.afcrGroup) entry.afcrGroup.style.display = node.mode === 'balancing' ? '' : 'none';
      if (entry.agcRow) entry.agcRow.style.display = node.mode === 'balancing' ? '' : 'none';
      if (entry.outputGroup) entry.outputGroup.style.display = node.mode === 'balancing' ? '' : 'none';
      this.persister.persist();
    });

    // Baseline contract (dispatch) slider — grid-forming only
    const bcSlider = panel.querySelector('.baseline-contract-slider');
    const bcVal = panel.querySelector('.baseline-contract-value');
    if (bcSlider) {
      bcSlider.addEventListener('input', () => {
        const v = parseInt(bcSlider.value, 10);
        bcVal.textContent = (v >= 0 ? '+' : '') + v + ' MW';
        node.baselineContract = v;
      });
      bcSlider.addEventListener('change', () => this.persister.persist());
      entry.bcSlider = bcSlider;
      entry.bcVal = bcVal;
    }

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

    // AGC toggle (balancing storage only)
    const agcToggle = panel.querySelector('.agc-toggle-storage');
    if (agcToggle) {
      agcToggle.addEventListener('change', () => {
        node.agcEnabled = agcToggle.checked;
        this.persister.persist();
      });
    }

    // Ramp TC sliders
    const rampUpSlider = panel.querySelector('.ramp-up-slider'), rampUpVal = panel.querySelector('.ramp-up-value');
    const rampDownSlider = panel.querySelector('.ramp-down-slider'), rampDownVal = panel.querySelector('.ramp-down-value');
    if (rampUpSlider) {
      rampUpSlider.addEventListener('input', () => { const v = parseFloat(rampUpSlider.value); rampUpVal.textContent = v.toFixed(2) + 's'; node.rampUpTC = v; });
      rampUpSlider.addEventListener('change', () => this.persister.persist());
    }
    if (rampDownSlider) {
      rampDownSlider.addEventListener('input', () => { const v = parseFloat(rampDownSlider.value); rampDownVal.textContent = v.toFixed(2) + 's'; node.rampDownTC = v; });
      rampDownSlider.addEventListener('change', () => this.persister.persist());
    }

    // Charge/discharge dual-range sliders
    const chg = panel.querySelector('.charge-slider'), chgV = panel.querySelector('.charge-value');
    const dchg = panel.querySelector('.discharge-slider'), dchgV = panel.querySelector('.discharge-value');
    chg.addEventListener('input', () => { const v = parseInt(chg.value, 10); chgV.textContent = v + ' MW'; node.chargeRate = v; });
    chg.addEventListener('change', () => this.persister.persist());
    dchg.addEventListener('input', () => { const v = parseInt(dchg.value, 10); dchgV.textContent = v + ' MW'; node.dischargeRate = v; });
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
          <label class="settings-label">Growth per cycle</label>
          <div class="settings-slider-group"><input type="range" class="growth-slider" min="0" max="10" step="0.5" value="${node.demandGrowthPct || 0}"><span class="growth-value">${node.demandGrowthPct || 0}%</span></div>
        </div>
        <div class="settings-row noise-row"${node.noiseEnabled ? '' : ' style="display:none"'}>
          <canvas class="demand-preview" width="320" height="80" data-node-id="${node.id}"></canvas>
        </div>
        <div class="settings-row manual-row"${node.noiseEnabled ? ' style="display:none"' : ''}>
          <label class="settings-label">Demand (MW)</label>
          <div class="settings-slider-group"><input type="range" class="mw-slider" min="0" max="500" step="10" value="${node.mw || 10}"><span class="mw-value">${node.mw || 10}</span></div>
        </div>
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

    const growthSlider = panel.querySelector('.growth-slider');
    const growthVal = panel.querySelector('.growth-value');
    if (growthSlider) {
      growthSlider.addEventListener('input', () => {
        const v = parseFloat(growthSlider.value);
        growthVal.textContent = v + '%';
        node.demandGrowthPct = v;
        this.renderer.draw();
      });
      growthSlider.addEventListener('change', () => this.persister.persist());
    }

    // Draw the preview canvas on open
    const previewCanvas = panel.querySelector('.demand-preview');
    if (previewCanvas) this.renderer.drawLoadCurvePreview(previewCanvas, node);

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

  /** Re-bind event listeners for mode-specific widgets after a mode change re-render. */
  _bindGenModeWidgets(panel, node, entry) {
    // Committed MW slider
    const baselineSlider = panel.querySelector('.baseline-slider');
    const baselineVal = panel.querySelector('.baseline-value');
    if (baselineSlider) {
      entry.baselineSlider = baselineSlider;
      entry.baselineVal = baselineVal;
      baselineSlider.addEventListener('input', () => {
        const v = parseFloat(baselineSlider.value);
        baselineVal.textContent = Math.round(v) + ' MW';
        node.committedMW = v;
      });
      baselineSlider.addEventListener('change', () => this.persister.persist());
    }

    // Offer price input
    const offerInput = panel.querySelector('.offer-price-input');
    if (offerInput) {
      offerInput.addEventListener('wheel', (e) => {
        e.preventDefault();
        e.target.blur();
      });
      offerInput.addEventListener('input', () => {
        const v = parseFloat(offerInput.value);
        if (!isNaN(v)) node.bidPrice = v;
      });
      offerInput.addEventListener('change', () => this.persister.persist());
    }

    // FCR toggle
    const fcrToggle = panel.querySelector('.fcr-toggle');
    const fcrHeadroomRow = panel.querySelector('.fcr-headroom-row');
    if (fcrToggle) {
      fcrToggle.addEventListener('change', () => {
        node.fcrEnabled = fcrToggle.checked;
        if (fcrHeadroomRow) {
          fcrHeadroomRow.style.display = node.fcrEnabled ? '' : 'none';
        }
        this.persister.persist();
      });
    }

    // FCR Headroom slider
    const fcrSlider = panel.querySelector('.fcr-headroom-slider');
    const fcrVal = panel.querySelector('.fcr-headroom-value');
    if (fcrSlider) {
      fcrSlider.addEventListener('input', () => {
        const v = parseFloat(fcrSlider.value);
        fcrVal.textContent = Math.round(v) + ' MW';
        node.fcrHeadroom = v;
      });
      fcrSlider.addEventListener('change', () => this.persister.persist());
    }

    // AGC toggle
    const agcToggle = panel.querySelector('.agc-toggle');
    if (agcToggle) {
      agcToggle.addEventListener('change', () => {
        node.agcEnabled = agcToggle.checked;
        this.persister.persist();
      });
    }
  }

  /** Update the output breakdown (Base / FCR / AGC). */
  _updateGenOutputBreakdown(panel, node, state) {
    const baseEl = panel.querySelector('.output-base');
    const fcrEl = panel.querySelector('.output-fcr');
    const agcEl = panel.querySelector('.output-agc');
    if (!baseEl) return;
    // Try to use the gen's own network frequency
    const genNet = state.networks.find(n => n.nodeIds.has(node.id));
    const genFreq = genNet ? genNet.freq : state.frequency;
    const dev = (genFreq - 50) / 50;
    const govMod = -(1 / (node.droop || 0.04)) * dev * (node.rating || 100);
    const bc = node.baselineContract || 0;
    baseEl.textContent = Math.round(bc);
    fcrEl.textContent = (govMod >= 0 ? '+' : '') + Math.round(govMod);
    const agcOffset = node.agcOffset || 0;
    agcEl.textContent = (agcOffset >= 0 ? '+' : '') + Math.round(agcOffset);
  }

  refreshNodePanels() {
    const { openPanels } = this.store;
    for (const [nodeId, entry] of Object.entries(openPanels)) {
      const node = this.store.state.nodes.find(n => n.id === nodeId);
      if (!node || node.type !== 'load') continue;
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
      <div class="settings-row" style="border-bottom:1px solid #333;padding-bottom:4px;margin-bottom:4px">
        <label class="settings-label">Status</label>
        <div class="settings-slider-group">
          <span class="line-status" style="font-size:13px">${conn.tripped ? (conn.repairing ? '🔧 Repairing... ' + Math.ceil(conn.repairTimer || 0) + 's' : '⛔ Tripped') : '✅ Healthy'}</span>
        </div>
      </div>
      ${conn.tripped && !conn.repairing ? `
      <div class="settings-row">
        <button class="line-repair-btn" style="width:100%;padding:6px 0;border:1px solid #e6b432;border-radius:4px;cursor:pointer;font-size:13px;background:transparent;color:#e6b432">🔧 Repair Line</button>
      </div>
      ` : ''}
      ${conn.repairing ? `
      <div class="settings-row">
        <div class="settings-slider-group" style="flex-direction:column;gap:2px">
          <div style="display:flex;justify-content:space-between;font-size:11px;color:#aaa">
            <span>🔧 Repairing...</span>
            <span>${Math.ceil(conn.repairTimer || 0)}s</span>
          </div>
          <div style="height:6px;background:#333;border-radius:3px;overflow:hidden">
            <div class="repair-progress" style="height:100%;width:${((conn.repairDuration || 15) - (conn.repairTimer || 0)) / (conn.repairDuration || 15) * 100}%;background:#e6b432;border-radius:3px;transition:width 0.5s"></div>
          </div>
          <div class="settings-row" style="margin-top:2px"><label class="settings-label" style="font-size:11px">Fix Duration</label><div class="settings-slider-group"><input type="range" min="5" max="60" step="1" value="${conn.repairDuration || 15}" class="repair-duration-slider"><span class="repair-duration-value" style="font-size:11px;color:#ccc">${conn.repairDuration || 15}s</span></div></div>
        </div>
      </div>
      ` : ''}
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

  // Repair button — start fixing a tripped line
  const repairBtn = panel.querySelector('.line-repair-btn');
  if (repairBtn) {
    repairBtn.addEventListener('click', () => {
      conn.repairing = true;
      conn.repairTimer = conn.repairDuration || 15;
      this.persister.persist();
      // Close and reopen to show repair progress
      if (openPanels['_line_' + connId]) {
        openPanels['_line_' + connId].panel.remove();
        delete openPanels['_line_' + connId];
      }
      this.openLineSettings(connId);
    });
  }

  // Repair duration slider
  const repDurSlider = panel.querySelector('.repair-duration-slider');
  const repDurVal = panel.querySelector('.repair-duration-value');
  if (repDurSlider) {
    repDurSlider.addEventListener('input', () => {
      const v = parseInt(repDurSlider.value, 10);
      conn.repairDuration = v;
      if (repDurVal) repDurVal.textContent = v + 's';
    });
    repDurSlider.addEventListener('change', () => this.persister.persist());
  }

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
