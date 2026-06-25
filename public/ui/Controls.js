// ─── Controls — play/pause/restart/speed, panel drag/close ──────────

export class Controls {
  constructor(store, engine, persister, statsPanel, balanceModal) {
    this.store = store;
    this.engine = engine;
    this.persister = persister;
    this.statsPanel = statsPanel;
    this.balanceModal = balanceModal;
    this.speedSlider = document.getElementById('speed-slider');
    this.speedValue = document.getElementById('speed-value');
    this._bindEvents();
    this._setupPanelDrag();
  }

  updateControls() {
    const balanceBtn = document.getElementById("balance-btn");
    if (balanceBtn) {
      balanceBtn.disabled = this.store.sim.running;
    }
    const { sim } = this.store;
    const playBtn = document.getElementById('play-btn');
    const pauseBtn = document.getElementById('pause-btn');
    const saveBtn = document.getElementById('save-data-btn');
    if (sim.running) {
      playBtn.disabled = true;
      pauseBtn.disabled = false;
      saveBtn.disabled = true;
    } else {
      playBtn.disabled = false;
      pauseBtn.disabled = true;
      saveBtn.disabled = false;
    }
  }

  updateSpeedDisplay() {
    const { sim } = this.store;
    this.speedValue.textContent = sim.speed + '×';
  }

  _bindEvents() {
    const { store, engine, persister, statsPanel } = this;

    // Play
    document.getElementById('play-btn').addEventListener('click', () => {
      engine.startSim();
      this.updateControls();
    });

    // Pause
    document.getElementById('pause-btn').addEventListener('click', () => {
      engine.stopSim();
      this.updateControls();
      if (balanceBtn) balanceBtn.disabled = false;
    });

    // Restart
    document.getElementById('restart-btn').addEventListener('click', () => {
      engine.restartSim();
    });

    // Balance
    document.getElementById('balance-btn').addEventListener('click', () => {
      this.balanceModal.open();
    });

    // Save snapshot
    document.getElementById('save-data-btn').addEventListener('click', () => {
      persister.saveSnapshot();
    });

    // Speed slider
    this.speedSlider.addEventListener('input', () => {
      store.sim.speed = parseFloat(this.speedSlider.value);
      this.updateSpeedDisplay();
    });

    // Merit order toggle
    document.getElementById('merit-btn').addEventListener('click', () => {
      store.meritChartVisible = !store.meritChartVisible;
      document.getElementById('merit-panel').classList.toggle('hidden', !store.meritChartVisible);
      if (store.meritChartVisible) statsPanel.drawMeritOrderChart();
    });

    // Stats panel toggle
    document.getElementById('stats-btn').addEventListener('click', () => {
      store.statsPanelVisible = !store.statsPanelVisible;
      document.getElementById('stats-panel').classList.toggle('hidden', !store.statsPanelVisible);
      if (store.statsPanelVisible) statsPanel.update();
    });

    // ─── Close buttons for panels ─────────────────────────

    document.getElementById('stats-close-btn').addEventListener('click', () => {
      store.statsPanelVisible = false;
      document.getElementById('stats-panel').classList.add('hidden');
    });

    document.getElementById('merit-close-btn').addEventListener('click', () => {
      store.meritChartVisible = false;
      document.getElementById('merit-panel').classList.add('hidden');
    });

    document.getElementById('freq-chart-close-btn').addEventListener('click', () => {
      store.freqChartVisible = false;
      document.getElementById('freq-chart-panel').classList.add('hidden');
    });

    // ─── Panel drag initiators ────────────────────────────

    document.getElementById('stats-panel').querySelector('.stats-header').addEventListener('mousedown', (e) => {
      if (e.target.closest('.stats-close')) return;
      store.dragPanel = document.getElementById('stats-panel');
      store.dragOff = { x: e.clientX - store.dragPanel.offsetLeft, y: e.clientY - store.dragPanel.offsetTop };
      store.dragPanel.style.zIndex = Date.now();
      e.preventDefault();
    });

    document.getElementById('merit-panel').querySelector('.merit-header').addEventListener('mousedown', (e) => {
      if (e.target.closest('.merit-close')) return;
      store.dragPanel = document.getElementById('merit-panel');
      store.dragOff = { x: e.clientX - store.dragPanel.offsetLeft, y: e.clientY - store.dragPanel.offsetTop };
      store.dragPanel.style.zIndex = Date.now();
      e.preventDefault();
    });

    document.getElementById('freq-chart-panel').querySelector('.freq-chart-header').addEventListener('mousedown', (e) => {
      if (e.target.closest('.freq-chart-close')) return;
      store.dragPanel = document.getElementById('freq-chart-panel');
      store.dragOff = { x: e.clientX - store.dragPanel.offsetLeft, y: e.clientY - store.dragPanel.offsetTop };
      store.dragPanel.style.zIndex = Date.now();
      e.preventDefault();
    });
  }

  _setupPanelDrag() {
    const store = this.store;

    document.addEventListener('mousemove', (e) => {
      if (!store.dragPanel) return;
      store.dragPanel.style.left = (e.clientX - store.dragOff.x) + 'px';
      store.dragPanel.style.top = (e.clientY - store.dragOff.y) + 'px';
    });

    document.addEventListener('mouseup', () => {
      store.dragPanel = null;
    });
  }
}
