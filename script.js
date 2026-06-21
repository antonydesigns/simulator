// ─── State ───────────────────────────────────────────────────
const state = {
  loadMW: 10,
  genMW: 10,
  maxGen: 50,
  maxLoad: 50,
};

// ─── Viewport state (pan & zoom) ────────────────────────────
const VW = 800; // base viewBox width
const VH = 500; // base viewBox height
let viewX = 0, viewY = 0;
let scale = 1;

// ─── Bus positions (in SVG coordinates) ──────────────────────
const buses = {
  gen: { cx: 150, cy: 250 },
  load: { cx: 650, cy: 250 },
};

// ─── DOM refs ────────────────────────────────────────────────
const svg = document.querySelector('.svg-overlay');
const gridContainer = document.querySelector('.grid-container');
const genGroup = document.getElementById('generatorGroup');
const genCircle = genGroup.querySelector('.bus-circle');
const genLabel = genGroup.querySelector('.bus-label');
const genValText = genGroup.querySelector('.bus-value');
const loadGroup = document.getElementById('loadGroup');
const loadCircle = loadGroup.querySelector('.bus-circle');
const loadLabel = loadGroup.querySelector('.bus-label');
const loadSub = loadGroup.querySelector('.bus-sub-label');
const loadValText = loadGroup.querySelector('.bus-value');
const loadValue = document.getElementById('loadValue');
const genValue = document.getElementById('genValue');
const loadPanel = document.getElementById('loadPanel');
const modalHeader = document.getElementById('modalHeader');
const closePanel = document.getElementById('closePanel');
const loadSlider = document.getElementById('loadSlider');
const loadSliderValue = document.getElementById('loadSliderValue');
const panelGenValue = document.getElementById('panelGenValue');
const panelLoadValue = document.getElementById('panelLoadValue');
const panelStatus = document.getElementById('panelStatus');
const transmissionLine = document.getElementById('transmissionLine');
const zoomInBtn = document.getElementById('zoomIn');
const zoomOutBtn = document.getElementById('zoomOut');
const zoomResetBtn = document.getElementById('zoomReset');
const zoomLevel = document.getElementById('zoomLevel');

// ─── ViewBox helper ─────────────────────────────────────────
function updateViewBox() {
  const w = VW / scale;
  const h = VH / scale;
  svg.setAttribute('viewBox', `${viewX} ${viewY} ${w} ${h}`);
  if (zoomLevel) zoomLevel.textContent = `${Math.round(scale * 100)}%`;
}

// ─── Update bus positions & arrows in SVG ───────────────────
function updateBusPositions() {
  genCircle.setAttribute('cx', buses.gen.cx);
  genCircle.setAttribute('cy', buses.gen.cy);
  genLabel.setAttribute('x', buses.gen.cx);
  genLabel.setAttribute('y', buses.gen.cy - 10);
  genValText.setAttribute('x', buses.gen.cx);
  genValText.setAttribute('y', buses.gen.cy + 20);

  loadCircle.setAttribute('cx', buses.load.cx);
  loadCircle.setAttribute('cy', buses.load.cy);
  loadLabel.setAttribute('x', buses.load.cx);
  loadLabel.setAttribute('y', buses.load.cy - 15);
  loadSub.setAttribute('x', buses.load.cx);
  loadSub.setAttribute('y', buses.load.cy + 5);
  loadValText.setAttribute('x', buses.load.cx);
  loadValText.setAttribute('y', buses.load.cy + 25);

  // Update transmission line
  transmissionLine.setAttribute('x1', buses.gen.cx);
  transmissionLine.setAttribute('y1', buses.gen.cy);
  transmissionLine.setAttribute('x2', buses.load.cx);
  transmissionLine.setAttribute('y2', buses.load.cy);

  // Update flow arrows — always point toward load
  const dx = buses.load.cx - buses.gen.cx;
  const dy = buses.load.cy - buses.gen.cy;
  const angle = Math.atan2(dy, dx) * (180 / Math.PI);
  const len = Math.sqrt(dx * dx + dy * dy);
  const size = 12;

  for (const [id, t] of [['arrow1', 0.35], ['arrow2', 0.65]]) {
    const cx = buses.gen.cx + dx * t;
    const cy = buses.gen.cy + dy * t;
    const arrow = document.getElementById(id);
    const p1x = cx - size, p1y = cy - size / 2;
    const p2x = cx - size, p2y = cy + size / 2;
    const p3x = cx, p3y = cy;
    // Use a transform to rotate around the tip (p3)
    arrow.setAttribute('points', `${p1x},${p1y} ${p2x},${p2y} ${p3x},${p3y}`);
    arrow.setAttribute('transform', `rotate(${angle} ${cx} ${cy})`);
  }
}

// ─── Convert screen to SVG coordinates ──────────────────────
function screenToSVG(sx, sy) {
  const rect = svg.getBoundingClientRect();
  const vw = VW / scale;
  const vh = VH / scale;
  const x = viewX + ((sx - rect.left) / rect.width) * vw;
  const y = viewY + ((sy - rect.top) / rect.height) * vh;
  return { x, y };
}

// ─── Update UI (power values) ───────────────────────────────
function updateUI() {
  state.genMW = state.loadMW;
  genValue.textContent = `${state.genMW.toFixed(1)} MW`;
  loadValue.textContent = `${state.loadMW.toFixed(1)} MW`;
  panelGenValue.textContent = `${state.genMW.toFixed(1)} MW`;
  panelLoadValue.textContent = `${state.loadMW.toFixed(1)} MW`;

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
closePanel.addEventListener('click', closePanelFn);

// ─── Draggable modal ─────────────────────────────────────────
let modalDrag = false;
let modalOffX = 0, modalOffY = 0;
modalHeader.addEventListener('mousedown', (e) => {
  modalDrag = true;
  const r = loadPanel.getBoundingClientRect();
  modalOffX = e.clientX - r.left;
  modalOffY = e.clientY - r.top;
  loadPanel.style.cursor = 'grabbing';
});
document.addEventListener('mousemove', (e) => {
  if (modalDrag) {
    loadPanel.style.left = `${e.clientX - modalOffX}px`;
    loadPanel.style.top = `${e.clientY - modalOffY}px`;
    loadPanel.style.right = 'auto';
  }
});
document.addEventListener('mouseup', () => {
  if (modalDrag) { modalDrag = false; loadPanel.style.cursor = ''; }
});

// ─── Bus dragging + Canvas panning ───────────────────────────
let dragTarget = null;       // 'gen' | 'load' | 'canvas'
let dragStartMouse = null;   // { sx, sy }
let dragStartPos = null;     // { cx, cy } for buses, { vx, vy } for canvas
let didMove = false;
const DRAG_THRESHOLD = 5;    // px to distinguish click from drag

function onPointerDown(e) {
  // Check if clicking a bus
  let target = e.target.closest('.generator-bus, .load-bus');
  if (target) {
    dragTarget = target.classList.contains('generator-bus') ? 'gen' : 'load';
  } else {
    dragTarget = 'canvas';
  }
  dragStartMouse = { sx: e.clientX, sy: e.clientY };
  if (dragTarget === 'canvas') {
    dragStartPos = { vx: viewX, vy: viewY };
  } else {
    // Record offset between click point (SVG coords) and bus center
    const svgPos = screenToSVG(e.clientX, e.clientY);
    dragStartPos = {
      ox: svgPos.x - buses[dragTarget].cx,
      oy: svgPos.y - buses[dragTarget].cy,
    };
  }
  didMove = false;
  if (dragTarget !== 'canvas') {
    e.stopPropagation();
  }
}

function onPointerMove(e) {
  if (!dragStartMouse) return;
  const dx = e.clientX - dragStartMouse.sx;
  const dy = e.clientY - dragStartMouse.sy;
  if (Math.abs(dx) > DRAG_THRESHOLD || Math.abs(dy) > DRAG_THRESHOLD) {
    didMove = true;
  }
  if (!didMove) return;

  if (dragTarget === 'canvas') {
    // Pan: convert screen delta to SVG delta
    const rect = svg.getBoundingClientRect();
    const vw = VW / scale;
    const factor = vw / rect.width;
    viewX = dragStartPos.vx - dx * factor;
    viewY = dragStartPos.vy - dy * factor;
    updateViewBox();
  } else {
    // Drag bus — direct 1:1 mapping, subtract grab offset
    const svgPos = screenToSVG(e.clientX, e.clientY);
    buses[dragTarget].cx = svgPos.x - dragStartPos.ox;
    buses[dragTarget].cy = svgPos.y - dragStartPos.oy;
    updateBusPositions();
  }
}

function onPointerUp(e) {
  if (!dragStartMouse) return;
  // If it was a click (no drag) on the load bus, open panel
  if (!didMove && dragTarget === 'load') {
    openPanel();
  }
  dragTarget = null;
  dragStartMouse = null;
  dragStartPos = null;
}

// Attach pointer events on SVG
svg.addEventListener('pointerdown', onPointerDown);
svg.addEventListener('pointermove', onPointerMove);
svg.addEventListener('pointerup', onPointerUp);
svg.addEventListener('pointerleave', onPointerUp);

// Prevent context menu on long-press
svg.addEventListener('contextmenu', (e) => e.preventDefault());

// ─── Zoom (mouse wheel) ──────────────────────────────────────
gridContainer.addEventListener('wheel', (e) => {
  e.preventDefault();
  const rect = svg.getBoundingClientRect();
  const mx = e.clientX - rect.left;
  const my = e.clientY - rect.top;

  // Get SVG coords before zoom
  const pre = screenToSVG(e.clientX, e.clientY);

  const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
  const newScale = Math.min(Math.max(scale * factor, 0.2), 5);

  // Adjust viewX/viewY so the point under cursor stays fixed
  const vw = VW / scale;
  const vh = VH / scale;
  const newVw = VW / newScale;
  const newVh = VH / newScale;

  const fx = mx / rect.width;
  const fy = my / rect.height;

  viewX = pre.x - fx * newVw;
  viewY = pre.y - fy * newVh;
  scale = newScale;

  updateViewBox();
  updateZoomDisplay();
}, { passive: false });

// ─── Zoom controls ───────────────────────────────────────────
function updateZoomDisplay() {
  if (zoomLevel) zoomLevel.textContent = `${Math.round(scale * 100)}%`;
}

zoomInBtn.addEventListener('click', () => {
  const newScale = Math.min(scale * 1.3, 5);
  const vw = VW / scale;
  const vh = VH / scale;
  const newVw = VW / newScale;
  const newVh = VH / newScale;
  viewX += (vw - newVw) / 2;
  viewY += (vh - newVh) / 2;
  scale = newScale;
  updateViewBox();
});

zoomOutBtn.addEventListener('click', () => {
  const newScale = Math.max(scale / 1.3, 0.2);
  const vw = VW / scale;
  const vh = VH / scale;
  const newVw = VW / newScale;
  const newVh = VH / newScale;
  viewX -= (newVw - vw) / 2;
  viewY -= (newVh - vh) / 2;
  scale = newScale;
  updateViewBox();
});

zoomResetBtn.addEventListener('click', () => {
  viewX = 0; viewY = 0; scale = 1;
  updateViewBox();
});

// ─── Init ────────────────────────────────────────────────────
updateViewBox();
updateBusPositions();
updateUI();
