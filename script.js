// ─── State ───────────────────────────────────────────────────
const state = {
  loadMW: 10,
  genMW: 10,
  maxGen: 50,
  maxLoad: 50,
};

// ─── DOM refs ────────────────────────────────────────────────
const loadGroup = document.getElementById('loadGroup');
const loadValue = document.getElementById('loadValue');
const genValue = document.getElementById('genValue');
const loadPanel = document.getElementById('loadPanel');
const closePanel = document.getElementById('closePanel');
const loadSlider = document.getElementById('loadSlider');
const loadSliderValue = document.getElementById('loadSliderValue');
const panelGenValue = document.getElementById('panelGenValue');
const panelLoadValue = document.getElementById('panelLoadValue');
const panelStatus = document.getElementById('panelStatus');
const transmissionLine = document.getElementById('transmissionLine');

// ─── Update UI ──────────────────────────────────────────────
function updateUI() {
  // Sync generation to match load (simple balance)
  state.genMW = state.loadMW;

  // Bus labels
  genValue.textContent = `${state.genMW.toFixed(1)} MW`;
  loadValue.textContent = `${state.loadMW.toFixed(1)} MW`;

  // Panel values
  panelGenValue.textContent = `${state.genMW.toFixed(1)} MW`;
  panelLoadValue.textContent = `${state.loadMW.toFixed(1)} MW`;

  // Status
  const ratio = state.loadMW / state.maxGen;
  if (ratio <= 0.5) {
    panelStatus.textContent = '✅ Balanced';
    panelStatus.className = 'status-ok';
    transmissionLine.setAttribute('stroke', '#2d6a4f');
    transmissionLine.setAttribute('stroke-width', '4');
  } else if (ratio <= 0.8) {
    panelStatus.textContent = '⚠️ Moderate';
    panelStatus.className = 'status-warn';
    transmissionLine.setAttribute('stroke', '#e09f3e');
    transmissionLine.setAttribute('stroke-width', '5');
  } else {
    panelStatus.textContent = '🔴 Overloaded';
    panelStatus.className = 'status-overload';
    transmissionLine.setAttribute('stroke', '#d62828');
    transmissionLine.setAttribute('stroke-width', '6');
  }
}

// ─── Slider ──────────────────────────────────────────────────
loadSlider.addEventListener('input', () => {
  state.loadMW = parseFloat(loadSlider.value);
  loadSliderValue.textContent = `${state.loadMW.toFixed(1)} MW`;
  updateUI();
});

// ─── Panel toggle ────────────────────────────────────────────
function openPanel() {
  loadPanel.classList.remove('hidden');
  loadSlider.value = state.loadMW;
  loadSliderValue.textContent = `${state.loadMW.toFixed(1)} MW`;
}

function closePanelFn() {
  loadPanel.classList.add('hidden');
}

loadGroup.addEventListener('click', openPanel);
closePanel.addEventListener('click', closePanelFn);

// Close panel on Escape key
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !loadPanel.classList.contains('hidden')) {
    closePanelFn();
  }
});

// ─── Init ────────────────────────────────────────────────────
updateUI();
