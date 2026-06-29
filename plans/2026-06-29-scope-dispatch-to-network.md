# Plan: Scope dispatchMeritOrder to a single network

## Problem
`dispatchMeritOrder()` aggregates ALL nodes globally (network-blind). An unconnected gen in its own island is treated as available capacity, receives a baseline allocation, and connected gens get less — causing a real frequency dip on the main grid.

## Root cause
- Line 254: `dispatchMeritOrder(true)` fires inside `for (const net of state.networks)` — once per network, all overwriting the same state
- Line 47-49: `allGens = state.nodes.filter(...)` has no network filter
- Line 62-64: `loadTotal = state.nodes.filter(...)` has no network filter
- Every dispatch call sees the unconnected gen and assigns it baselines

## Changes

### 1. `dispatchMeritOrder()` — add optional `network` param (Engine.js)
- Add `network = null` parameter
- When `network` is provided, derive `netNodeIds`: `network.nodeIds`
- Filter `allGens`, `allStorages`, and `loadTotal` to only include nodes in `netNodeIds`
- Line 124-126: merchant storage `mwResponse` sync also scoped to network nodes

```js
dispatchMeritOrder(topUpBalancing = false, writeMw = false, network = null) {
  const { state } = this.store;
  const netIds = network ? network.nodeIds : null;
  const inNet = (n) => !netIds || netIds.has(n.id);
  
  const allGens = state.nodes.filter(
    (n) => n.type === "generator" && !n.tripped && inNet(n)
  );
  // ...
  const loadTotal = state.nodes
    .filter((n) => n.type === "load" && inNet(n))
    .reduce((s, l) => s + (l.mw || 0), 0);
  // Similar for allStorages
}
```

### 2. Move market dispatch OUT of per-network loop (Engine.js)
- Remove lines 250-256 from inside `for (const net of state.networks)`
- Add them BEFORE the loop starts (after line 199)
- Find the main network (one with loads)
- Only run dispatch on that network

```js
// === Market dispatch (once per tick, scoped to main grid) ===
const mainNet = state.networks.find(net => {
  const netNodes = [...net.nodeIds].map(id => state.nodes.find(n => n.id === id)).filter(Boolean);
  return netNodes.some(n => n.type === "load");
});
const patSec = sim.simTime * 720;
if (mainNet && patSec - (sim.lastMarketPat || 0) >= 900) {
  sim.lastMarketPat = patSec;
  this.dispatchMeritOrder(true, false, mainNet);
  if (meritChartVisible) drawMeritOrderChart();
}
```

### 3. Verify other callers of dispatchMeritOrder (Engine.js)
- Line 45414 (restart): `this.dispatchMeritOrder(true, true)` — currently no network filter
  - Fix: pass `mainNet` here too, or the first network with loads after recomputeNetworks
  - Since restart runs `recomputeNetworks()` first, pass the main network
- Line 50494 (initial setup): `this.dispatchMeritOrder()` — no args, no network
  - This runs before any physics, probably fine as a global first-pass. Or scope it.

## Edge cases
- **Islanding** — if a line trips and creates a new island with both gen and load, that island won't get a market dispatch. But that's correct — an islanded grid would have its own local market. Future feature.
- **Storage in island** — merchant storage in the unconnected gen's island won't be dispatched. But it has no load and no market, so that's correct.
- **Multiple load-carrying networks** — only the first one "wins" the market dispatch. For now, there's only one grid, so this is fine.
