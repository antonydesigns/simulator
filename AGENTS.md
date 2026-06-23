# Power Grid Simulator

## Metadata
- lastReviewed: 2026-06-23
- sourceOfTruthScope: present-state codebase
- freshnessExpectation: high
- updateTriggerSummary: update when architecture, physics model, files, or workflow materially change

A browser-based 2D canvas power grid simulator with realistic physics (swing equation, DC power flow, droop governor, AGC, protection relays). Server: Express on port 4000. Client: ~2565 lines of vanilla JS in `public/app.js`. No build step, no frontend dependencies.

## Quick start
```bash
cd .simma/workspace/simulator
npm start           # → http://localhost:4000
npm run index       # manually rebuild codebase-index.json
```

## File layout

| File | Lines | Purpose |
|---|---|---|
| `server.js` | ~80 | Express: load/save grid, save snapshots, static serve |
| `public/app.js` | ~2565 | All simulation engine + canvas UI + interaction logic |
| `public/index.html` | ~50 | Canvas + controls overlay + stats panel |
| `public/style.css` | ~610 | Dark-theme styling for panels, controls, canvas |
| `scripts/index-codebase.js` | ~215 | Codebase index generator (auto-runs on commit) |
| `scripts/install-hooks.js` | ~40 | Installs post-commit git hook |
| `codebase-index.json` | — | Auto-generated symbol/import index (gitignored) |
| `data.json` | — | Grid persistence (gitignored) |
| `snapshots/` | — | Time-series data captures (gitignored) |

## Simulation model (10 Hz tick)

Ten-step physics loop running at 10 Hz, executed per island:

### Step 1 — Governor droop + baseline + AGC offset (primary control)
Each generator dispatches to a target that combines its baseline contract, full droop governor response (no FCR headroom clamp), and AGC offset:

- **Balancing mode**: `target = baselineContract + govMod + agcOffset`
  - `govMod = -(1/droop) × ((f-f₀)/f₀) × rating` — full droop, no clamp
- **FCR-only mode**: same FCR response, no AGC participation
- **Fixed mode**: `target = baselineContract` — no frequency response
- Generator output approaches target with a **first-order turbine lag**: `mw += (target - mw) × dt / T`
  - Ramp-up: `T = turbineTimeConstant` (default 1s)
  - Ramp-down: `T = rampDownTC` (default 0.3s — 3× faster, configurable)
- Target clamped by `afrrMin`/`afrrMax` bounds, rating, and 0 MW floor

### Step 2 — Storage FCR
Storage dispatches with its own droop response around a baseline contract:

- **Balancing mode**: `target = baselineContract + govMod + agcOffset`
  - `govMod = -(1/droop) × ((f-f₀)/f₀) × dischargeRate`
- **Fixed mode**: `target = baselineContract + fixedTarget`
- Target clamped by charge rate (negative) and discharge rate (positive), plus SoC limits
- Response smoothed with 0.1s time constant (faster than thermal gens)
- State of charge tracks energy: `soc -= mwResponse × dt / 3600`

### Step 3 — Swing equation (frequency dynamics)
`df/dt = (imbalance × f₀) / (2 × totalInertiaEnergy)`

- **Generator islands**: inertia from `Σ (Hᵢ × ratingᵢ)` of all online gens
- **Storage-only islands**: synthetic inertia from `Σ (dischargeRate × 3)` of storage units
- **No supply**: frequency decays at 10 Hz/s
- Frequency clamped to [45, 55] Hz

### Step 4 — Generator frequency protection
Generators trip if frequency exceeds limits for 1 second:
- **Overspeed**: >52 Hz → trip, red X overlay
- **Underfrequency**: <48 Hz → trip, red X overlay
- Events logged to `sim.events[]`

### Step 5 — DC Power Flow
Solves per-island using B' matrix + Gaussian elimination:

- Builds nodal admittance matrix from connection reactances
- Slack bus absorbs island imbalance (first gen or first node)
- Line flows: `P_ij = (θ_i - θ_j) / X_ij`
- Lines color-coded by loading percentage (green → yellow → red)
- Only active (non-tripped) lines participate

### Step 6 — Line tripping + cascade
Overloaded lines accumulate a trip timer based on severity:

| Loading | Trip time |
|---|---|
| >200% | 0.5s |
| 150-200% | 2s |
| 120-150% | 5s |
| 100-120% | 10s |

- Progress bar drawn on overloaded lines
- Tripped lines turn dashed grey with X
- Cascade: trips redistribute flow → more overloads → more trips
- Events logged with flow and timestamp

### Step 7 — Under-Frequency Load Shedding (UFLS)
Stepped shedding latching on frequency thresholds:

| Frequency | Shed (cumulative) |
|---|---|
| <49.0 Hz | 10% |
| <48.5 Hz | 25% |
| <48.0 Hz | 50% |

- Shed percentage latches up (needs ≥49.5 Hz to restore)
- Orange `SHD N%` badge on shed loads
- `baseMw` stored to allow restoration

### Step 8 — AGC (aFRR / secondary control) — Generators
Slowly adjusts `agcOffset` of balancing gens to restore 50 Hz:

- Rate limit: 5 MW/s per gen (0.5 MW/tick)
- Proportional distribution by upward headroom (afrrMax rating share)
- Aggression: `50 × freqErr × dt`
- Anti-windup clamped by FCR headroom boundaries

### Step 8b — AGC — Storage
Same as gen AGC but faster:

- Rate limit: 20 MW/s (2 MW/tick)
- Proportional distribution by charge+discharge headroom
- Aggression: `100 × freqErr × dt` (more aggressive than gens)
- Anti-windup clamped by physical limits

### Step 9–10
- UI panel refresh (settings panels, frequency HUD)
- Time-series capture every 0.25s to `dataBuffer` for snapshot export

## Stranded island handling
- **Gen-only island**: gens ramp to 0, lines zeroed, freq held at 50 Hz
- **Load-only island** (no supply): loads drop to 0, lines zeroed
- **Mixed with tripped lines**: BFS from both gens AND storage roots; loads not reachable via active connections get ⚠️ warning indicator and flash off-screen directional arrows
- Storage root inclusion prevents loads served by storage from being falsely marked stranded

## Data capture
- `sim.dataBuffer` captures every 0.25s: frequency, per-node mw, baselineContract, agcOffset, soc, shedPct, connection flows/loading/tripped status, island membership, initial grid topology
- **Save Data** button → POST `/api/save-snapshot` → writes to `snapshots/{timestamp}-{token}.json`
- Snapshots include grid state at snapshot time for replayability

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
| **J key** | Toggle between junction mode (default) and **status mode** (line inspection) |
| Click line (status mode) | Select line (gold glow) |
| Ctrl+click line (status mode) | Multiselect lines |
| **Ctrl+C** (status mode) | Copy selected line's reactance + thermal limit |
| **Ctrl+V** (2 nodes selected) | Paste line properties onto new connection between them |
| **Ctrl+Shift+V** (lines selected) | Paste line properties onto selected lines |
| **Click frequency HUD** | Toggle frequency history chart (last 60s, draggable) |
| **Island header hover** | Show island bounding box with dashed outline + full node extent |

### Controls bar
- **▶ Play / ⏸ Pause / ⟳ Restart** — simulation lifecycle
- **⚖️ Balance** — resets all island frequencies to 50 Hz, clears trips/shedding, then distributes load proportionally across flexible gens AND storage (by rating/discharge rate). Storage can charge (negative baseline) when surplus exists. Calls `persist()` and `updateControls()` after distribution.
- **💾 Save Data** — exports time-series to `snapshots/` as JSON
- **FCR / aFRR badges** — light up when primary/secondary control is active
- **📊 Stats panel** — expandable supply/demand breakdown with per-node decomposition

### Stats panel
For each generator and storage node, shows:
```
G-123 (gen)   +145 MW
  base 100 + FCR +47 + AGC -2

S-ABC (storage)   -30 MW
  SoC: 72/100 MWh
  base 0 + FCR -20 + AGC -10
```
- "FCR" shows the full governor response (no headroom clamp) for both gens and storage
- "AGC" shows accumulated secondary control offset
- Same consistent terminology across both node types

### Settings panels per node type
- **Generator**: baseline contract (MW), ramp up/down TC (s), rating (MVA), inertia H (s), droop (%), modfe selector (Balancing / FCR Only / Fixed), aFRR min/max bounds, FCR headroom (MW)
- **Load**: demand slider (MW)
- **Storage**: baseline contract (MW), discharge rate (MW), charge rate (MW), max capacity (MWh), SoC readout, droop (%), mode selector (Balancing / Fixed / Idle), FCR headroom (MW)
- Panels are draggable, resizable, and independently scrollable, max 350px height

## Physics constants
- Frequency: 50 Hz nominal, clamped 45–55 Hz
- Default droop: 4% (speed governor droop)
- Default inertia: 5s per generator
- Default turbine time constant: 1.0s (ramp-up), 0.3s (ramp-down)
- Default battery time constant: 0.1s
- Default rating: 100 MVA
- Synthetic inertia for storage-only: 3× discharge rate
- Storage AGC rate: 20 MW/s, gen AGC rate: 5 MW/s

## Node short IDs
Format `T-NNNX` (e.g. `G-354A`, `L-271B`, `S-480M`):
- G = generator, L = load, S = storage, J = junction
- Generated at creation with `shortId(type)` — replaces opaque `id.slice(-4)`

## Island visualization
- Each electrical island gets a color (8-color cycle)
- Hover island header → dashed bounding box with fill
- Selected network gets thicker border + ▶ prefix
- Frequency label per island header

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
- `startSim()` → `setInterval(simTick, 100ms)` → 10-step physics loop
- Canvas events → mouse handlers → `draw()`, `persist()`, or context menu
- `simTick()` → `recomputeNetworks()` → per-island loop: governor → storage → swing eq → protection → DC power flow → line trip → UFLS → AGC (gen + storage) → UI refresh → capture
- `balanceGrid()` → reset trips/shed/freq → `findNetworks()` → distribute load across flex gens + storage → `persist()` → `draw()` → `updateControls()` → `updateStatsPanel()`

### State objects
- `state` — grid data (nodes, connections), view transform, frequency, selection, pending connections, line clipboard, line mode, networks, stranded loads
- `sim` — simulation lifecycle (running, interval, tickHz, dataBuffer, events)
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
