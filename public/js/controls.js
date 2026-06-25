import { state, sim, canvas, dragPanel, dragOff } from './state.js';
import { startSim, stopSim, restartSim } from './simulation.js';
import { draw, drawFreqChart, drawMeritOrderChart, mouseToWorld, hitNode, hitIsland } from './renderer.js';
import { saveSnapshot } from './storage.js';
import { updateStatsPanel } from './stats.js';
import { openBalanceModal } from './balance.js';


export function updateControls() {
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

document.getElementById('play-btn').addEventListener('click', () => { startSim(); updateControls(); });
document.getElementById('pause-btn').addEventListener('click', () => { stopSim(); updateControls(); });
document.getElementById('restart-btn').addEventListener('click', restartSim);
document.getElementById('balance-btn').addEventListener('click', () => { if (sim.running) return; openBalanceModal(); });
document.getElementById('save-data-btn').addEventListener('click', saveSnapshot);

// ─── Speed Control ─────────────────────────────────────────────────────

const speedSlider = document.getElementById('speed-slider');
const speedValue = document.getElementById('speed-value');
function updateSpeedDisplay() { speedValue.textContent = sim.speed + '×'; }
speedSlider.addEventListener('input', () => {
  sim.speed = parseFloat(speedSlider.value);
  updateSpeedDisplay();
});




let selectedNetworkId = 'all';

canvas.addEventListener('click', (e) => {
  const world = mouseToWorld(e);
  const islandHit = hitIsland(world.x, world.y);
  if (islandHit && islandHit.isHeader) {
    selectedNetworkId = islandHit.net.id;
    state.selectedNetworkId = selectedNetworkId;
    if (state.statsPanelVisible) updateStatsPanel();
    draw();
  } else if (!hitNode(world.x, world.y) && !islandHit) {
    if (selectedNetworkId !== 'all') {
      selectedNetworkId = 'all';
      state.selectedNetworkId = 'all';
      if (state.statsPanelVisible) updateStatsPanel();
      draw();
    }
  }
});


document.getElementById('merit-btn').addEventListener('click', () => {
  state.meritChartVisible = !state.meritChartVisible;
  document.getElementById('merit-panel').classList.toggle('hidden');
  if (state.meritChartVisible) drawMeritOrderChart();
});

document.getElementById('merit-close-btn').addEventListener('click', () => {
  state.meritChartVisible = false;
  document.getElementById('merit-panel').classList.add('hidden');
});

document.getElementById('merit-panel').addEventListener('mousedown', (e) => {
  if (e.target.closest('.merit-header') && !e.target.closest('.merit-close')) {
    const panel = document.getElementById('merit-panel');
    dragPanel = panel;
    dragOff = { x: e.clientX - panel.offsetLeft, y: e.clientY - panel.offsetTop };
    panel.style.zIndex = Date.now();
    e.preventDefault();
  }
});

// ─── Frequency Chart Panel ─────────────────────────────────────────────

document.getElementById('freq-chart-close-btn').addEventListener('click', () => {
  state.freqChartVisible = false;
  document.getElementById('freq-chart-panel').classList.add('hidden');
});

document.getElementById('freq-chart-panel').addEventListener('mousedown', (e) => {
  if (e.target.closest('.freq-chart-header') && !e.target.closest('.freq-chart-close')) {
    const panel = document.getElementById('freq-chart-panel');
    dragPanel = panel;
    dragOff = { x: e.clientX - panel.offsetLeft, y: e.clientY - panel.offsetTop };
    panel.style.zIndex = Date.now();
    e.preventDefault();
  }
});

// ─── Balance Setup Modal ──────────────────────────────────────────────