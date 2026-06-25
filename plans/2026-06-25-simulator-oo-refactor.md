# Plan: Object-Oriented Refactoring of Power Grid Simulator

## Principle

**Pure mechanical copy-paste with extra steps (imports/exports).**  
Zero logic changes. Zero visual changes. Zero new behavior.  
Every function body stays exactly as it is in the original 3,826-line `app.js`.

Python bulk extraction caused import stripping last time — **Node.js file tools only**.

## Starting Point

- **Branch:** `dev/1` on simulator git repo (stable commit from 2026-06-24)
- **File:** `public/app.js` — 3,826-line monolith, plain `<script>` tag
- **Index:** `public/index.html` — loads `app.js` via `<script src="app.js">`
- **Stray files:** `public/js/controls.js` — deleted (leftover from broken refactoring)

## End State

```
public/
  js/
    state.js         → class GridState        — state object, DOM refs, constants
    simulation.js    → class SimulationEngine  — simTick, balance, market, networks
    storage.js       → class StorageManager    — persist, load, saveSnapshot, IDs
    renderer.js      → class Renderer          — all draw* functions, coords, cursor
    settings.js      → class SettingsPanel     — gen/load/storage/line settings
    stats.js         → class StatsPanel        — system stats panel
    balance.js       → class BalanceModal      — balance supply/demand modal
    controls.js      → class Controls          — play/pause/restart/speed buttons
    interactions.js  → class Interactions      — mouse/keyboard/wheel, context menu
  app.js             → instantiate all classes, wire them up, call init()
  index.html         → <script type="module" src="app.js">
```

Each class gets **state as constructor dependency** (dependency injection pattern):

```js
export class SimulationEngine {
  constructor(state) {
    this.state = state;
  }
  tick(dt) { /* exact copy from original app.js */ }
}
```

## Build Steps (iterative — one "build" at a time, verify after each)

### Step 1: `js/state.js` — GridState class
- Move: `state` object, `hoveredIslandId/HoveredIslandHeader/islandDrag` vars, `ISLAND_COLORS`, `sim`, `canvas`, `ctx`, `ptr`, `DRAG_THRESHOLD`, `GRID_SIZE`, `NODE_RADIUS`, `JUNCTION_RADIUS`
- Move: `menu`, `menuItems`, `openPanels`, `dragPanel`, `dragOff`, `resizePanel`, `resizeStart`
- All DOM refs (`document.getElementById(...)`) stay here
- Export `GridState` class with constructor setting all fields
- `app.js` → remove moved code, import `GridState`, instantiate `const state = new GridState()`
- Verify: page loads, no console errors

### Step 2: `js/simulation.js` — SimulationEngine class
- Move: all simulation functions (`recomputeNetworks`, `demandCurve`, `dispatchMeritOrder`, `simTick`, `startSim`, `stopSim`, `restartSim`, `balanceGrid`, `solveDCPowerFlow`, `findNetworks`, `computeBoundingBox`)
- Constructor takes `state` and `sim` objects
- `app.js` → remove moved functions, import `SimulationEngine`, instantiate
- Verify: simulation runs, no console errors

### Step 3: `js/storage.js` — StorageManager class
- Move: `persist`, `load`, `saveSnapshot`, `uid`, `shortId`
- Constructor takes `state`, `sim`, `recomputeNetworks` callback
- `app.js` → remove, import, instantiate
- Verify: save/load works, no console errors

### Step 4: `js/renderer.js` — Renderer class
- Move: all `draw*` functions, coordinate transforms (`screenToWorld`, `worldToScreen`, `mouseToWorld`, `mouseToScreen`), `updateCursor`, `findNearestLine`, `hitNode`, `hitIsland`, `pointToSegmentDist`, `roundRectCtx`, `computeMarqueeSelection`
- Constructor takes `state`, `sim`, `canvas`, `ctx`
- `app.js` → remove, import, instantiate
- Verify: canvas renders correctly, no console errors

### Step 5: `js/panels.js` — small wrapper that re-exports sub-panels
- Or start splitting directly into sub-panels

### Step 5a: `js/settings.js` — SettingsPanel class
- Move: `openSettings`, `closeSettings`, `openLineSettings`, `closeLineSettings`, `closeAllSettings`, `openSettingsByType`
- Constructor takes `state`, `sim`, `canvas`, `ctx`, draw callback
- `app.js` → remove, import, instantiate

### Step 5b: `js/stats.js` — StatsPanel class
- Move: `updateStatsPanel`, `toggleStatsBreakdown`, `statsPanelVisible`
- Constructor takes `state`, `sim`
- `app.js` → remove, import, instantiate

### Step 5c: `js/balance.js` — BalanceModal class
- Move: `openBalanceModal`, `balanceModalVisible`, related helpers
- Constructor takes `state`
- `app.js` → remove, import, instantiate

### Step 5d: `js/controls.js` — Controls class
- Move: `updateControls`, speed slider logic, play/pause/restart button bindings, FCR/AGC badge updates, merit button toggle, save button, stats button
- Constructor takes `state`, `sim`, `canvas`, `ctx`, simulation engine reference
- `app.js` → remove, import, instantiate

### Step 6: `js/interactions.js` — Interactions class
- Move: all event listeners (`mousedown`, `mousemove`, `mouseup`, `wheel`, `mouseleave`, `keydown`, `keyup`, `contextmenu`, `click` on menu, `click` on document)
- Move: `showMenu`, `hideMenu`, `addMenuItem`, `addMenuSeparator`
- Move: `onDoubleClickNode`, `addNode`, `deleteNode`, `addConnection`, `splitConnection`, `resizeCanvas`
- Constructor takes `state`, `sim`, `canvas`, `ctx`, all other class instances
- `app.js` → remove, import, instantiate, wire up listeners via method call

### Step 7: `app.js` — wire everything together
- Just imports, instantiation, and `init()` call
- `init()` → load, balanceGrid, resizeCanvas, draw, updateControls, updateStatsPanel

### Step 8: `index.html` — update to ES module
- Change `<script src="app.js">` to `<script type="module" src="app.js">`
- Remove any stale script tags from the broken refactoring

### Step 9: Full verification
- Smoke test: no console errors, canvas renders, simulation runs, save/load works
- Visual check: generators look like generators (rotor/fan), loads look like loads (triangle), storage looks like storage (battery). All shapes must match the original exactly.

## Verification After Every Step

1. Kill old server
2. Start fresh: `node server.js`
3. Open browser to `http://localhost:4000`
4. Check console for errors
5. Check canvas renders correctly
6. If error → fix before proceeding to next step

## What NOT to do

- ❌ No shape/color/visual changes of any kind
- ❌ No logic rewrites (even if the original code is ugly)
- ❌ No new features
- ❌ No Python scripts for bulk extraction
- ❌ No modifying index.html until Step 8
