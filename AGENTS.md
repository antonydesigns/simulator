# Power Grid Simulator

## Metadata
- lastReviewed: 2026-06-23
- sourceOfTruthScope: present-state codebase
- freshnessExpectation: high
- updateTriggerSummary: update when architecture, physics model, files, or workflow materially change

A browser-based 2D canvas power grid simulator. Server: Express on port 4000. Client: 1002 lines of vanilla JS in `public/app.js`. No build step, no frontend dependencies.

## Quick start
```bash
cd .simma/workspace/simulator
npm start           # → http://localhost:4000
npm run index       # manually rebuild codebase-index.json
```

## File layout

| File | Lines | Purpose |
|---|---|---|
| `server.js` | 68 | Express: load/save grid, save snapshots, static serve |
| `public/app.js` | 1002 | All simulation engine + canvas UI + interaction logic |
| `public/index.html` | 44 | Canvas + controls overlay + stats panel |
| `public/style.css` | 608 | Dark-theme styling for panels, controls, canvas |
| `scripts/index-codebase.js` | ~215 | Codebase index generator (auto-runs on commit) |
| `scripts/install-hooks.js` | ~40 | Installs post-commit git hook |
| `codebase-index.json` | — | Auto-generated symbol/import index (gitignored) |
| `data.json` | — | Grid persistence (gitignored) |
| `snapshots/` | — | Time-series data captures (gitignored) |

## Simulation model (10 Hz tick)

Five-step loop running at 10 Hz:

### Step 1 — Governor droop (FCR / primary control)
Instant frequency response per generator:
- **Balancing gens**: `mw = baseSetpoint - (1/droop) × ((f-f₀)/f₀) × rating`
- **Merchant-locked gens**: output fixed at `dispatchTarget`, no frequency response
- Both capped at `rating` (MVA)

### Step 2 — Storage response
Batteries charge from surplus (absorb excess MW) or discharge into deficit, rate-limited by `chargeRate` / `dischargeRate` and bounded by `maxCapacity` (state of charge in MWh).

### Step 3 — Swing equation (frequency)
`df/dt = (imbalance × f₀) / (2 × totalInertiaEnergy)` where `totalInertiaEnergy = Σ (Hᵢ × ratingᵢ)`. Frequency is clamped to [45, 55] Hz.

### Step 4 — Ramp
`_baseSetpoint` drifts toward `dispatchTarget` at `rampRate` MW/s. Merchant-locked gens skip this.

### Step 4a — AGC (aFRR / secondary control)
Slowly adjusts `dispatchTarget` of all balancing gens to restore 50 Hz. Rate-limited to `rampRate` per gen. Proportional distribution by rating share.

### Step 5–6
UI panel refresh + time-series capture every 0.25 s for snapshot export.

## Interaction model

| Action | Behaviour |
|---|---|
| Right-click canvas | Context menu: add generator, load, storage, junction |
| Double-click node | Sets as connection source (pending); click another node to connect |
| Click empty → drag | Marquee select |
| Drag node | Move it (if selected) |
| Space + drag | Pan view |
| Scroll | Zoom in/out |
| Double-click line | Split line with junction node |
| Del / Backspace | Delete selected nodes |
| Escape | Clear selection / pending connection / close all settings panels |

### Controls bar
- **▶ Play / ⏸ Pause / ⟳ Restart** — simulation lifecycle
- **💾 Save Data** — exports time-series to `snapshots/` as JSON
- **FCR / aFRR badges** — light up when primary/secondary control is active
- **📊 Stats panel** — expandable supply/demand breakdown with per-generator FCR split

### Settings panels per node type
- **Generator:** dispatch target (MW), ramp rate, rating (MVA), inertia H (s), droop (%), merchant lock toggle
- **Load:** demand slider (MW)
- **Storage:** charge/discharge rate, max capacity, state-of-charge readout

Panels are draggable, resizable, and independently scrollable.

## Physics constants
- Frequency: 50 Hz nominal, clamped 45–55 Hz
- Default droop: 4% (governor speed droop)
- Default inertia: 5 s per generator
- Default ramp rate: 5 MW/s
- Default rating: 100 MVA

## API

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/grid` | Load persisted grid (nodes + connections) |
| POST | `/api/grid` | Save grid state |
| POST | `/api/save-snapshot` | Save time-series snapshot to `snapshots/` |

## Codebase navigation

For codebase queries, read `codebase-index.json` first, then inspect specific files with `read_file_lines`. The index contains:
- `symbols` — flat map of function/arrow names → array of { file, line, kind, params }
- `edges.imports` — per-file what it imports (bare specifiers like "express" are listed)
- `edges.importedBy` — reverse import map

### Key call chains
- `init()` → `load()` → `resizeCanvas()` → `draw()` → `updateControls()` → `updateStatsPanel()`
- `startSim()` → `setInterval(simTick, 100ms)` → 5-step physics loop
- Canvas events → mouse handlers → `draw()`, `persist()`, or context menu
- All state mutable on `state` object (nodes, connections, view, frequency)

### State objects
- `state` — grid data, view transform, frequency, selection, pending connections
- `sim` — simulation lifecycle (running, interval, tickHz, dataBuffer)
- `ptr` — pointer state machine (downWorld, isDragging, isPanning, isSelecting, etc.)
- `openPanels` — open settings panels keyed by node ID

## Git hooks
- `post-commit` auto-rebuilds `codebase-index.json` after every commit
- `npm run index` to rebuild manually
- `npm run postinstall` runs both index and hook install after `npm install`

## Persistence
- `data.json` auto-saves on every change (node move, add, delete, connect, param change)
- `snapshots/` for time-series data captures (triggered manually)

## Related docs
- `codebase-index.json` — machine-readable symbol/import map (auto-generated)
- `scripts/index-codebase.js` — the index generator
- `scripts/install-hooks.js` — post-commit hook installer
