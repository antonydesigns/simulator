// ─── Controls — play/pause/restart/speed ──────────────────────────

export class Controls {
  constructor(store) {
    this.store = store;
    this.speedSlider = document.getElementById('speed-slider');
    this.speedValue = document.getElementById('speed-value');
  }

  updateControls() {
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
}
