// ─── Store — shared state, DOM refs, constants ───────────────────────

export class Store {
  constructor() {
    // ─── State ──────────────────────────────────────────────────────
    this.state = {
      nodes: [],
      connections: [],
      selectedNodeIds: new Set(),
      selectedConnIds: new Set(),
      pendingSourceId: null,
      hoverLine: null,
      lineMode: "junction",
      view: { x: 0, y: 0, scale: 1 },
      spaceDown: false,
      frequency: 50,
      networks: [],
      smp: null,
      marketLoad: 0,
      clipboard: null,
      lineClipboard: null,
      statsBreakdownExpanded: new Set(),
    };

    // ─── Island Colors ──────────────────────────────────────────────
    this.ISLAND_COLORS = [
      "#4a90d9",
      "#d96c4a",
      "#4ad96c",
      "#d9c44a",
      "#9b4ad9",
      "#d94a8a",
      "#4ad9d9",
      "#d94a4a",
    ];

    // ─── Simulation ─────────────────────────────────────────────────
    this.sim = {
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

    // ─── Pointer state ──────────────────────────────────────────────
    this.ptr = {
      downWorld: null,
      downScreen: null,
      downTime: 0,
      downNodeId: null,
      dragOffset: { x: 0, y: 0 },
      isDragging: false,
      isPanning: false,
      isSelecting: false,
      rightButton: false,
      _panOffsetX: 0,
      _panOffsetY: 0,
      lastClickTime: 0,
      lastClickNodeId: null,
      mouseWorld: null,
      mouseScreen: null,
      moved: false,
    };

    this.DRAG_THRESHOLD = 4;

    // ─── DOM Refs ───────────────────────────────────────────────────
    this.canvas = document.getElementById("grid-canvas");
    this.ctx = this.canvas.getContext("2d");
    this.menu = document.getElementById("context-menu");
    this.menuItems = document.getElementById("context-menu-items");

    this.openPanels = {};

    // ─── Constants ──────────────────────────────────────────────────
    this.GRID_SIZE = 40;
    this.NODE_RADIUS = 14;
    this.JUNCTION_RADIUS = 4;

    // ─── UID ────────────────────────────────────────────────────
    this._idCounter = Date.now();

    // ─── Mutable interaction globals ────────────────────────────
    this.hoveredIslandId = null;
    this.hoveredIslandHeader = false;
    this.islandDrag = null;
    this.statsPanelVisible = false;
    this.selectedNetworkId = "all";
    this.freqChartVisible = false;
    this.freqViewLeft = 0;    // 0 = auto (window follows latest)
    this.freqViewRight = 0;   // 0 = auto, >0 = number of data points to show
    this.freqYMin = 0;        // 0 = auto-scale to visible data
    this.meritChartVisible = false;
    this.dragPanel = null;
    this.dragOff = { x: 0, y: 0 };
    this.resizePanel = null;
    this.resizeStart = { x: 0, y: 0, w: 0, h: 0 };
  }

  uid() {
    return "n" + (this._idCounter++).toString(36);
  }

  shortId(type) {
    const prefix =
      { generator: "G", load: "L", storage: "S", junction: "J" }[type] || "N";
    const digits = Math.floor(Math.random() * 900) + 100;
    const letter = String.fromCharCode(65 + Math.floor(Math.random() * 26));
    return prefix + "-" + digits + letter;
  }
}
