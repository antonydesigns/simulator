// ─── State ────────────────────────────────────────────────────────────

export const state = {
  nodes: [],
  connections: [],
  selectedNodeIds: new Set(),
  selectedConnIds: new Set(),
  pendingSourceId: null,
  hoverLine: null,
  lineMode: 'junction',
  view: { x: 0, y: 0, scale: 1 },
  spaceDown: false,
  frequency: 50,
  networks: [],
  smp: null,
  marketLoad: 0,
  clipboard: null, // { nodes: [...copied nodes...], connections: [...] }
  lineClipboard: null, // { reactance, thermalLimit } from a copied line
  statsBreakdownExpanded: new Set(), // nodeIds whose breakdown rows are expanded in stats panel
  // UI state — shared across modules and accessible via window.state for inline handlers
  selectedNetworkId: 'all',
  freqChartVisible: false,
  meritChartVisible: false,
  statsPanelVisible: false,

  hoveredIslandId: null,
  hoveredIslandHeader: false,
  islandDrag: null, // { netId, startMouseX, startMouseY, origPositions: [{id, x, y}] }
};

// ─── Island Colors ─────────────────────────────────────────────────────

export const ISLAND_COLORS = [
  '#4a90d9', // blue
  '#d96c4a', // rust
  '#4ad96c', // green
  '#d9c44a', // gold
  '#9b4ad9', // purple
  '#d94a8a', // pink
  '#4ad9d9', // teal
  '#d94a4a', // red
];

// ─── Simulation ───────────────────────────────────────────────────────

export const sim = {
  running: false,
  interval: null,
  tickHz: 10,
  dataBuffer: [],
  captureAccum: 0,
  events: [],
  simTime: 0,
  speed: 1,
  lastMarketPat: 0,
};

// ─── Pointer state ────────────────────────────────────────────────────

export const ptr = {
  downWorld: null, downScreen: null, downTime: 0, downNodeId: null,
  dragOffset: { x: 0, y: 0 }, isDragging: false, isPanning: false, isSelecting: false, rightButton: false,
  _panOffsetX: 0, _panOffsetY: 0, lastClickTime: 0, lastClickNodeId: null,
  mouseWorld: null, mouseScreen: null, moved: false,
};

export const DRAG_THRESHOLD = 4;

// ─── DOM Refs ──────────────────────────────────────────────────────────

export const canvas = document.getElementById('grid-canvas');
export const ctx = canvas.getContext('2d');
export const menu = document.getElementById('context-menu');
export const menuItems = document.getElementById('context-menu-items');

export const openPanels = {};

export let dragPanel = null, dragOff = { x: 0, y: 0 };
export let resizePanel = null, resizeStart = { x: 0, y: 0, w: 0, h: 0 };

export const GRID_SIZE = 40, NODE_RADIUS = 14, JUNCTION_RADIUS = 4;

// ─── UI State ──────────────────────────────────────────────────────────

// ─── For inline event handlers in generated HTML — expose state globally
window.state = state;
