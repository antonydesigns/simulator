// ─── State ────────────────────────────────────────────────────────────

const state = {
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
};

let hoveredIslandId = null;
let hoveredIslandHeader = false;
let islandDrag = null; // { netId, startMouseX, startMouseY, origPositions: [{id, x, y}] }

// ─── Island Colors ─────────────────────────────────────────────────────

const ISLAND_COLORS = [
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

const sim = {
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

function recomputeNetworks() {
  state.networks = findNetworks();
  // Ensure freqPrev is initialized for all networks
  for (const net of state.networks) {
    if (net.freqPrev === undefined) net.freqPrev = net.freq || 50;
  }
}

// ─── Auto-Demand (Noise) ────────────────────────────────────────────────
// Daily demand curve with weekly variation.
// t = pattern-time in seconds (720x acceleration: 2 real min = 1 pattern day)
function demandCurve(t) {
  const day = 86400;
  const week = 7 * day;
  const tod = (((t % day) / day) * 24 + 24) % 24; // hour of day (0-24)
  const dow = Math.floor((t % week) / day); // day of week (0-6, Mon=0)

  // Daily shape: valley ~4AM, morning peak ~10AM, afternoon peak ~4-6PM
  let daily = 0.5 - 0.45 * Math.cos((tod - 4) / 24 * 2 * Math.PI);
  // Morning bump (~10AM)
  daily += 0.15 * Math.exp(-Math.pow((tod - 10) / 1.5, 2));
  // Lunch recovery bump
  daily += 0.05 * Math.exp(-Math.pow((tod - 14) / 2, 2));
  daily = Math.max(0, Math.min(1, daily));

  // Weekly: weekends (Sat=5, Sun=6) 15% lower
  const weekend = (dow === 5 || dow === 6) ? 0.85 : 1;
  return daily * weekend;
}

// ─── Merit Order Dispatch ────────────────────────────────────────────────

function dispatchMeritOrder() {
  const allGens = state.nodes.filter(n => n.type === 'generator' && !n.tripped);
  // Sort all non-fixed gens by bid price (cheapest first)
  const merit = allGens.filter(g => g.mode !== 'fixed').sort((a, b) => a.bidPrice - b.bidPrice);
  const totalLoad = state.nodes.filter(n => n.type === 'load').reduce((s, l) => s + (l.mw || 0), 0);

  // Reset baselines for merchant + balancing gens (fixed gens keep manual baseline)
  for (const gen of allGens) {
    if (gen.mode !== 'fixed') gen.baselineContract = 0;
  }

  let remaining = totalLoad;
  let smp = 0;

  for (const gen of merit) {
    const qty = gen.bidQty || gen.rating || 100;
    const dispatch = Math.min(remaining, qty);
    gen.baselineContract = Math.max(0, dispatch);
    remaining -= dispatch;
    if (dispatch > 0) smp = gen.bidPrice;
  }

  state.smp = remaining <= 0 ? smp : null; // null = insufficient capacity
  state.marketLoad = totalLoad;
}

function simTick() {
  recomputeNetworks();
  const f0 = 50;
  const dt = (1 / sim.tickHz) * sim.speed;
  sim.simTime += dt;

  // Clear stale line flow data — only recomputed lines get updated
  for (const c of state.connections) {
    c.mw = undefined;
    c.loadingPct = undefined;
  }

  for (const net of state.networks) {
    const freq = net.freq;
    const netNodes = [...net.nodeIds].map(id => state.nodes.find(n => n.id === id)).filter(Boolean);
    const allGens = netNodes.filter(n => n.type === 'generator');
    const gens = allGens.filter(g => !g.tripped);
    const loads = netNodes.filter(n => n.type === 'load');
    const allStorages = netNodes.filter(n => n.type === 'storage');
    const storages = allStorages.filter(s => !s.tripped);

    if (gens.length === 0 && loads.length === 0 && allStorages.length === 0) continue;

    // --- Auto Demand Curve (noise) ---
    for (const load of loads) {
      if (load.noiseEnabled) {
        const patSec = sim.simTime * 720;
        const mult = demandCurve(patSec);
        const noisePct = (load.noisePct || 10) / 100;
        const step = noisePct * 0.04;
        load._noiseDrift = (load._noiseDrift || 0) + (Math.random() - 0.5) * step;
        load._noiseDrift = Math.max(-noisePct, Math.min(noisePct, load._noiseDrift));
        load.mw = Math.round((load.noiseMin || 100) + ((load.noiseMax || 200) - (load.noiseMin || 100)) * mult * (1 + load._noiseDrift));
        load.baseMw = load.mw;
      }
    }

    // --- Market dispatch (15 pattern-minutes = 900 pattern-seconds) ---
    const patSec = sim.simTime * 720;
    if (patSec - (sim.lastMarketPat || 0) >= 900) {
      sim.lastMarketPat = patSec;
      dispatchMeritOrder();
      if (meritChartVisible) drawMeritOrderChart();
    }

    const totalGen = gens.reduce((s, g) => s + (g.mw || 0), 0);
    const totalLoad = loads.reduce((s, l) => s + (l.mw || 0), 0);

    // --- Handle stranded island types ---
    const hasGen = gens.length > 0, hasLoad = loads.length > 0, hasStor = storages.length > 0;
    const hasEffectiveStor = storages.some(s =>
      (s.mw || 0) > 0.5 &&
      s.mode !== 'fixed' &&
      (s.dischargeRate || 50) > 0
    );
    if (hasGen && !hasLoad && !hasStor) {
      for (const gen of gens) gen.mw = 0;
      for (const c of state.connections) if (net.nodeIds.has(c.sourceId) && net.nodeIds.has(c.targetId)) { c.mw = 0; c.loadingPct = 0; }
      net.freq = f0; continue;
    }
    if (!hasGen && !hasEffectiveStor && hasLoad) {
      for (const load of loads) { load.mw = 0; state.strandedLoadIds.add(load.id); }
      for (const c of state.connections) if (net.nodeIds.has(c.sourceId) && net.nodeIds.has(c.targetId)) { c.mw = 0; c.loadingPct = 0; }
      net.freq = f0; continue;
    }
    if (!hasGen && !hasLoad && hasStor) {
      for (const st of storages) { st.mwResponse = 0; }
      for (const c of state.connections) if (net.nodeIds.has(c.sourceId) && net.nodeIds.has(c.targetId)) { c.mw = 0; c.loadingPct = 0; }
      net.freq = f0; continue;
    }
    if (hasGen && !hasLoad && hasStor) {
      for (const gen of gens) gen.mw = 0;
      for (const st of storages) st.mwResponse = 0;
      for (const c of state.connections) if (net.nodeIds.has(c.sourceId) && net.nodeIds.has(c.targetId)) { c.mw = 0; c.loadingPct = 0; }
      net.freq = f0; continue;
    }

    // Note: stranded loads within mixed islands are zeroed after the stranded detection step, below

    // --- Physics sub-step loop (smooth at any sim speed) ---
    {
    const physicsSteps = Math.max(1, Math.ceil(dt / 0.05));
    const physicsDt = dt / physicsSteps;
    const subFreqRef = { value: net.freq }; // mutable ref for sub-step freq
    for (let _p = 0; _p < physicsSteps; _p++) {
      const subFreq = subFreqRef.value;

    // --- Step 1: Governor droop + baseline + AGC offset ---
    for (const gen of gens) {
      if (gen.tripped) { gen.mw = 0; continue; }
      let totalTarget;
      if (gen.mode === 'merchant') {
        totalTarget = gen.baselineContract || 0;
      } else if (gen.mode === 'fixed') {
        totalTarget = gen.baselineContract || 0;
      } else if (gen.mode === 'fcr-only') {
        const droop = gen.droop || 0.04;
        const rating = gen.rating || 100;
        const dev = (subFreq - f0) / f0;
        const govMod = -(1 / droop) * dev * rating;
        totalTarget = (gen.baselineContract || 0) + govMod;
      } else {
        const droop = gen.droop || 0.04;
        const rating = gen.rating || 100;
        const dev = (subFreq - f0) / f0;
        const govMod = -(1 / droop) * dev * rating;
        totalTarget = (gen.baselineContract || 0) + govMod + (gen.agcOffset || 0);
      }
      const genRating = gen.rating || Infinity;
      totalTarget = Math.max(0, Math.min(genRating, totalTarget));
      const current = gen.mw || 0;
      const T = totalTarget < current ? (gen.rampDownTC || 0.3) : (gen.turbineTimeConstant || 1);
      gen.mw = current + (totalTarget - current) * physicsDt / T;
    }

    // --- Step 2: Storage FCR ---
    for (const st of storages) {
      if (st.energyNeutral) st.agcOffset = 0;
      const bc = st.baselineContract || 0;
      const soc = st.mw || 0;
      const cap = st.maxCapacity || 100;
      const cr = st.chargeRate || 50;
      const dr = st.dischargeRate || 50;
      const maxDischargeP = soc / (physicsDt / 3600);
      const maxChargeP = (cap - soc) / (physicsDt / 3600);

      if (st.mode === 'balancing') {
        const droop = st.droop || 0.04;
        const dev = (subFreq - f0) / f0;
        const effectiveRating = dr;
        const govMod = -(1 / droop) * dev * effectiveRating;
        let target = bc + govMod + (st.agcOffset || 0);
        target = Math.max(-cr, Math.min(dr, target));
        target = Math.max(-maxChargeP, Math.min(maxDischargeP, target));
        const stTC = 0.1;
        const prevResp = st.mwResponse || 0;
        st.mwResponse = prevResp + (target - prevResp) * Math.min(1, physicsDt / stTC);
      } else if (st.mode === 'fcr-only') {
        const droop = st.droop || 0.04;
        const dev = (subFreq - f0) / f0;
        const govMod = -(1 / droop) * dev * dr;
        let target = bc + govMod;
        target = Math.max(-cr, Math.min(dr, target));
        target = Math.max(-maxChargeP, Math.min(maxDischargeP, target));
        const stTC = 0.1;
        const prevResp = st.mwResponse || 0;
        st.mwResponse = prevResp + (target - prevResp) * Math.min(1, physicsDt / stTC);
      } else if (st.mode === 'grid-forming') {
        const droop = st.droop || 0.04;
        const dev = (subFreq - f0) / f0;
        const govMod = -(1 / droop) * dev * dr;
        st.freqRestore = (st.freqRestore || 0) + 5 * (f0 - subFreq) * physicsDt;
        st.freqRestore = Math.max(-dr, Math.min(dr, st.freqRestore));
        let target = bc + govMod + st.freqRestore;
        target = Math.max(-cr, Math.min(dr, target));
        target = Math.max(-maxChargeP, Math.min(maxDischargeP, target));
        const stTC = 0.1;
        const prevResp = st.mwResponse || 0;
        st.mwResponse = prevResp + (target - prevResp) * Math.min(1, physicsDt / stTC);
      } else if (st.mode === 'fixed') {
        let target = bc + (st.fixedTarget || 0);
        target = Math.max(-cr, Math.min(dr, target));
        target = Math.max(-maxChargeP, Math.min(maxDischargeP, target));
        st.mwResponse = (st.mwResponse || 0) + (target - (st.mwResponse || 0)) * Math.min(1, physicsDt / 0.1);
      }
      st.mw = Math.max(0, Math.min(cap, soc - st.mwResponse * physicsDt / 3600));
    }

    const totalStorage = storages.reduce((s, st) => s + (st.mwResponse || 0), 0);
    const imbalance = totalGen + totalStorage - totalLoad;

    // --- Step 3: Swing equation ---
    if (gens.length > 0) {
      net.freqPrev = net.freq;
      let totalInertiaEnergy = 0;
      for (const gen of gens) totalInertiaEnergy += (gen.inertia || 5) * (gen.rating || 100);
      let dfdt = 0;
      if (totalInertiaEnergy > 0) dfdt = (imbalance * f0) / (2 * totalInertiaEnergy);
      subFreqRef.value = Math.max(45, Math.min(55, subFreq + dfdt * physicsDt));
    } else if (storages.length > 0) {
      net.freqPrev = net.freq;
      const stoInertia = storages.reduce((s, st) => s + ((st.dischargeRate || 500) * 3), 0);
      let dfdt = stoInertia > 0 ? (imbalance * f0) / (2 * stoInertia) : 0;
      subFreqRef.value = Math.max(45, Math.min(55, subFreq + dfdt * physicsDt));
    } else {
      net.freqPrev = net.freq;
      subFreqRef.value = Math.max(0, subFreq - 10 * physicsDt);
    }

    // --- Step 4: Generator frequency protection ---
    for (const gen of allGens) {
      if (gen.tripped) continue;
      if (subFreqRef.value > 52 || subFreqRef.value < 48) {
        gen.freqTimer = (gen.freqTimer || 0) + physicsDt;
        if (gen.freqTimer >= 1) {
          gen.tripped = true;
          gen.mw = 0;
          const cause = subFreqRef.value > 52 ? 'overspeed' : 'underfrequency';
          sim.events.push({ t: (sim.dataBuffer.length || 0) * 0.25, type: 'gen-trip', nodeId: gen.id, freq: subFreqRef.value, cause });
        }
      } else {
        gen.freqTimer = 0;
      }
    }

    // --- Step 4b: Storage frequency protection ---
    for (const st of storages) {
      if (st.tripped || st.mode === 'grid-forming') continue;
      if (subFreqRef.value > 52 || subFreqRef.value < 48) {
        st.freqTimer = (st.freqTimer || 0) + physicsDt;
        if (st.freqTimer >= 1) {
          st.tripped = true;
          st.mwResponse = 0;
          sim.events.push({ t: (sim.dataBuffer.length || 0) * 0.25, type: 'storage-trip', nodeId: st.id, freq: subFreqRef.value, cause: subFreqRef.value > 52 ? 'overfrequency' : 'underfrequency' });
        }
      } else {
        st.freqTimer = 0;
      }
    }

    // --- Step 5: DC Power Flow ---
    if (hasLoad) solveDCPowerFlow(net, state.nodes, state.connections);

    // --- Step 6: Line Overload / trip logic ---
    const tripCurve = [
      { limit: 200, time: 0.5 },
      { limit: 150, time: 1 },
      { limit: 120, time: 5 },
      { limit: 100, time: Infinity },
    ];
    const netConns = state.connections.filter(c =>
      net.nodeIds.has(c.sourceId) && net.nodeIds.has(c.targetId)
    );
    for (const c of netConns) {
      if (c.tripped) continue;
      const pct = c.loadingPct || 0;
      if (pct > 100) {
        let tripTime = 0;
        for (const tc of tripCurve) {
          if (pct >= tc.limit) { tripTime = tc.time; break; }
        }
        if (tripTime > 0) {
          c.tripTimer = (c.tripTimer || 0) + physicsDt;
          if (c.tripTimer >= tripTime) {
            c.tripped = true;
            c.tripTimer = tripTime;
            sim.events.push({ t: (sim.dataBuffer.length || 0) * 0.25, type: 'line-trip', lineId: c.id, loading: pct, flow: c.mw });
          }
        }
      } else {
        c.tripTimer = 0;
      }
    }

    // --- Step 7: Under-Frequency Load Shedding (UFLS) ---
    if (hasLoad) {
      for (const load of loads) {
        if (load.baseMw === undefined) load.baseMw = load.mw || 0;
        const f = subFreqRef.value;
        let targetShed = 0;
        if (f < 48.0) targetShed = 0.50;
        else if (f < 48.5) targetShed = 0.25;
        else if (f < 49.0) targetShed = 0.10;
        if (f < 49.5) {
          load.shedPct = Math.max(load.shedPct || 0, targetShed);
        } else {
          load.shedPct = 0;
        }
        load.mw = load.baseMw * (1 - (load.shedPct || 0));
      }
    }

    // --- Step 7b: Blackout load shedding (grid-forming headroom) ---
    if (hasLoad && !hasGen) {
      const gfStorages = storages.filter(s => s.mode === 'grid-forming');
      if (gfStorages.length > 0) {
        const gfCapacity = gfStorages.reduce((s, st) => s + (st.dischargeRate || 500), 0);
        const targetLoad = gfCapacity * 0.5;
        const currentLoad = loads.reduce((s, l) => s + (l.mw || 0), 0);
        if (currentLoad > targetLoad) {
          const scale = targetLoad / currentLoad;
          for (const load of loads) {
            const newMw = (load.mw || 0) * scale;
            load.shedPct = Math.max(load.shedPct || 0, 1 - (newMw / (load.baseMw || load.mw)));
            load.mw = newMw;
          }
        }
      }
    }

    // --- Step 8: AGC (gens) ---
    const balancingGens = gens.filter(g => g.mode === 'balancing');
    const freqErr = f0 - subFreqRef.value;
    if (balancingGens.length > 0) {
      const agcRateLimit = 5;
      const maxDelta = agcRateLimit * physicsDt;
      const totalHeadroom = balancingGens.reduce((s, g) => s + Math.max(0, (g.rating || 100) - (g.baselineContract || 0) - (g.fcrHeadroom || 10)), 0);
      if (totalHeadroom > 0) {
        const totalAgc = 50 * freqErr * physicsDt;
        for (const gen of balancingGens) {
          const upwardHeadroom = Math.max(0, (gen.rating || 100) - (gen.baselineContract || 0) - (gen.fcrHeadroom || 10));
          const share = upwardHeadroom / totalHeadroom;
          const agcDelta = totalAgc * share;
          const clamped = Math.max(-maxDelta, Math.min(maxDelta, agcDelta));
          if (Math.abs(clamped) > 0.0001) {
            gen.agcOffset = (gen.agcOffset || 0) + clamped;
            const minAgc = (gen.fcrHeadroom || 10) - (gen.baselineContract || 0);
            const maxAgc = (gen.rating || 100) - (gen.baselineContract || 0);
            gen.agcOffset = Math.max(minAgc, Math.min(maxAgc, gen.agcOffset));
          }
        }
      }
    }

    // --- Step 8b: AGC (storage) ---
    const balancingStorages = storages.filter(s => s.mode === 'balancing' && !s.energyNeutral && (s.dischargeRate || 500) > 0);
    if (balancingStorages.length > 0) {
      const agcRateLimit = 20;
      const maxDelta = agcRateLimit * physicsDt;
      const totalStorHeadroom = balancingStorages.reduce((s, st) => {
        const bc = st.baselineContract || 0;
        const dr = st.dischargeRate || 500;
        const cr = st.chargeRate || 500;
        return s + Math.max(0, dr - bc) + Math.max(0, bc + cr);
      }, 0);
      if (totalStorHeadroom > 0) {
        const totalAgc = 100 * freqErr * physicsDt;
        for (const st of balancingStorages) {
          const bc = st.baselineContract || 0;
          const dr = st.dischargeRate || 500;
          const cr = st.chargeRate || 500;
          const stHeadroom = Math.max(0, dr - bc) + Math.max(0, bc + cr);
          const share = stHeadroom / totalStorHeadroom;
          const agcDelta = totalAgc * share;
          const clamped = Math.max(-maxDelta, Math.min(maxDelta, agcDelta));
          if (Math.abs(clamped) > 0.0001) {
            st.agcOffset = (st.agcOffset || 0) + clamped;
            const maxStAgc = dr - bc - (st.fcrHeadroom || 10);
            const minStAgc = -(cr + bc - (st.fcrHeadroom || 10));
            st.agcOffset = Math.max(minStAgc, Math.min(maxStAgc, st.agcOffset));
          }
        }
      }
    }
    }

    // Sync network freq from sub-step ref at end of all physics sub-steps
    net.freq = subFreqRef.value;
  }
  }

  // Update global state.frequency for backward compat (first network's freq)
  state.frequency = state.networks.length > 0 ? state.networks[0].freq : 50;

  // --- Detect stranded loads (within-island components with load but no gen) ---
  state.strandedLoadIds = new Set();
  for (const net of state.networks) {
    const netNodes = [...net.nodeIds].map(id => state.nodes.find(n => n.id === id)).filter(Boolean);
    const activeConns = state.connections.filter(c =>
      !c.tripped && net.nodeIds.has(c.sourceId) && net.nodeIds.has(c.targetId)
    );
    const adj = {};
    for (const n of netNodes) adj[n.id] = [];
    for (const c of activeConns) { adj[c.sourceId].push(c.targetId); adj[c.targetId].push(c.sourceId); }
    const visited = new Set();
    for (const n of netNodes) {
      if (visited.has(n.id) || (n.type !== 'generator' && n.type !== 'storage')) continue;
      const q = [n.id]; visited.add(n.id);
      while (q.length) {
        const id = q.shift();
        for (const nb of (adj[id] || [])) { if (!visited.has(nb)) { visited.add(nb); q.push(nb); } }
      }
    }
    for (const n of netNodes) {
      if (n.type === 'load' && !visited.has(n.id)) { state.strandedLoadIds.add(n.id); n.mw = 0; }
    }
  }

  let changed = true;

  // --- Step 7: Update open settings panels ---
  for (const nodeId of Object.keys(openPanels)) {
    const gen = state.nodes.find(n => n.id === nodeId && n.type === 'generator');
    if (gen) {
      const entry = openPanels[nodeId];
      if (entry.outputEl) entry.outputEl.textContent = Math.round(gen.mw || 0) + ' MW';
      if (entry.baselineSlider && entry.baselineVal) {
        const d = gen.baselineContract || 0;
        if (d > parseInt(entry.baselineSlider.max)) entry.baselineSlider.max = d;
        entry.baselineSlider.value = d;
        entry.baselineVal.textContent = Math.round(d) + ' MW';
      }
      if (entry.shutdownBtn) {
        entry.shutdownBtn.textContent = gen.tripped ? '🔄 Restart' : '🛑 Shut Down';
        entry.shutdownBtn.style.background = gen.tripped ? '#27ae60' : 'transparent';
        entry.shutdownBtn.style.color = gen.tripped ? '#fff' : '#c0392b';
      }
    }
    const st = state.nodes.find(n => n.id === nodeId && n.type === 'storage');
    if (st) {
      const entry = openPanels[nodeId];
      if (entry.socEl) entry.socEl.textContent = (st.mw || 0).toFixed(2) + ' MWh';
      if (entry.mwRespEl) entry.mwRespEl.textContent = (st.mwResponse || 0) >= 0
        ? '+' + Math.round(st.mwResponse || 0) + ' MW'
        : Math.round(st.mwResponse || 0) + ' MW';
      if (entry.modeSelect) entry.modeSelect.value = st.mode || 'balancing';
      if (entry.fcrGroup) entry.fcrGroup.style.display = (st.mode === 'balancing' || st.mode === 'fcr-only') ? '' : 'none';
      if (entry.fixedGroup) entry.fixedGroup.style.display = (st.mode === 'fixed') ? '' : 'none';
      if (entry.neutralGroup) entry.neutralGroup.style.display = st.mode === 'balancing' ? '' : 'none';
      if (entry.fcrSlider && entry.fcrVal) {
        entry.fcrSlider.value = st.fcrHeadroom || 10;
        entry.fcrVal.textContent = Math.round(st.fcrHeadroom || 10) + ' MW';
      }
      if (entry.droopSlider && entry.droopVal) {
        entry.droopSlider.value = (st.droop || 0.04) * 100;
        entry.droopVal.textContent = Math.round((st.droop || 0.04) * 100) + '%';
      }
      if (entry.fixedSlider && entry.fixedVal) {
        entry.fixedSlider.value = st.fixedTarget || 0;
        entry.fixedVal.textContent = (st.fixedTarget || 0) >= 0
          ? '+' + Math.round(st.fixedTarget || 0) + ' MW'
          : Math.round(st.fixedTarget || 0) + ' MW';
      }
      if (entry.bcSlider && entry.bcVal) {
        entry.bcSlider.value = st.baselineContract || 0;
        entry.bcVal.textContent = (st.baselineContract || 0) >= 0
          ? '+' + Math.round(st.baselineContract || 0) + ' MW'
          : Math.round(st.baselineContract || 0) + ' MW';
      }
      if (entry.shutdownBtn) {
        entry.shutdownBtn.textContent = st.tripped ? '🔄 Restart' : '🛑 Shut Down';
        entry.shutdownBtn.style.background = st.tripped ? '#27ae60' : 'transparent';
        entry.shutdownBtn.style.color = st.tripped ? '#fff' : '#c0392b';
      }
    }
  }

  // --- Step 5a: Update FCR / aFRR status badges ---
  {
    const fcrBadge = document.getElementById('fcr-badge');
    const agcBadge = document.getElementById('agc-badge');
    const allGens = state.nodes.filter(n => n.type === 'generator');
    const fcrGens = allGens.filter(g => g.mode === 'balancing' || g.mode === 'fcr-only');
    const fcrActive = fcrGens.some(g => {
      const dev = (state.frequency - f0) / f0;
      const govMod = -(1 / (g.droop || 0.04)) * dev * (g.rating || 100);
      return Math.abs(govMod) > 0.5 && Math.abs(govMod) <= (g.fcrHeadroom || 10);
    });
    fcrBadge.className = 'status-badge ' + (fcrActive ? 'fcr-active' : 'fcr-inactive');
    const balancingGens = allGens.filter(g => g.mode === 'balancing');
    const agcActive = Math.abs(f0 - state.frequency) > 0.001 && balancingGens.length > 0;
    agcBadge.className = 'status-badge ' + (agcActive ? 'agc-active' : 'agc-inactive');
  }

  // --- Step 5b: Refresh stats panel ---
  updateStatsPanel();

  // --- Step 6: Time-series capture at 1/4 s intervals ---
  sim.captureAccum += dt;
  if (sim.captureAccum >= 0.25) {
    sim.captureAccum -= 0.25;
    const netFreqs = {};
    for (const net of state.networks) netFreqs[net.id] = net.freq;
    const entry = { t: sim.dataBuffer.length * 0.25, frequency: state.frequency, networks: netFreqs, nodes: {}, connections: {}, nodeNetworks: {} };
    for (const node of state.nodes) {
      entry.nodes[node.id] = { type: node.type, mw: node.mw || 0 };
      if (node.type === 'generator') {
        entry.nodes[node.id].baselineContract = node.baselineContract || 0;
        entry.nodes[node.id].agcOffset = node.agcOffset || 0;
        entry.nodes[node.id].mode = node.mode || 'balancing';
        entry.nodes[node.id].rating = node.rating || 100;
        entry.nodes[node.id].droop = node.droop || 0.04;
        entry.nodes[node.id].fcrHeadroom = node.fcrHeadroom || 10;
        entry.nodes[node.id].bidPrice = node.bidPrice || 50;
        entry.nodes[node.id].bidQty = node.bidQty || node.rating || 100;
        entry.nodes[node.id].turbineTimeConstant = node.turbineTimeConstant || 1;
      }
      if (node.type === 'storage') {
        entry.nodes[node.id].mwResponse = node.mwResponse || 0;
        entry.nodes[node.id].mode = node.mode || 'balancing';
        entry.nodes[node.id].maxCapacity = node.maxCapacity || 100;
        entry.nodes[node.id].baselineContract = node.baselineContract || 0;
        entry.nodes[node.id].agcOffset = node.agcOffset || 0;
      }
    }
    // Capture connection states
    for (const c of state.connections) {
      entry.connections[c.id] = {
        mw: c.mw || 0,
        loadingPct: c.loadingPct || 0,
        tripped: !!c.tripped,
        tripTimer: c.tripTimer || 0,
        sourceId: c.sourceId,
        targetId: c.targetId,
        reactance: c.reactance,
        thermalLimit: c.thermalLimit,
      };
    }
    // Capture per-node island membership
    for (const net of state.networks) {
      for (const id of net.nodeIds) entry.nodeNetworks[id] = net.id;
    }
    sim.dataBuffer.push(entry);
  }

  if (changed) draw();
  if (freqChartVisible) drawFreqChart();
}

function startSim() {
  if (sim.running) return;
  sim.running = true;
  sim.interval = setInterval(simTick, 1000 / sim.tickHz);
}

function stopSim() {
  sim.running = false;
  if (sim.interval) { clearInterval(sim.interval); sim.interval = null; }
}

function restartSim() {
  stopSim();
  sim.dataBuffer = [];
  sim.captureAccum = 0;
  sim.events = [];
  sim.simTime = 0;
  sim.lastMarketPat = 0;
  // Reset load shedding first so loads have MW values for market dispatch
  for (const load of state.nodes.filter(n => n.type === 'load')) {
    load.shedPct = 0;
    if (load.baseMw) load.mw = load.baseMw;
  }
  // First dispatch — sets every gen's baselineContract from merit order
  dispatchMeritOrder();
  for (const gen of state.nodes.filter(n => n.type === 'generator')) {
    gen.agcOffset = 0;
    gen.mw = gen.baselineContract || 0;
    gen.tripped = false;
    gen.freqTimer = 0;
  }
  for (const st of state.nodes.filter(n => n.type === 'storage')) {
    st.baselineContract = 0;
    st.mwResponse = st.baselineContract || 0;
    st.agcOffset = 0;
    st.freqRestore = 0;
    st.tripped = false;
  }
  // Reset tripped lines
  for (const c of state.connections) { c.tripped = false; c.tripTimer = 0; }
  state.frequency = 50;
  state.networks = findNetworks();
  for (const net of state.networks) { net.freq = 50; net.freqPrev = 50; }
  draw();
  updateControls();
  updateStatsPanel();
}

// ─── Grid Balancing ────────────────────────────────────────────────────

function balanceGrid() {
  // Balance supply with demand per island.
  // Each island's flexible generators share that island's load proportionally by rating.
  const nets = findNetworks();
  if (!nets.length) return;

  // Reset all gen baselines, trips, and load shedding
  for (const gen of state.nodes.filter(n => n.type === 'generator')) {
    gen.baselineContract = 0;
    gen.agcOffset = 0;
    gen.tripped = false;
    gen.freqTimer = 0;
  }
  for (const st of state.nodes.filter(n => n.type === 'storage')) {
    st.baselineContract = 0;
    st.mwResponse = 0;
    st.agcOffset = 0;
    st.freqRestore = 0;
    st.tripped = false;
  }
  for (const c of state.connections) { c.tripped = false; c.tripTimer = 0; }
  for (const load of state.nodes.filter(n => n.type === 'load')) {
    load.shedPct = 0;
    if (load.baseMw) load.mw = load.baseMw;
  }
  // Reset island frequencies to nominal so governor doesn't override balanced dispatch
  for (const net of nets) {
    net.freq = 50;
    net.freqPrev = 50;
  }

  for (const net of nets) {
    const netNodes = [...net.nodeIds].map(id => state.nodes.find(n => n.id === id)).filter(Boolean);
    const loads = netNodes.filter(n => n.type === 'load');
    const gens = netNodes.filter(n => n.type === 'generator');
    const storages = netNodes.filter(n => n.type === 'storage');
    if (!loads.length) continue;

    const totalDemand = loads.reduce((sum, n) => sum + (n.mw || 0), 0);
    const fixedGens = gens.filter(g => g.mode === 'fixed');
    const flexGens = gens.filter(g => g.mode !== 'fixed');
    const notFixedStor = storages.filter(s => s.mode !== 'fixed');

    const fixedSupply = fixedGens.reduce((sum, g) => sum + Math.min(g.dispatchTarget || 0, g.rating || Infinity), 0);
    let remaining = totalDemand - fixedSupply;

    // Distribute proportionally across flexible gens AND storage
    // Exclude storage with insufficient SoC (can't discharge what it doesn't have)
    const dispatchableStor = notFixedStor.filter(s => s.mw === undefined || s.mw > 0);
    const flexGenRating = flexGens.reduce((sum, g) => sum + (g.rating || 100), 0);
    const flexStorRate = dispatchableStor.reduce((sum, s) => sum + (s.dischargeRate || 50), 0);
    const totalFlex = flexGenRating + flexStorRate;

    if (totalFlex > 0 && remaining > 0) {
      for (const gen of flexGens) {
        const share = (gen.rating || 100) / totalFlex;
        gen.baselineContract = Math.min(Math.round(remaining * share * 10) / 10, gen.rating || Infinity);
        gen.mw = gen.baselineContract;
      }
      for (const st of dispatchableStor) {
        const share = (st.dischargeRate || 50) / totalFlex;
        st.baselineContract = Math.min(Math.round(remaining * share * 10) / 10, st.dischargeRate || 50);
        if (st.mw !== undefined && st.mw < st.baselineContract * 0.05) st.baselineContract = 0;
        st.mwResponse = st.baselineContract;
      }
      // Redistribute any shortfall from zeroed storage to flexible gens
      const totalAllocated = flexGens.reduce((s, g) => s + (g.baselineContract || 0), 0) +
        dispatchableStor.reduce((s, st) => s + (st.baselineContract || 0), 0);
      const shortfall = remaining - totalAllocated;
      if (shortfall > 1 && flexGens.length > 0) {
        for (const gen of flexGens) {
          const addShare = (gen.rating || 100) / flexGenRating;
          gen.baselineContract = Math.min((gen.baselineContract || 0) + shortfall * addShare, gen.rating || Infinity);
          gen.mw = gen.baselineContract;
        }
      }
    } else if (totalFlex > 0 && remaining < 0) {
      // Surplus: charge storage to absorb excess (gens can't absorb, only curtail)
      for (const gen of flexGens) gen.baselineContract = 0;
      const surplus = -remaining;
      const totalRate = notFixedStor.reduce((s, st) => s + (st.chargeRate || 50), 0);
      for (const st of notFixedStor) {
        const cr = st.chargeRate || 50;
        st.baselineContract = -Math.min(Math.round(surplus * (cr / totalRate) * 10) / 10, cr);
        st.mwResponse = st.baselineContract;
      }
    }
  }

  // Update the UI
  recomputeNetworks();
  persist();
  draw();
  updateControls();
  updateStatsPanel();

  // Update open settings panels for storage dispatch slider
  for (const nodeId of Object.keys(openPanels)) {
    const entry = openPanels[nodeId];
    const st = state.nodes.find(n => n.id === nodeId && n.type === 'storage');
    if (st && entry.bcSlider && entry.bcVal) {
      entry.bcSlider.value = st.baselineContract || 0;
      entry.bcVal.textContent = (st.baselineContract || 0) >= 0
        ? '+' + Math.round(st.baselineContract || 0) + ' MW'
        : Math.round(st.baselineContract || 0) + ' MW';
    }
  }
}

async function saveSnapshot() {
  const snapshot = {
    savedAt: Date.now(),
    tickHz: sim.tickHz,
    captureInterval: 0.25,
    grid: {
      nodes: state.nodes.map(n => ({ ...n })),
      connections: state.connections.map(c => ({ ...c })),
      view: { ...state.view },
    },
    timeseries: sim.dataBuffer,
    events: sim.events,
  };
  try {
    const res = await fetch('/api/save-snapshot', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(snapshot),
    });
    const data = await res.json();
    if (data.ok) {
      const btn = document.getElementById('save-data-btn');
      const orig = btn.textContent;
      btn.textContent = '✅ ' + data.filename;
      btn.disabled = true;
      setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 2000);
    }
  } catch (e) {
    console.error('Save failed:', e);
  }
}

// ─── Pointer state ────────────────────────────────────────────────────

const ptr = {
  downWorld: null, downScreen: null, downTime: 0, downNodeId: null,
  dragOffset: { x: 0, y: 0 }, isDragging: false, isPanning: false, isSelecting: false, rightButton: false,
  _panOffsetX: 0, _panOffsetY: 0, lastClickTime: 0, lastClickNodeId: null,
  mouseWorld: null, mouseScreen: null, moved: false,
};

const DRAG_THRESHOLD = 4;

// ─── DOM Refs ──────────────────────────────────────────────────────────

const canvas = document.getElementById('grid-canvas');
const ctx = canvas.getContext('2d');
const menu = document.getElementById('context-menu');
const menuItems = document.getElementById('context-menu-items');

const openPanels = {};

let dragPanel = null, dragOff = { x: 0, y: 0 };
let resizePanel = null, resizeStart = { x: 0, y: 0, w: 0, h: 0 };

// ─── Sizing ────────────────────────────────────────────────────────────

function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = window.innerWidth * dpr;
  canvas.height = window.innerHeight * dpr;
  canvas.style.width = window.innerWidth + 'px';
  canvas.style.height = window.innerHeight + 'px';
  draw();
}

// ─── Coords ────────────────────────────────────────────────────────────

function screenToWorld(sx, sy) { return { x: (sx - state.view.x) / state.view.scale, y: (sy - state.view.y) / state.view.scale }; }
function worldToScreen(wx, wy) { return { x: wx * state.view.scale + state.view.x, y: wy * state.view.scale + state.view.y }; }
function mouseToWorld(e) { const r = canvas.getBoundingClientRect(); return screenToWorld(e.clientX - r.left, e.clientY - r.top); }
function mouseToScreen(e) { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }

// ─── Drawing ───────────────────────────────────────────────────────────

const GRID_SIZE = 40, NODE_RADIUS = 14, JUNCTION_RADIUS = 4;

function nodeRadius(n) { return n.type === 'junction' ? JUNCTION_RADIUS : NODE_RADIUS; }
function isSelected(n) { return state.selectedNodeIds.has(n.id); }

function drawGrid() {
  const v = state.view;
  const tl = screenToWorld(0, 0), br = screenToWorld(window.innerWidth, window.innerHeight);
  ctx.strokeStyle = '#ddd8ce'; ctx.lineWidth = 1;
  for (let wx = Math.floor(tl.x / GRID_SIZE) * GRID_SIZE; wx <= br.x; wx += GRID_SIZE) {
    const sx = wx * v.scale + v.x;
    ctx.beginPath(); ctx.moveTo(sx, 0); ctx.lineTo(sx, window.innerHeight); ctx.stroke();
  }
  for (let wy = Math.floor(tl.y / GRID_SIZE) * GRID_SIZE; wy <= br.y; wy += GRID_SIZE) {
    const sy = wy * v.scale + v.y;
    ctx.beginPath(); ctx.moveTo(0, sy); ctx.lineTo(window.innerWidth, sy); ctx.stroke();
  }
}

function drawConnections() {
  for (const c of state.connections) {
    const s = state.nodes.find(n => n.id === c.sourceId);
    const t = state.nodes.find(n => n.id === c.targetId);
    if (!s || !t) continue;
    const p = worldToScreen(s.x, s.y), q = worldToScreen(t.x, t.y);
    
    const sameNet = state.networks && state.networks.some(net => net.nodeIds.has(s.id) && net.nodeIds.has(t.id));

    // Tripped line — dashed grey, skip color/progress
    if (c.tripped) {
      const mx = (p.x + q.x) / 2, my = (p.y + q.y) / 2;
      ctx.beginPath();
      ctx.strokeStyle = '#999';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([6, 4]);
      ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y); ctx.stroke();
      ctx.setLineDash([]);
      // Dashed "X" mark at midpoint
      const siz = 4 * state.view.scale;
      ctx.strokeStyle = '#666'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(mx - siz, my - siz); ctx.lineTo(mx + siz, my + siz); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(mx + siz, my - siz); ctx.lineTo(mx - siz, my + siz); ctx.stroke();
      continue;
    }

    // Color by loading %
    let color = '#7a766e';
    let lineWidth = sameNet ? 2 : 1.5;
    if (sameNet && c.loadingPct !== undefined) {
      if (c.loadingPct > 120) color = '#8b0000';
      else if (c.loadingPct > 100) color = '#c0392b';
      else if (c.loadingPct > 80) color = '#e67e22';
      else if (c.loadingPct > 60) color = '#d4a017';
    } else if (!sameNet) {
      color = '#c0392b';
    }
    
    // Highlight on hover in status mode — thicker but same color
    const isHovered = state.hoverLine && state.hoverLine.conn && state.hoverLine.conn.id === c.id;
    if (isHovered && state.lineMode === 'status') {
      lineWidth = 4;
    }
    
    // Selected connection highlight (overrides hover)
    if (state.selectedConnIds && state.selectedConnIds.has(c.id)) {
      ctx.shadowColor = '#ffd700';
      ctx.shadowBlur = 6;
      lineWidth = 4;
    }
    
    ctx.beginPath();
    ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth;
    if (!sameNet) ctx.setLineDash([4, 4]);
    ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y); ctx.stroke();
    ctx.setLineDash([]);
    ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0;

    // Trip progress bar at midpoint (only overloaded lines)
    if (sameNet && c.loadingPct !== undefined && c.loadingPct > 100 && state.view.scale > 0.5) {
      const mx = (p.x + q.x) / 2, my = (p.y + q.y) / 2;
      const barW = 30 * state.view.scale, barH = 4 * state.view.scale;
      const tripTime = c.tripTimer || 0;
      // Determine max time based on loading
      let maxTime = 10;
      if (c.loadingPct >= 200) maxTime = 0.5;
      else if (c.loadingPct >= 150) maxTime = 2;
      else if (c.loadingPct >= 120) maxTime = 5;
      const pct = Math.min(1, tripTime / maxTime);
      ctx.fillStyle = 'rgba(0,0,0,0.25)';
      ctx.beginPath(); ctx.roundRect(mx - barW / 2, my + 6 * state.view.scale, barW, barH, 2); ctx.fill();
      ctx.fillStyle = pct > 0.8 ? '#c0392b' : '#e67e22';
      ctx.beginPath(); ctx.roundRect(mx - barW / 2, my + 6 * state.view.scale, barW * pct, barH, 2); ctx.fill();
    }
  }
}

function drawNodes() {
  const v = state.view;
  for (const node of state.nodes) {
    const p = worldToScreen(node.x, node.y);
    const baseR = nodeRadius(node), r = baseR * v.scale;
    const sel = isSelected(node), pend = node.id === state.pendingSourceId;

    if (pend) {
      ctx.beginPath(); ctx.arc(p.x, p.y, r + 8, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(122, 158, 192, 0.10)'; ctx.fill();
    }

    let fillColor;
    if (node.type === 'generator') fillColor = node.mode === 'fixed' ? '#8aaa7a' : '#6aaa64';
    else if (node.type === 'storage') fillColor = '#5a8fbb';
    else if (node.type === 'junction') fillColor = '#b0aca2';
    else fillColor = '#ca9440';

    ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fillStyle = fillColor; ctx.fill();
    ctx.strokeStyle = sel || pend ? '#7a9ec0' : '#8a867e';
    ctx.lineWidth = (sel || pend) ? 3 : 1.5; 
    if (node.mode === 'fixed') ctx.setLineDash([3, 3]);
    ctx.stroke();
    ctx.setLineDash([]);

    // Tripped generator or storage: red X overlay
    if (node.tripped && (node.type === 'generator' || node.type === 'storage')) {
      const s = r * 0.6;
      ctx.strokeStyle = '#c0392b'; ctx.lineWidth = 2.5;
      ctx.beginPath(); ctx.moveTo(p.x - s, p.y - s); ctx.lineTo(p.x + s, p.y + s); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(p.x + s, p.y - s); ctx.lineTo(p.x - s, p.y + s); ctx.stroke();
    }

    const ls = Math.max(10, 11 * v.scale);
    ctx.fillStyle = '#6a665e';
    ctx.font = `${ls}px -apple-system, BlinkMacSystemFont, sans-serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';

    let label = node.shortId || (() => {
      const t = node.type === 'generator' ? 'G' : node.type === 'storage' ? 'S' : node.type === 'junction' ? 'J' : 'L';
      return t + (node.label || node.id.slice(-4));
    })();
    if (node.mode === 'fixed') label += ' 🔒';
    ctx.fillText(label, p.x, p.y + r + 4);

    if (node.type !== 'junction' && node.mw !== undefined) {
      const ms = Math.max(9, 10 * v.scale);
      ctx.fillStyle = '#8a867e';
      ctx.font = `${ms}px -apple-system, BlinkMacSystemFont, sans-serif`;
      ctx.textBaseline = 'top';
      if (node.type === 'storage') {
        const mwResp = node.mwResponse || 0;
        const pw = mwResp >= 0 ? '+' : '';
        ctx.fillText(pw + Math.round(mwResp) + ' MW', p.x, p.y + r + 4 + ls + 2);
        ctx.fillText((node.mw || 0).toFixed(2) + ' MWh', p.x, p.y + r + 4 + ls * 2 + 4);
      } else {
        ctx.fillText(Math.round(node.mw) + ' MW', p.x, p.y + r + 4 + ls + 2);
      }
    }
    // Load shedding badge
    if (node.type === 'load' && (node.shedPct || 0) > 0) {
      const ms = Math.max(8, 9 * v.scale);
      ctx.fillStyle = '#e67e22';
      ctx.font = `bold ${ms}px -apple-system, BlinkMacSystemFont, sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
      ctx.fillText('SHD ' + Math.round((node.shedPct || 0) * 100) + '%', p.x, p.y - r - 2);
    }
  }
}

function roundRect(x, y, w, h, r) {
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
}

function drawFrequencyHud() {
  const networks = state.networks && state.networks.length > 0 ? state.networks : [{ id: 'net_0', freq: state.frequency, nodeIds: new Set(state.nodes.map(n => n.id)) }];
  const pad = 14, bw = 170, bh = 48;
  const rx = window.innerWidth - bw - pad;
  let ry = pad;
  
  // Count gens per network for compact label
  for (const net of networks) {
    const netNodes = [...net.nodeIds].map(id => state.nodes.find(n => n.id === id)).filter(Boolean);
    const genCount = netNodes.filter(n => n.type === 'generator').length;
    const loadCount = netNodes.filter(n => n.type === 'load').length;
    const freq = net.freq;
    const dev = freq - 50;
    const label = networks.length > 1
      ? (genCount + loadCount > 0 ? genCount + 'G ' + loadCount + 'L' : net.nodeIds.size + ' nodes')
      : '';

    ctx.fillStyle = 'rgba(240, 236, 228, 0.92)';
    ctx.beginPath(); roundRect(rx, ry, bw, bh, 8); ctx.fill();
    ctx.strokeStyle = '#d6d2c8'; ctx.lineWidth = 1;
    ctx.beginPath(); roundRect(rx, ry, bw, bh, 8); ctx.stroke();

    // Frequency value — colour shifts when deviating
    ctx.fillStyle = Math.abs(dev) > 0.3 ? '#c0392b' : (Math.abs(dev) > 0.1 ? '#d4891a' : '#5a7a5a');
    ctx.font = 'bold 24px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(freq.toFixed(2) + ' Hz', rx + bw / 2, ry + bh / 2 - 4);

    ctx.fillStyle = '#8a867e';
    ctx.font = '10px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.textBaseline = 'top';
    const sign = dev > 0 ? '+' : '';
    ctx.fillText(label || (sign + dev.toFixed(3) + ' Hz deviation'), rx + bw / 2, ry + bh / 2 + 12);

    ry += bh + 4;
  }

  // Wholesale price (SMP) display
  if (state.smp !== null) {
    ctx.fillStyle = 'rgba(240, 236, 228, 0.92)';
    ctx.beginPath(); roundRect(rx, ry, bw, bh, 8); ctx.fill();
    ctx.strokeStyle = '#d6d2c8'; ctx.lineWidth = 1;
    ctx.beginPath(); roundRect(rx, ry, bw, bh, 8); ctx.stroke();
    ctx.fillStyle = '#2c7a2c';
    ctx.font = 'bold 24px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('$' + state.smp.toFixed(1) + '/MWh', rx + bw / 2, ry + bh / 2 - 2);
    ctx.fillStyle = '#8a867e';
    ctx.font = '10px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.textBaseline = 'top';
    ctx.fillText(state.marketLoad.toFixed(0) + ' MW load', rx + bw / 2, ry + bh / 2 + 12);
    ry += bh + 4;
  }
}

function drawPendingLine() {
  if (!state.pendingSourceId || !ptr.mouseWorld) return;
  const src = state.nodes.find(n => n.id === state.pendingSourceId);
  if (!src) return;
  const s = worldToScreen(src.x, src.y), m = worldToScreen(ptr.mouseWorld.x, ptr.mouseWorld.y);
  ctx.beginPath(); ctx.setLineDash([6, 4]);
  ctx.strokeStyle = '#7a9ec0'; ctx.lineWidth = 2;
  ctx.moveTo(s.x, s.y); ctx.lineTo(m.x, m.y); ctx.stroke();
  ctx.setLineDash([]);
}

function drawHoverDot() {
  if (!state.hoverLine) return;
  if (state.lineMode === 'junction') {
    const p = worldToScreen(state.hoverLine.x, state.hoverLine.y);
    const r = JUNCTION_RADIUS * state.view.scale;
    ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(160,156,148,0.4)'; ctx.fill();
    ctx.strokeStyle = 'rgba(160,156,148,0.5)'; ctx.lineWidth = 1.5; ctx.stroke();
  } else {
    // Status mode — show flow info tooltip
    const conn = state.hoverLine.conn;
    const p = worldToScreen(state.hoverLine.x, state.hoverLine.y);
    const flow = conn.mw !== undefined ? Math.abs(conn.mw).toFixed(1) : '?';
    const limit = conn.thermalLimit || 100;
    const pct = conn.loadingPct !== undefined ? conn.loadingPct.toFixed(0) : '?';
    const text = flow + ' / ' + limit + ' MW (' + pct + '%)';
    ctx.font = '11px -apple-system, BlinkMacSystemFont, sans-serif';
    const tw = ctx.measureText(text).width;
    const bx = p.x - tw / 2 - 8, by = p.y - 22;
    ctx.fillStyle = 'rgba(40,40,40,0.85)';
    ctx.beginPath(); ctx.roundRect(bx, by, tw + 16, 20, 4); ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(text, p.x, by + 10);
  }
}

function drawSelectionRect() {
  if (!ptr.isSelecting || !ptr.downScreen || !ptr.mouseScreen) return;
  const x1 = ptr.downScreen.x, y1 = ptr.downScreen.y, x2 = ptr.mouseScreen.x, y2 = ptr.mouseScreen.y;
  const l = Math.min(x1, x2), t = Math.min(y1, y2), w = Math.abs(x2 - x1), h = Math.abs(y2 - y1);
  ctx.beginPath(); ctx.rect(l, t, w, h); ctx.setLineDash([6, 4]);
  ctx.strokeStyle = '#7a9ec0'; ctx.lineWidth = 1.5; ctx.stroke(); ctx.setLineDash([]);
  ctx.fillStyle = 'rgba(122,158,192,0.06)'; ctx.fillRect(l, t, w, h);
}

function drawStrandedIndicators() {
  if (!state.strandedLoadIds || state.strandedLoadIds.size === 0) return;
  const blink = Math.sin(Date.now() / 300) > 0;
  const dpr = window.devicePixelRatio || 1;
  const ww = window.innerWidth, wh = window.innerHeight;
  const pad = 40;

  for (const id of state.strandedLoadIds) {
    const load = state.nodes.find(n => n.id === id);
    if (!load) continue;
    const sp = worldToScreen(load.x, load.y);
    const onScreen = sp.x >= 0 && sp.x <= ww && sp.y >= 0 && sp.y <= wh;

    if (onScreen) {
      // Warning sign at top-right of the node (not on top of it)
      if (blink) {
        ctx.font = '18px -apple-system, BlinkMacSystemFont, sans-serif';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillStyle = '#e74c3c';
        ctx.fillText('⚠', sp.x + 24, sp.y - 20);
      }
    } else {
      // Off-screen: triangle arrow at edge pointing toward node + ⚠
      const angle = Math.atan2(load.y - state.view.y / state.view.scale, load.x - state.view.x / state.view.scale);
      let ex = ww / 2, ey = wh / 2;
      const cosA = Math.cos(angle), sinA = Math.sin(angle);
      const t = Math.min(
        cosA > 0 ? (ww - pad - ex) / cosA : cosA < 0 ? -(ex - pad) / -cosA : Infinity,
        sinA > 0 ? (wh - pad - ey) / sinA : sinA < 0 ? -(ey - pad) / -sinA : Infinity
      );
      if (!isFinite(t)) continue;
      ex += cosA * t; ey += sinA * t;

      // Draw triangle arrowhead pointing toward the node
      const arrowSize = 16;
      const perpX = Math.cos(angle + Math.PI / 2);
      const perpY = Math.sin(angle + Math.PI / 2);
      ctx.fillStyle = '#e74c3c';
      ctx.beginPath();
      // Tip points toward the node; base is behind with two wings
      ctx.moveTo(ex + cosA * arrowSize, ey + sinA * arrowSize);
      ctx.lineTo(ex - cosA * arrowSize * 0.6 + perpX * arrowSize * 0.45, ey - sinA * arrowSize * 0.6 + perpY * arrowSize * 0.45);
      ctx.lineTo(ex - cosA * arrowSize * 0.6 - perpX * arrowSize * 0.45, ey - sinA * arrowSize * 0.6 - perpY * arrowSize * 0.45);
      ctx.closePath();
      ctx.fill();

      // Flashing ⚠ next to the arrow (offset slightly behind and to the side)
      if (blink) {
        ctx.font = '16px -apple-system, BlinkMacSystemFont, sans-serif';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillStyle = '#e74c3c';
        ctx.fillText('⚠', ex - cosA * arrowSize * 2.2 - perpX * 6, ey - sinA * arrowSize * 2.2 - perpY * 6);
      }
    }
  }
}

// ─── Auto-Demand Preview Canvas ────────────────────────────────────────
function drawLoadCurvePreview(canvas, node) {
  if (!canvas || !node) return;
  const w = 320, h = 80;
  const cx = canvas.getContext('2d');
  const pad = { top: 8, bottom: 15, left: 28, right: 8 };
  const pw = w - pad.left - pad.right, ph = h - pad.top - pad.bottom;

  cx.clearRect(0, 0, w, h);
  cx.fillStyle = '#faf7f0';
  cx.fillRect(0, 0, w, h);

  const minMw = node.noiseMin || 100, maxMw = node.noiseMax || 200;
  const range = maxMw - minMw || 1;

  // Draw min/max reference lines
  cx.strokeStyle = '#ddd8ce'; cx.lineWidth = 1; cx.setLineDash([3, 3]);
  cx.beginPath(); cx.moveTo(pad.left, pad.top + ph); cx.lineTo(w - pad.right, pad.top + ph); cx.stroke();
  cx.beginPath(); cx.moveTo(pad.left, pad.top); cx.lineTo(w - pad.right, pad.top); cx.stroke();
  cx.setLineDash([]);

  // Labels
  cx.fillStyle = '#999'; cx.font = '9px -apple-system, sans-serif'; cx.textAlign = 'right';
  cx.textBaseline = 'bottom'; cx.fillText(maxMw + ' MW', pad.left - 2, pad.top + 1);
  cx.textBaseline = 'top'; cx.fillText(minMw + ' MW', pad.left - 2, pad.top + ph - 1);

  // Draw the daily curve (weekday solid, weekend dashed overlay)
  const daySteps = 240; // 24h × 10 samples
  const day = 86400;

  // Weekday curve
  cx.strokeStyle = '#6aaa64'; cx.lineWidth = 2;
  cx.beginPath();
  for (let i = 0; i <= daySteps; i++) {
    const hour = (i / daySteps) * 24;
    const todSec = (hour / 24) * day;
    const mult = demandCurve(todSec);
    const mw = minMw + range * mult;
    const x = pad.left + (i / daySteps) * pw;
    const y = pad.top + ph - ((mw - minMw) / range) * ph;
    i === 0 ? cx.moveTo(x, y) : cx.lineTo(x, y);
  }
  cx.stroke();

  // Weekend curve (dashed overlay)
  cx.strokeStyle = '#4a90d9'; cx.lineWidth = 1.5; cx.setLineDash([4, 4]);
  cx.beginPath();
  for (let i = 0; i <= daySteps; i++) {
    const hour = (i / daySteps) * 24;
    const todSec = (hour / 24) * day + 5 * day;
    const mult = demandCurve(todSec);
    const mw = minMw + range * mult;
    const x = pad.left + (i / daySteps) * pw;
    const y = pad.top + ph - ((mw - minMw) / range) * ph;
    i === 0 ? cx.moveTo(x, y) : cx.lineTo(x, y);
  }
  cx.stroke();
  cx.setLineDash([]);

  // Current position (if simulation is running)
  if (sim.simTime > 0) {
    const patSec = sim.simTime * 720;
    const curHour = (((patSec % day) / day) * 24 + 24) % 24;
    const curMult = demandCurve(patSec);
    const curMw = minMw + range * curMult;
    const cx2 = pad.left + (curHour / 24) * pw;
    const cy = pad.top + ph - ((curMw - minMw) / range) * ph;

    // Vertical line
    cx.strokeStyle = 'rgba(231,76,60,0.5)'; cx.lineWidth = 1;
    cx.beginPath(); cx.moveTo(cx2, pad.top); cx.lineTo(cx2, pad.top + ph); cx.stroke();

    // Dot
    cx.fillStyle = '#e74c3c';
    cx.beginPath(); cx.arc(cx2, cy, 4, 0, Math.PI * 2); cx.fill();

    // Hour label
    cx.fillStyle = '#e74c3c'; cx.font = '9px -apple-system, sans-serif'; cx.textAlign = 'center'; cx.textBaseline = 'top';
    cx.fillText(Math.floor(curHour).toString().padStart(2,'0') + ':00', cx2, pad.top + ph + 2);
  }

  // Hour ticks
  cx.fillStyle = '#bbb'; cx.font = '8px -apple-system, sans-serif'; cx.textAlign = 'center'; cx.textBaseline = 'top';
  for (let h = 0; h <= 24; h += 6) {
    const x = pad.left + (h / 24) * pw;
    cx.fillText(h.toString().padStart(2,'0') + ':00', x, pad.top + ph + 2);
  }
}

function draw() {
  const dpr = window.devicePixelRatio || 1;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
  drawGrid(); drawIslands(); drawConnections(); drawNodes(); drawPendingLine(); drawHoverDot(); drawSelectionRect(); drawStrandedIndicators();

  // Redraw load preview canvases (updates position marker)
  if (sim.simTime > 0) {
    for (const c of document.querySelectorAll('.demand-preview')) {
      const id = c.getAttribute('data-node-id');
      const node = state.nodes.find(n => n.id === id);
      if (node) drawLoadCurvePreview(c, node);
    }
  }
}

// ─── Islands ──────────────────────────────────────────────────────────

function drawIslands() {
  const nets = state.networks || [];
  const isHovered = id => (id === hoveredIslandId && hoveredIslandHeader) || id === selectedNetworkId;

  for (const net of nets) {
    if (!net.valid) continue;
    const bb = net.boundingBox;
    if (!bb || bb.w < 1 || bb.h < 1) continue;

    const tl = worldToScreen(bb.x, bb.y);
    const br = worldToScreen(bb.x + bb.w, bb.y + bb.h);
    const w = br.x - tl.x, h = br.y - tl.y;
    if (br.x < -200 || br.y < -200 || tl.x > window.innerWidth + 200 || tl.y > window.innerHeight + 200) continue;

    const color = net.color || ISLAND_COLORS[0];
    const showFull = isHovered(net.id);
    const headerH = 28;

    if (showFull) {
      // Full bounding box: fill + outline
      ctx.fillStyle = color + '0d';
      ctx.strokeStyle = color + '50';
      ctx.lineWidth = net.id === selectedNetworkId ? 2.5 : 1.5;
      ctx.setLineDash(net.id === selectedNetworkId ? [] : [4, 4]);
      ctx.beginPath(); roundRectCtx(ctx, tl.x, tl.y, w, h, 14); ctx.fill(); ctx.stroke();
      ctx.setLineDash([]);
    }

    // Header bar (always drawn)
    ctx.fillStyle = color + '25';
    ctx.beginPath(); roundRectCtx(ctx, tl.x, tl.y, w, headerH, 14); ctx.fill();

    // Name + frequency label
    const label = (net.id === selectedNetworkId ? '▶ ' : '🏝 ') + (net.customName || net.id);
    const freq = net.freq !== undefined ? net.freq.toFixed(2) : '—';

    // Figure out direction arrow
    let arrow = '';
    if (net.freqPrev !== undefined && net.freq !== undefined) {
      const diff = net.freq - net.freqPrev;
      if (diff > 0.005) arrow = '▲';
      else if (diff < -0.005) arrow = '▼';
      else arrow = '▸';
    }

    const freqLabel = freq + ' Hz ' + arrow;

    ctx.textBaseline = 'middle';

    // Name on left
    ctx.fillStyle = '#444';
    ctx.font = '12px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(label, tl.x + 10, tl.y + headerH / 2);

    // Frequency + arrow on right
    const dev = (net.freq || 50) - 50;
    const freqColor = Math.abs(dev) > 0.3 ? '#c0392b' : (Math.abs(dev) > 0.1 ? '#d4891a' : '#5a7a5a');
    ctx.fillStyle = freqColor;
    ctx.font = 'bold 12px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(freqLabel, tl.x + w - 10, tl.y + headerH / 2);
  }
}

function roundRectCtx(ctx, x, y, w, h, r) {
  if (typeof r === 'object') {
    const { tl, tr, bl, br } = r;
    ctx.moveTo(x + tl, y);
    ctx.lineTo(x + w - tr, y);
    ctx.arcTo(x + w, y, x + w, y + tr, tr);
    ctx.lineTo(x + w, y + h - br);
    ctx.arcTo(x + w, y + h, x + w - br, y + h, br);
    ctx.lineTo(x + bl, y + h);
    ctx.arcTo(x, y + h, x, y + h - bl, bl);
    ctx.lineTo(x, y + tl);
    ctx.arcTo(x, y, x + tl, y, tl);
    return;
  }
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h - r);
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h);
  ctx.arcTo(x, y + h, x, y + h - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
}

// ─── Cursor ────────────────────────────────────────────────────────────

function updateCursor(e) {
  if (state.spaceDown) { canvas.style.cursor = ptr.isPanning ? 'grabbing' : 'grab'; return; }
  if (ptr.isDragging) { canvas.style.cursor = 'move'; return; }
  if (state.hoverLine && state.lineMode === 'status') { canvas.style.cursor = 'pointer'; return; }
  if (e) {
    const hit = hitNode(mouseToWorld(e).x, mouseToWorld(e).y);
    if (hit && isSelected(hit)) { canvas.style.cursor = 'move'; return; }
  }
  canvas.style.cursor = 'crosshair';
}

// ─── Geometry ──────────────────────────────────────────────────────────

function pointToSegmentDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, lenSq = dx * dx + dy * dy;
  if (lenSq === 0) { const ex = px - ax, ey = py - ay; return { dist: Math.sqrt(ex*ex+ey*ey), cx: ax, cy: ay }; }
  let t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx, cy = ay + t * dy;
  const ex = px - cx, ey = py - cy;
  return { dist: Math.sqrt(ex*ex+ey*ey), cx, cy };
}

function findNearestLine(wx, wy, threshold) {
  let best = null, bestDist = threshold;
  for (const conn of state.connections) {
    const src = state.nodes.find(n => n.id === conn.sourceId);
    const tgt = state.nodes.find(n => n.id === conn.targetId);
    if (!src || !tgt) continue;
    const r = pointToSegmentDist(wx, wy, src.x, src.y, tgt.x, tgt.y);
    if (r.dist < bestDist) {
      const dS = Math.sqrt((r.cx - src.x)**2 + (r.cy - src.y)**2);
      const dT = Math.sqrt((r.cx - tgt.x)**2 + (r.cy - tgt.y)**2);
      if (dS > nodeRadius(src) + 4 && dT > nodeRadius(tgt) + 4) { bestDist = r.dist; best = { x: r.cx, y: r.cy, conn }; }
    }
  }
  return best;
}

function hitNode(wx, wy) {
  for (let i = state.nodes.length - 1; i >= 0; i--) {
    const n = state.nodes[i], r = nodeRadius(n) + 4;
    if ((wx - n.x)**2 + (wy - n.y)**2 <= r * r) return n;
  }
  return null;
}

// ─── DC Power Flow Solver ─────────────────────────────────────────────

function solveDCPowerFlow(net) {
  const allNodes = [...net.nodeIds].map(id => state.nodes.find(n => n.id === id)).filter(Boolean);
  if (allNodes.length < 2) return;

  const allConns = state.connections.filter(c =>
    !c.tripped && net.nodeIds.has(c.sourceId) && net.nodeIds.has(c.targetId) && (c.reactance || 0) > 0
  );
  if (allConns.length === 0) return;

  // Build adjacency from active connections to find connected subgraphs
  const adj = {};
  for (const n of allNodes) adj[n.id] = [];
  for (const c of allConns) {
    adj[c.sourceId].push(c.targetId);
    adj[c.targetId].push(c.sourceId);
  }

  // Find connected components within the active graph
  const visited = new Set();
  const components = []; // each: { nodeIds: Set, conns: [] }
  for (const n of allNodes) {
    if (visited.has(n.id)) continue;
    const nodeIds = new Set();
    const queue = [n.id]; visited.add(n.id);
    while (queue.length) {
      const id = queue.shift(); nodeIds.add(id);
      for (const neighbor of (adj[id] || [])) {
        if (!visited.has(neighbor)) { visited.add(neighbor); queue.push(neighbor); }
      }
    }
    const compNodes = allNodes.filter(n => nodeIds.has(n.id));
    const compConns = allConns.filter(c => nodeIds.has(c.sourceId) && nodeIds.has(c.targetId));
    if (compNodes.length >= 2 && compConns.length > 0) components.push({ nodes: compNodes, conns: compConns });
  }

  // Solve each component independently
  for (const comp of components) {
    const { nodes, conns } = comp;
    const nB = nodes.length;
    const busIdx = {};
    nodes.forEach((n, i) => { busIdx[n.id] = i; });

    const B = Array.from({ length: nB }, () => new Float64Array(nB));
    const P = new Float64Array(nB);

    for (const c of conns) {
      const i = busIdx[c.sourceId], j = busIdx[c.targetId];
      const bij = 1 / c.reactance;
      B[i][j] -= bij; B[j][i] -= bij;
      B[i][i] += bij; B[j][j] += bij;
    }

    for (const n of nodes) {
      const idx = busIdx[n.id];
      if (n.tripped) continue;
      if (n.type === 'generator') P[idx] += (n.mw || 0);
      else if (n.type === 'load') P[idx] -= (n.mw || 0);
      else if (n.type === 'storage') P[idx] += (n.mwResponse || 0);
    }

    // If no active supply in this component, zero flows and skip
    const hasActiveInjection = nodes.some(n => !n.tripped && (
      (n.type === 'generator' && (n.mw || 0) > 0) || (n.type === 'storage' && (n.mwResponse || 0) > 0)
    ));
    if (!hasActiveInjection) {
      for (const c of conns) { c.mw = 0; c.loadingPct = 0; }
      continue;
    }

    let slack = nodes.findIndex(n => !n.tripped && n.type === 'generator' && (n.mw || 0) > 0);
    if (slack < 0) slack = nodes.findIndex(n => !n.tripped && n.type === 'storage' && (n.mwResponse || 0) > 0);
    if (slack < 0) slack = 0;

    const map = [];
    for (let i = 0; i < nB; i++) if (i !== slack) map.push(i);
    const m = map.length;
    if (m === 0) continue;

    const Br = Array.from({ length: m }, () => new Float64Array(m));
    const Pr = new Float64Array(m);
    for (let ri = 0; ri < m; ri++) {
      for (let rj = 0; rj < m; rj++) Br[ri][rj] = B[map[ri]][map[rj]];
      Pr[ri] = P[map[ri]];
    }

    for (let col = 0; col < m - 1; col++) {
      let pivot = col;
      for (let r = col + 1; r < m; r++) if (Math.abs(Br[r][col]) > Math.abs(Br[pivot][col])) pivot = r;
      if (Math.abs(Br[pivot][col]) < 1e-12) continue;
      if (pivot !== col) { [Br[col], Br[pivot]] = [Br[pivot], Br[col]]; [Pr[col], Pr[pivot]] = [Pr[pivot], Pr[col]]; }
      for (let r = col + 1; r < m; r++) {
        const f = Br[r][col] / Br[col][col];
        for (let c = col; c < m; c++) Br[r][c] -= f * Br[col][c];
        Pr[r] -= f * Pr[col];
      }
    }

    const theta = new Float64Array(nB);
    for (let i = m - 1; i >= 0; i--) {
      let s = Pr[i];
      for (let j = i + 1; j < m; j++) s -= Br[i][j] * theta[map[j]];
      theta[map[i]] = Br[i][i] !== 0 ? s / Br[i][i] : 0;
    }

    for (const c of conns) {
      const i = busIdx[c.sourceId], j = busIdx[c.targetId];
      const flow = (theta[i] - theta[j]) / c.reactance;
      c.mw = flow;
      c.loadingPct = (c.thermalLimit > 0) ? (Math.abs(flow) / c.thermalLimit) * 100 : 0;
    }

    // Scale flows to match actual slack bus capability (storage/gen may be output-limited)
    const slackNode = nodes[slack];
    let actualSlackMW = 0;
    if (slackNode.type === 'generator') actualSlackMW = slackNode.mw || 0;
    else if (slackNode.type === 'storage') actualSlackMW = slackNode.mwResponse || 0;
    let computedSlackMW = 0;
    for (const c of conns) {
      const si = busIdx[c.sourceId], ti = busIdx[c.targetId];
      if (si === slack) computedSlackMW += c.mw;
      else if (ti === slack) computedSlackMW -= c.mw;
    }
    if (Math.abs(computedSlackMW) > Math.abs(actualSlackMW) + 0.01 && Math.abs(actualSlackMW) > 0.01) {
      const scale = Math.abs(actualSlackMW) / Math.abs(computedSlackMW);
      for (const c of conns) {
        c.mw *= scale;
        c.loadingPct = (c.thermalLimit > 0) ? (Math.abs(c.mw) / c.thermalLimit) * 100 : 0;
      }
    }
  }

  // Any active connection not in a solved component → 0 flow
  for (const c of allConns) {
    if (c.mw === undefined) { c.mw = 0; c.loadingPct = 0; }
  }
}

// ─── Network Detection ────────────────────────────────────────────────

function setsEqual(a, b) {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

function computeBoundingBox(net) {
  const nodes = [...net.nodeIds].map(id => state.nodes.find(n => n.id === id)).filter(Boolean);
  if (nodes.length === 0) return { x: 0, y: 0, w: 0, h: 0 };
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of nodes) {
    if (n.x < minX) minX = n.x;
    if (n.y < minY) minY = n.y;
    if (n.x > maxX) maxX = n.x;
    if (n.y > maxY) maxY = n.y;
  }
  const pad = 60;
  return { x: minX - pad, y: minY - pad, w: (maxX - minX) + pad * 2, h: (maxY - minY) + pad * 2 };
}

function findNetworks() {
  const visited = new Set();
  const components = [];
  const adj = {};
  for (const n of state.nodes) adj[n.id] = [];
  for (const c of state.connections) {
    if (c.tripped) continue;
    if (!adj[c.sourceId]) adj[c.sourceId] = [];
    if (!adj[c.targetId]) adj[c.targetId] = [];
    adj[c.sourceId].push(c.targetId);
    adj[c.targetId].push(c.sourceId);
  }
  for (const n of state.nodes) {
    if (visited.has(n.id)) continue;
    const nodeIds = new Set();
    const queue = [n.id];
    visited.add(n.id);
    while (queue.length) {
      const id = queue.shift();
      nodeIds.add(id);
      for (const neighbor of (adj[id] || [])) {
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          queue.push(neighbor);
        }
      }
    }
    components.push(nodeIds);
  }

  // Reuse old network objects to preserve customName across ticks
  const oldNets = state.networks || [];
  const newNets = [];
  for (const nodeIds of components) {
    const netNodes = [...nodeIds].map(id => state.nodes.find(n => n.id === id)).filter(Boolean);
    const hasGen = netNodes.some(n => n.type === 'generator');
    const hasLoad = netNodes.some(n => n.type === 'load');
    const hasConnection = state.connections.some(c => nodeIds.has(c.sourceId) && nodeIds.has(c.targetId));
    const match = oldNets.find(o => o.nodeIds && setsEqual(o.nodeIds, nodeIds));
    const net = match || { id: 'net_' + newNets.length, freq: 50, color: ISLAND_COLORS[newNets.length % ISLAND_COLORS.length] };
    net.nodeIds = nodeIds;
    net.valid = (hasGen || hasLoad) && hasConnection;
    net.boundingBox = computeBoundingBox(net);
    if (!match) net.customName = null;
    newNets.push(net);
  }
  return newNets;
}

// ─── ID ────────────────────────────────────────────────────────────────

let idCounter = Date.now();
function uid() { return 'n' + (idCounter++).toString(36); }

// ─── Add Node ──────────────────────────────────────────────────────────

function shortId(type) {
  const prefix = { generator: 'G', load: 'L', storage: 'S', junction: 'J' }[type] || 'N';
  const digits = Math.floor(Math.random() * 900) + 100;
  const letter = String.fromCharCode(65 + Math.floor(Math.random() * 26));
  return `${prefix}-${digits}${letter}`;
}

function addNode(type, wx, wy) {
  let node;
  if (type === 'load') {
    node = { id: uid(), type, x: wx, y: wy, shortId: shortId(type), label: '', mw: 10, baseMw: 10, shedPct: 0, noiseEnabled: false, noiseMin: 100, noiseMax: 200, noisePct: 10 };
  } else if (type === 'generator') {
    node = { id: uid(), type, x: wx, y: wy, shortId: shortId(type), label: '', mw: 0, rating: 100, inertia: 5, droop: 0.04, baselineContract: 0, fcrHeadroom: 10, bidPrice: 50, bidQty: 100, mode: 'balancing', turbineTimeConstant: 1, rampDownTC: 0.3, agcOffset: 0, tripped: false, freqTimer: 0 };
  } else if (type === 'storage') {
    node = { id: uid(), type, x: wx, y: wy, shortId: shortId(type), label: '', mw: 50, chargeRate: 500, dischargeRate: 500, maxCapacity: 100, mode: 'balancing', baselineContract: 0, fcrHeadroom: 10, droop: 0.04, fixedTarget: 0, mwResponse: 0, agcOffset: 0, freqRestore: 0, freqTimer: 0 };
  } else {
    node = { id: uid(), type, x: wx, y: wy, shortId: shortId(type), label: '', mw: 0 };
  }
  state.nodes.push(node);
  state.selectedNodeIds = new Set([node.id]); state.selectedConnIds = new Set();
  recomputeNetworks(); persist(); draw();
  return node;
}

// ─── Delete Node ───────────────────────────────────────────────────────

function deleteNode(id) {
  const del = state.nodes.find(n => n.id === id);
  state.nodes = state.nodes.filter(n => n.id !== id);
  state.connections = state.connections.filter(c => c.sourceId !== id && c.targetId !== id);
  state.selectedNodeIds.delete(id);
  if (state.pendingSourceId === id) state.pendingSourceId = null;
  closeSettings(id);
  // Reset frequency if last gen removed
  if (del && del.type === 'generator' && state.nodes.filter(n => n.type === 'generator').length === 0) {
    state.frequency = 50;
  }
  persist(); draw();
}

// ─── Add Connection ────────────────────────────────────────────────────

function addConnection(sourceId, targetId) {
  if (sourceId === targetId) return;
  if (state.connections.some(c => (c.sourceId === sourceId && c.targetId === targetId) || (c.sourceId === targetId && c.targetId === sourceId))) return;
  state.connections.push({ id: uid(), sourceId, targetId, reactance: 0.1, thermalLimit: 100, tripped: false, tripTimer: 0 });
  state.pendingSourceId = null;
  recomputeNetworks(); persist(); draw();
}

// ─── Split Connection ──────────────────────────────────────────────────

function splitConnection(conn, wx, wy) {
  const j = { id: uid(), type: 'junction', x: wx, y: wy, shortId: shortId('junction'), label: '', mw: 0 };
  state.nodes.push(j);
  state.connections = state.connections.filter(c => c !== conn);
  const halfX = (conn.reactance || 0.1) / 2;
  state.connections.push(
    { id: uid(), sourceId: conn.sourceId, targetId: j.id, reactance: halfX, thermalLimit: conn.thermalLimit || 100, tripped: false, tripTimer: 0 },
    { id: uid(), sourceId: j.id, targetId: conn.targetId, reactance: halfX, thermalLimit: conn.thermalLimit || 100, tripped: false, tripTimer: 0 }
  );
  state.selectedNodeIds = new Set([j.id]); state.selectedConnIds = new Set();
  recomputeNetworks(); persist(); draw();
}

// ─── Marquee ───────────────────────────────────────────────────────────

function computeMarqueeSelection(w1, w2) {
  const x1 = Math.min(w1.x, w2.x), y1 = Math.min(w1.y, w2.y), x2 = Math.max(w1.x, w2.x), y2 = Math.max(w1.y, w2.y);
  const nodeIds = new Set();
  for (const n of state.nodes) if (n.x >= x1 && n.x <= x2 && n.y >= y1 && n.y <= y2) nodeIds.add(n.id);
  const connIds = new Set();
  for (const c of state.connections) {
    const s = state.nodes.find(n => n.id === c.sourceId);
    const t = state.nodes.find(n => n.id === c.targetId);
    if (s && t && s.x >= x1 && s.x <= x2 && s.y >= y1 && s.y <= y2 && t.x >= x1 && t.x <= x2 && t.y >= y1 && t.y <= y2) connIds.add(c.id);
  }
  return { nodeIds, connIds };
}

// ─── Persistence ───────────────────────────────────────────────────────

async function persist() {
  try { await fetch('/api/grid', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nodes: state.nodes, connections: state.connections, view: state.view }) }); }
  catch (e) { console.error('Persist failed:', e); }
}

async function load() {
  try {
    const res = await fetch('/api/grid');
    const data = await res.json();
    state.nodes = data.nodes || [];
    state.connections = data.connections || [];
    if (data.view) state.view = data.view;
    state.selectedNodeIds = new Set(); state.selectedConnIds = new Set();
    sim.dataBuffer = []; sim.events = []; sim.captureAccum = 0; sim.simTime = 0;
    state.frequency = 50;
    // Migrate legacy connections (add id, reactance, thermalLimit, trip fields)
    for (const c of state.connections) {
      if (!c.id) c.id = uid();
      if (c.reactance === undefined) c.reactance = 0.1;
      if (c.thermalLimit === undefined) c.thermalLimit = 100;
      if (c.tripped === undefined) c.tripped = false;
      if (c.tripTimer === undefined) c.tripTimer = 0;
    }
    for (const n of state.nodes) {
      if (n.mw === undefined) n.mw = 0;
      if (n.type === 'load' && n.mw === 0) n.mw = 10;
      if (n.type === 'generator') {
        if (n.dispatchTarget !== undefined) { n.baselineContract = n.dispatchTarget; delete n.dispatchTarget; }
        if (n._baseSetpoint !== undefined) delete n._baseSetpoint;
        if (n.rampRate !== undefined) delete n.rampRate;
        if (n.baselineContract === undefined) n.baselineContract = 0;
        if (n.fcrHeadroom === undefined) n.fcrHeadroom = 10;
        if (n.bidPrice === undefined) n.bidPrice = 50;
        if (n.bidQty === undefined) n.bidQty = n.rating || 100;
        if (n.agcOffset === undefined) n.agcOffset = 0;
        if (n.rating === undefined) n.rating = 100;
        if (n.inertia === undefined) n.inertia = 5;
        if (n.droop === undefined) n.droop = 0.04;
        if (n.turbineTimeConstant === undefined) n.turbineTimeConstant = 1;
        if (n.rampDownTC === undefined) n.rampDownTC = 0.3;
        if (n.tripped === undefined) n.tripped = false;
        if (n.freqTimer === undefined) n.freqTimer = 0;
        // Migrate legacy merchantLock → mode
        if (n.merchantLock !== undefined) { n.mode = n.merchantLock ? 'merchant' : 'balancing'; delete n.merchantLock; }
        if (n.mode === undefined) n.mode = 'balancing';
        // Assign shortId if missing (legacy grid or freshly added)
        if (!n.shortId) n.shortId = shortId(n.type);
      }
      if (n.type === 'load') {
        if (n.baseMw === undefined) n.baseMw = n.mw || 10;
        if (n.shedPct === undefined) n.shedPct = 0;
        if (n.noiseEnabled === undefined) n.noiseEnabled = false;
        if (n.noiseMin === undefined) n.noiseMin = 100;
        if (n.noiseMax === undefined) n.noiseMax = 200;
        if (n.noisePct === undefined) n.noisePct = 10;
      }
      if (n.type === 'storage') {
        if (n.chargeRate === undefined) n.chargeRate = 500;
        if (n.dischargeRate === undefined) n.dischargeRate = 500;
        if (n.maxCapacity === undefined) n.maxCapacity = 100;
        if (n.baselineContract === undefined) n.baselineContract = 0;
        if (n.agcOffset === undefined) n.agcOffset = 0;
        if (n.mode === undefined) n.mode = 'balancing';
        if (n.fcrHeadroom === undefined) n.fcrHeadroom = 10;
        if (n.droop === undefined) n.droop = 0.04;
        if (n.fixedTarget === undefined) n.fixedTarget = 0;
        // Assign shortId if missing
        if (!n.shortId) n.shortId = shortId(n.type);
      }
    }
  } catch (e) { console.error('Load failed:', e); }
  recomputeNetworks();
}

// ─── Context Menu ──────────────────────────────────────────────────────

function hitIsland(wx, wy) {
  const nets = state.networks || [];
  // Check from top (last drawn) to bottom
  for (let i = nets.length - 1; i >= 0; i--) {
    if (!nets[i].valid) continue;
    const bb = nets[i].boundingBox;
    if (!bb) continue;
    const headerH = 30;
    // Check if inside header
    if (wx >= bb.x && wx <= bb.x + bb.w && wy >= bb.y && wy <= bb.y + headerH) {
      return { net: nets[i], isHeader: true };
    }
    // Check if inside body
    if (wx >= bb.x && wx <= bb.x + bb.w && wy >= bb.y && wy <= bb.y + bb.h) {
      return { net: nets[i], isHeader: false };
    }
  }
  return null;
}

function showMenu(e, nodeHit, simple) {
  e.preventDefault();
  const world = mouseToWorld(e);
  menu.dataset.wx = world.x; menu.dataset.wy = world.y;
  menu.dataset.nodeId = nodeHit ? nodeHit.id : '';
  menu.dataset.connId = '';
  menuItems.innerHTML = '';

  const lineHit = (!nodeHit) ? findNearestLine(world.x, world.y, 15 / state.view.scale) : null;
  const islandHit = (nodeHit || lineHit) ? null : hitIsland(world.x, world.y);

  if (nodeHit && nodeHit.type !== 'junction') {
    if (simple) {
      addMenuItem('New connection', 'new-connection');
      addMenuSeparator();
      addMenuItem('Delete', 'delete-node');
    } else {
      addMenuItem('Open settings', 'open-settings');
      addMenuSeparator();
      addMenuItem('Delete', 'delete-node');
    }
  } else if (nodeHit) {
    addMenuItem('Delete', 'delete-node');
  } else if (lineHit) {
    menu.dataset.connId = lineHit.conn.id;
    addMenuItem('Line settings', 'line-settings');
    addMenuSeparator();
    addMenuItem('Delete line', 'delete-line');
  } else if (islandHit) {
    menu.dataset.netId = islandHit.net.id;
    addMenuItem('+ Generator', 'add-generator');
    addMenuItem('+ Load', 'add-load');
    addMenuItem('+ Storage', 'add-storage');
    addMenuSeparator();
    addMenuItem('+ Junction', 'add-junction');
    addMenuSeparator();
    addMenuItem('Rename island', 'rename-island');
  } else {
    addMenuItem('+ Generator', 'add-generator');
    addMenuItem('+ Load', 'add-load');
    addMenuItem('+ Storage', 'add-storage');
    addMenuSeparator();
    addMenuItem('+ Junction', 'add-junction');
  }

  const h = menuItems.children.length * 36 + 8;
  let mx = e.clientX, my = e.clientY;
  if (mx + 160 > window.innerWidth) mx = window.innerWidth - 168;
  if (my + h > window.innerHeight) my = window.innerHeight - h - 8;
  menu.style.left = mx + 'px'; menu.style.top = my + 'px';
  menu.classList.remove('hidden');
}

function addMenuItem(text, action) { const d = document.createElement('div'); d.className = 'context-menu-item'; d.dataset.action = action; d.textContent = text; menuItems.appendChild(d); }
function addMenuSeparator() { const d = document.createElement('div'); d.className = 'context-menu-separator'; menuItems.appendChild(d); }
function hideMenu() { menu.classList.add('hidden'); }

// ─── Events ────────────────────────────────────────────────────────────

document.addEventListener('contextmenu', (e) => { e.preventDefault(); });

document.addEventListener('keydown', (e) => {
  if (e.key === ' ' || e.code === 'Space') { e.preventDefault(); if (!state.spaceDown) { state.spaceDown = true; updateCursor(); } }
});
document.addEventListener('keyup', (e) => {
  if (e.key === ' ' || e.code === 'Space') { e.preventDefault(); state.spaceDown = false; updateCursor(); }
});

canvas.addEventListener('mousedown', (e) => {
  if (e.button === 2) {
    hideMenu();
    const world = mouseToWorld(e), hit = hitNode(world.x, world.y);
    ptr.downWorld = world;
    ptr.downScreen = mouseToScreen(e);
    ptr.downTime = Date.now();
    ptr.rightButton = true;
    ptr.isPanning = false;
    ptr.isDragging = false;
    ptr.moved = false;
    ptr._panOffsetX = e.clientX - state.view.x;
    ptr._panOffsetY = e.clientY - state.view.y;
    ptr.downNodeId = hit ? hit.id : null;
    ptr.downNodeType = hit ? hit.type : null;
    return;
  }
  if (e.button !== 0) return;
  hideMenu();
  const world = mouseToWorld(e), screen = mouseToScreen(e), hit = hitNode(world.x, world.y);

  // Check island header hit for dragging
  const islandHit = hit ? null : hitIsland(world.x, world.y);
  if (islandHit && islandHit.isHeader) {
    const net = islandHit.net;
    const origPositions = [...net.nodeIds].map(id => {
      const n = state.nodes.find(nd => nd.id === id);
      return n ? { id: n.id, x: n.x, y: n.y } : null;
    }).filter(Boolean);
    islandDrag = { netId: net.id, startWorld: { x: world.x, y: world.y }, origPositions };
    selectedNetworkId = net.id;
    if (statsPanelVisible) updateStatsPanel();
    draw();
    return;
  }

  ptr.downWorld = world; ptr.downScreen = screen; ptr.downTime = Date.now();
  ptr.downNodeId = hit ? hit.id : null;
  ptr.isDragging = false; ptr.isPanning = false; ptr.isSelecting = false; ptr.moved = false;
  ptr.rightButton = false;
  if (hit) {
    if (e.ctrlKey || e.metaKey) {
      if (isSelected(hit)) state.selectedNodeIds.delete(hit.id);
      else state.selectedNodeIds.add(hit.id);
      state.selectedConnIds = new Set();
    } else if (!isSelected(hit)) {
      state.selectedNodeIds = new Set([hit.id]);
      state.selectedConnIds = new Set();
    }
    draw();
  }
});

canvas.addEventListener('mousemove', (e) => {
  const world = mouseToWorld(e), screen = mouseToScreen(e);
  ptr.mouseWorld = world; ptr.mouseScreen = screen;

  // Island header drag
  if (islandDrag) {
    const dx = world.x - islandDrag.startWorld.x;
    const dy = world.y - islandDrag.startWorld.y;
    for (const p of islandDrag.origPositions) {
      const n = state.nodes.find(nd => nd.id === p.id);
      if (n) { n.x = p.x + dx; n.y = p.y + dy; }
    }
    // Recompute bounding box so the box follows in real-time
    const draggedNet = state.networks.find(n => n.id === islandDrag.netId);
    if (draggedNet) draggedNet.boundingBox = computeBoundingBox(draggedNet);
    draw(); return;
  }

  // Right-button panning
  if (ptr.rightButton && ptr.downWorld) {
    const d = Math.sqrt(((world.x - ptr.downWorld.x) * state.view.scale)**2 + ((world.y - ptr.downWorld.y) * state.view.scale)**2);
    if (d > DRAG_THRESHOLD) {
      ptr.moved = true;
      ptr.isPanning = true;
      canvas.style.cursor = 'grabbing';
      state.view.x = e.clientX - ptr._panOffsetX;
      state.view.y = e.clientY - ptr._panOffsetY;
      state.hoverLine = null;
      draw();
      return;
    }
  }

  if (ptr.isDragging) {
    const dx = world.x - ptr.downWorld.x, dy = world.y - ptr.downWorld.y;
    for (const id of state.selectedNodeIds) { const n = state.nodes.find(n => n.id === id); if (n) { n.x += dx; n.y += dy; } }
    ptr.downWorld = { x: world.x, y: world.y }; state.hoverLine = null; draw(); updateCursor(e); return;
  }
  if (ptr.isPanning) {
    state.view.x = e.clientX - ptr._panOffsetX; state.view.y = e.clientY - ptr._panOffsetY;
    state.hoverLine = null; draw(); return;
  }

  if (ptr.downWorld && !ptr.rightButton) {
    const d = Math.sqrt(((world.x - ptr.downWorld.x) * state.view.scale)**2 + ((world.y - ptr.downWorld.y) * state.view.scale)**2);
    if (d > DRAG_THRESHOLD) {
      ptr.moved = true;
      if (state.spaceDown) { ptr.isPanning = true; ptr._panOffsetX = e.clientX - state.view.x; ptr._panOffsetY = e.clientY - state.view.y; canvas.style.cursor = 'grabbing'; draw(); return; }
      if (ptr.downNodeId) { ptr.isDragging = true; canvas.style.cursor = 'move'; draw(); return; }
      ptr.isSelecting = true; draw(); return;
    }
  }

  // Detect island hover
  const islandHit = hitIsland(world.x, world.y);
  hoveredIslandId = islandHit ? islandHit.net.id : null;
  hoveredIslandHeader = islandHit ? islandHit.isHeader : false;

  state.hoverLine = findNearestLine(world.x, world.y, 15 / state.view.scale);
  draw(); updateCursor(e);
});

canvas.addEventListener('mouseup', (e) => {
  // Right-button release
  if (e.button === 2) {
    if (ptr.isPanning) {
      ptr.isPanning = false;
      ptr.rightButton = false;
      ptr.downWorld = null;
      canvas.style.cursor = 'default';
      draw();
      updateCursor(e);
      return;
    }
    ptr.rightButton = false;
    // No movement → show context menu
    const cw = mouseToWorld(e), hit = hitNode(cw.x, cw.y);
    if (hit && hit.type !== 'junction') {
      showMenu(e, hit, true);
    } else if (hit) {
      showMenu(e, hit, false);
    } else {
      const lineHit = findNearestLine(cw.x, cw.y, 15 / state.view.scale);
      if (lineHit) {
        showMenu(e, null, false); // shows line menu
      } else {
        showMenu(e, null, false); // shows add-node menu
      }
    }
    ptr.downWorld = null;
    return;
  }
  if (e.button !== 0) return;
  if (islandDrag) {
    islandDrag = null;
    recomputeNetworks(); persist(); draw(); return;
  }
  if (ptr.isDragging) { ptr.isDragging = false; ptr.downNodeId = null; ptr.downWorld = null; persist(); draw(); updateCursor(e); return; }
  if (ptr.isPanning) { ptr.isPanning = false; ptr.downWorld = null; draw(); updateCursor(e); return; }
  if (ptr.isSelecting) {
    ptr.isSelecting = false;
    const marquee = computeMarqueeSelection(screenToWorld(ptr.downScreen.x, ptr.downScreen.y), screenToWorld(ptr.mouseScreen.x, ptr.mouseScreen.y));
    state.selectedNodeIds = marquee.nodeIds;
    state.selectedConnIds = marquee.connIds;
    ptr.downWorld = null; draw(); updateCursor(e); return;
  }

  ptr.downWorld = null;
  const cw = mouseToWorld(e), hit = hitNode(cw.x, cw.y), now = Date.now();
  const dbl = hit && hit.id === ptr.lastClickNodeId && (now - ptr.lastClickTime) < 400;
  ptr.lastClickTime = now; ptr.lastClickNodeId = hit ? hit.id : null;
  if (dbl) { onDoubleClickNode(hit); return; }

  const hover = state.hoverLine && findNearestLine(cw.x, cw.y, 15 / state.view.scale);
  if (hover) {
    state.hoverLine = hover;
    if (state.lineMode === 'status') {
      // Toggle line selection
      if (e.ctrlKey || e.metaKey || e.shiftKey) {
        if (state.selectedConnIds.has(hover.conn.id)) state.selectedConnIds.delete(hover.conn.id);
        else state.selectedConnIds.add(hover.conn.id);
      } else {
        state.selectedConnIds = new Set([hover.conn.id]);
        state.selectedNodeIds = new Set();
      }
      state.hoverLine = null; draw(); return;
    } else {
      splitConnection(hover.conn, hover.x, hover.y); state.hoverLine = null; return;
    }
  }
  if (!hit) { state.pendingSourceId = null; if (!e.ctrlKey && !e.metaKey) { state.selectedNodeIds = new Set(); state.selectedConnIds = new Set(); } draw(); return; }
  if (state.pendingSourceId) { addConnection(state.pendingSourceId, hit.id); return; }
  if (e.ctrlKey || e.metaKey) {
    if (state.selectedNodeIds.has(hit.id)) state.selectedNodeIds.delete(hit.id);
    else state.selectedNodeIds.add(hit.id);
    state.selectedConnIds = new Set();
  } else {
    state.selectedNodeIds = new Set([hit.id]);
    state.selectedConnIds = new Set();
  }
  draw();
});

function onDoubleClickNode(hit) {
  if (hit.type === 'junction') {
    // Junction: toggle pending connection (old behavior)
    if (state.pendingSourceId === hit.id) { state.pendingSourceId = null; state.selectedNodeIds = new Set(); }
    else { state.pendingSourceId = hit.id; state.selectedNodeIds = new Set([hit.id]); }
    state.selectedConnIds = new Set();
    draw();
  } else {
    // Gen/load/storage: open settings panel
    openSettings(hit.id);
  }
}

canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const r = canvas.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top;
  const w = screenToWorld(mx, my), f = e.deltaY < 0 ? 1.08 : 1 / 1.08;
  const ns = Math.max(0.1, Math.min(10, state.view.scale * f));
  state.view.x = mx - w.x * ns; state.view.y = my - w.y * ns; state.view.scale = ns;
  draw();
}, { passive: false });

canvas.addEventListener('mouseleave', () => {
  hoveredIslandId = null;
  hoveredIslandHeader = false;
  draw();
});

menu.addEventListener('click', (e) => {
  const item = e.target.closest('.context-menu-item');
  if (!item) return;
  const a = item.dataset.action, wx = parseFloat(menu.dataset.wx), wy = parseFloat(menu.dataset.wy), id = menu.dataset.nodeId;
  const netId = menu.dataset.netId;
  const connId = menu.dataset.connId;
  if (a === 'new-connection' && id) {
    state.pendingSourceId = id;
    state.selectedNodeIds = new Set([id]);
    state.selectedConnIds = new Set();
    draw();
  } else if (a === 'add-generator') addNode('generator', wx, wy);
  else if (a === 'add-load') addNode('load', wx, wy);
  else if (a === 'add-storage') addNode('storage', wx, wy);
  else if (a === 'add-junction') addNode('junction', wx, wy);
  else if (a === 'open-settings') openSettings(id);
  else if (a === 'delete-node' && id) deleteNode(id);
  else if (a === 'delete-line' && connId) {
    state.connections = state.connections.filter(c => c.id !== connId);
    recomputeNetworks(); persist(); draw();
  } else if (a === 'line-settings' && connId) {
    openLineSettings(connId);
  } else if (a === 'rename-island' && netId) {
    const net = (state.networks || []).find(n => n.id === netId);
    if (net) {
      const name = prompt('Rename island:', net.customName || net.id);
      if (name && name.trim()) { net.customName = name.trim(); persist(); draw(); }
    }
  }
  hideMenu();
});

document.addEventListener('click', (e) => { if (!menu.contains(e.target)) hideMenu(); });

document.addEventListener('keydown', (e) => {
  const meta = e.ctrlKey || e.metaKey;

  if (e.key === 'Escape') { islandDrag = null; state.pendingSourceId = null; state.selectedNodeIds = new Set(); state.selectedConnIds = new Set(); state.hoverLine = null; hideMenu(); draw(); }

  if (e.key === 'j' || e.key === 'J') {
    state.lineMode = state.lineMode === 'junction' ? 'status' : 'junction';
    draw();
  }

  // Ctrl+C — Copy selected connections (only when no nodes selected)
  if (meta && e.key === 'c' && state.selectedConnIds.size > 0 && state.selectedNodeIds.size === 0) {
    e.preventDefault();
    const copied = state.connections.filter(c => state.selectedConnIds.has(c.id)).map(c => ({ ...c }));
    state.clipboard = { connections: copied };
    state.lineClipboard = copied[0] ? { reactance: copied[0].reactance, thermalLimit: copied[0].thermalLimit } : null;
    return;
  }

  // Ctrl+C — Copy selected nodes
  if (meta && e.key === 'c' && state.selectedNodeIds.size > 0) {
    e.preventDefault();
    const ids = state.selectedNodeIds;
    const copiedNodes = state.nodes.filter(n => ids.has(n.id)).map(n => ({ ...n }));
    const copiedIds = new Set(copiedNodes.map(n => n.id));
    const copiedConns = state.connections.filter(c => copiedIds.has(c.sourceId) && copiedIds.has(c.targetId)).map(c => ({ ...c }));
    state.clipboard = { nodes: copiedNodes, connections: copiedConns };
    state.lineClipboard = copiedConns[0] ? { reactance: copiedConns[0].reactance, thermalLimit: copiedConns[0].thermalLimit } : null;
    return;
  }

  // Ctrl+V — Paste copied nodes (duplicate them at offset)
  if (meta && !e.shiftKey && e.key === 'v' && state.clipboard && state.clipboard.nodes && state.clipboard.nodes.length > 0) {
    e.preventDefault();
    const offset = 40;
    const idMap = {};
    const newNodes = [];
    for (const n of state.clipboard.nodes) {
      const newId = uid();
      idMap[n.id] = newId;
      const newNode = JSON.parse(JSON.stringify(n));
      newNode.id = newId;
      newNode.x = n.x + offset;
      newNode.y = n.y + offset;
      newNode.shortId = shortId(n.type);
      newNode.label = '';
      newNodes.push(newNode);
    }
    state.nodes.push(...newNodes);
    for (const c of (state.clipboard.connections || [])) {
      if (idMap[c.sourceId] && idMap[c.targetId]) {
        state.connections.push({
          id: uid(),
          sourceId: idMap[c.sourceId],
          targetId: idMap[c.targetId],
          reactance: c.reactance,
          thermalLimit: c.thermalLimit,
          tripped: false,
          tripTimer: 0
        });
      }
    }
    state.selectedNodeIds = new Set(newNodes.map(n => n.id));
    state.selectedConnIds = new Set();
    recomputeNetworks();
    persist();
    draw();
    return;
  }

  // Ctrl+V — Paste connection between 2 selected nodes
  if (meta && !e.shiftKey && e.key === 'v' && state.lineClipboard && state.selectedNodeIds.size === 2) {
    e.preventDefault();
    const ids = [...state.selectedNodeIds];
    if (!state.connections.some(c => (c.sourceId === ids[0] && c.targetId === ids[1]) || (c.sourceId === ids[1] && c.targetId === ids[0]))) {
      state.connections.push({ id: uid(), sourceId: ids[0], targetId: ids[1], reactance: state.lineClipboard.reactance, thermalLimit: state.lineClipboard.thermalLimit, tripped: false, tripTimer: 0 });
      recomputeNetworks(); persist(); draw();
    }
    return;
  }

  // Ctrl+Shift+V — Paste settings onto selected connections
  if (meta && e.shiftKey && e.key === 'V' && state.lineClipboard && state.selectedConnIds.size > 0) {
    e.preventDefault();
    for (const c of state.connections) {
      if (state.selectedConnIds.has(c.id)) {
        c.reactance = state.lineClipboard.reactance;
        c.thermalLimit = state.lineClipboard.thermalLimit;
      }
    }
    persist(); draw();
    return;
  }

  // Ctrl+Shift+V — Paste properties onto matching selected nodes
  if (meta && e.shiftKey && e.key === 'V' && state.clipboard && state.clipboard.nodes && state.clipboard.nodes.length === 1 && state.selectedNodeIds.size > 0) {
    e.preventDefault();
    const src = state.clipboard.nodes[0];
    const targets = state.nodes.filter(n => state.selectedNodeIds.has(n.id) && n.type === src.type && n.id !== src.id);
    for (const t of targets) {
      if (src.type === 'generator') {
        t.rating = src.rating; t.inertia = src.inertia; t.droop = src.droop;
        t.fcrHeadroom = src.fcrHeadroom; t.bidPrice = src.bidPrice; t.bidQty = src.bidQty;
        t.mode = src.mode; t.turbineTimeConstant = src.turbineTimeConstant; t.rampDownTC = src.rampDownTC;
        t.baselineContract = src.baselineContract;
      } else if (src.type === 'storage') {
        t.chargeRate = src.chargeRate; t.dischargeRate = src.dischargeRate;
        t.maxCapacity = src.maxCapacity; t.mode = src.mode;
        t.fcrHeadroom = src.fcrHeadroom; t.droop = src.droop; t.fixedTarget = src.fixedTarget;
      } else if (src.type === 'load') {
        t.mw = src.mw;
        t.baseMw = src.mw || 10;
        t.shedPct = 0;
      }
    }
    if (targets.length > 0) persist();
    draw();
    return;
  }

  // Ctrl+V — Paste nodes from clipboard
  if (meta && !e.shiftKey && e.key === 'v' && state.clipboard && state.clipboard.nodes.length > 0) {
    e.preventDefault();
    const idMap = {};
    const pasted = [];
    for (const n of state.clipboard.nodes) {
      const oldId = n.id;
      const newId = uid();
      idMap[oldId] = newId;
      const offset = 30;
      const fresh = { ...n, id: newId, x: n.x + offset, y: n.y + offset, shortId: shortId(n.type), label: '' };
      if (fresh.type === 'generator') { fresh.tripped = false; fresh.freqTimer = 0; }
      if (fresh.type === 'load') { fresh.shedPct = 0; fresh.baseMw = fresh.mw || 10; }
      if (fresh.type === 'storage') { fresh.mwResponse = 0; fresh.agcOffset = 0; }
      pasted.push(fresh);
    }
    state.nodes.push(...pasted);
    for (const c of state.clipboard.connections) {
      state.connections.push({ id: uid(), sourceId: idMap[c.sourceId], targetId: idMap[c.targetId], reactance: c.reactance || 0.1, thermalLimit: c.thermalLimit || 100, tripped: false, tripTimer: 0 });
    }
    state.selectedNodeIds = new Set(pasted.map(n => n.id)); state.selectedConnIds = new Set();
    persist(); draw();
    return;
  }

  if ((e.key === 'Backspace' || e.key === 'Delete') && state.selectedConnIds.size > 0) {
    e.preventDefault();
    state.connections = state.connections.filter(c => !state.selectedConnIds.has(c.id));
    state.selectedConnIds = new Set();
    recomputeNetworks(); persist(); draw();
    return;
  }

  if ((e.key === 'Backspace' || e.key === 'Delete') && state.selectedNodeIds.size > 0) {
    const hadGen = [...state.selectedNodeIds].some(id => state.nodes.find(n => n.id === id)?.type === 'generator');
    for (const id of [...state.selectedNodeIds]) {
      state.nodes = state.nodes.filter(n => n.id !== id);
      state.connections = state.connections.filter(c => c.sourceId !== id && c.targetId !== id);
      if (state.pendingSourceId === id) state.pendingSourceId = null;
      closeSettings(id);
    }
    state.selectedNodeIds = new Set(); state.selectedConnIds = new Set();
    if (hadGen && state.nodes.filter(n => n.type === 'generator').length === 0) state.frequency = 50;
    recomputeNetworks(); persist(); draw();
  }
});

// ─── Settings Panels ───────────────────────────────────────────────────

function openSettings(nodeId) {
  const node = state.nodes.find(n => n.id === nodeId);
  if (!node || node.type === 'junction') return;
  if (openPanels[nodeId]) { openPanels[nodeId].panel.style.zIndex = Date.now(); return; }

  const panel = document.createElement('div');
  panel.className = 'settings-panel'; panel.dataset.nodeId = nodeId; panel.style.zIndex = Date.now();
  const tag = node.label || node.shortId || node.id.slice(-4);
  const entry = { panel };

  if (node.type === 'generator') {
    panel.innerHTML = `
      <div class="settings-header"><span class="settings-title">Generator ${tag}</span><span class="settings-close" data-action="close-settings">&times;</span></div>
      <div class="settings-body">
        <div class="settings-row"><label class="settings-label">Dispatched MW</label>
          <div class="settings-slider-group">
            <input type="range" class="baseline-slider" min="0" max="${node.rating || 100}" value="${node.baselineContract || 0}">
            <span class="baseline-value">${Math.round(node.baselineContract || 0)} MW</span>
          </div>
        </div>
        <div class="settings-row"><label class="settings-label">Output</label>
          <div class="settings-slider-group" style="justify-content:flex-end;"><span class="gen-output" style="font-size:14px;font-weight:600;">${Math.round(node.mw || 0)} MW</span></div>
        </div>
        <div class="settings-row market-row" style="${node.mode === 'fixed' ? 'display:none;' : ''}"><label class="settings-label">Bid Price</label>
          <div class="settings-slider-group">
            <input type="range" class="bid-price-slider" min="0" max="500" step="0.5" value="${node.bidPrice || 50}">
            <span class="bid-price-value">$${(node.bidPrice || 50).toFixed(1)}/MWh</span>
          </div>
        </div>
        <div class="settings-row market-row" style="${node.mode === 'fixed' ? 'display:none;' : ''}"><label class="settings-label">Bid Qty</label>
          <div class="settings-slider-group">
            <input type="range" class="bid-qty-slider" min="0" max="${node.rating || 100}" value="${node.bidQty || node.rating || 100}">
            <span class="bid-qty-value">${Math.round(node.bidQty || node.rating || 100)} MWh</span>
          </div>
        </div>
        <div class="settings-row"><label class="settings-label">FCR Headroom</label>
          <div class="settings-slider-group">
            <input type="range" class="fcr-headroom-slider" min="0" max="${node.rating || 100}" value="${node.fcrHeadroom || 10}">
            <span class="fcr-headroom-value">${Math.round(node.fcrHeadroom || 10)} MW</span>
          </div>
        </div>
        <div class="settings-row"><label class="settings-label">Rating</label>
          <div class="settings-slider-group">
            <input type="range" class="rating-slider" min="1" max="500" value="${node.rating || 100}">
            <span class="rating-value">${node.rating || 100} MVA</span>
          </div>
        </div>
        <div class="settings-row"><label class="settings-label">Inertia H</label>
          <div class="settings-slider-group">
            <input type="range" class="inertia-slider" min="0" max="20" step="0.5" value="${node.inertia || 5}">
            <span class="inertia-value">${(node.inertia || 5).toFixed(1)}s</span>
          </div>
        </div>
        <div class="settings-row"><label class="settings-label">Droop</label>
          <div class="settings-slider-group">
            <input type="range" class="droop-slider" min="0.5" max="20" step="0.5" value="${(node.droop || 0.04) * 100}">
            <span class="droop-value">${(node.droop || 0.04) * 100}%</span>
          </div>
        </div>
        <div class="settings-row"><label class="settings-label">Turbine TC</label>
          <div class="settings-slider-group">
            <input type="range" class="tc-slider" min="0.2" max="5" step="0.1" value="${node.turbineTimeConstant || 1}">
            <span class="tc-value">${(node.turbineTimeConstant || 1).toFixed(1)}s</span>
          </div>
        </div>
        <div class="settings-row"><label class="settings-label">Ramp-Down TC</label>
          <div class="settings-slider-group">
            <input type="range" class="rd-slider" min="0.05" max="2" step="0.05" value="${node.rampDownTC || 0.3}">
            <span class="rd-value">${(node.rampDownTC || 0.3).toFixed(2)}s</span>
          </div>
        </div>
        <div class="settings-row sep-top"><label class="settings-label">Mode</label>
          <div class="settings-slider-group">
            <select class="gen-mode-select">
              <option value="balancing" ${node.mode === 'balancing' ? 'selected' : ''}>Balancing (FCR + AGC)</option>
              <option value="fcr-only" ${node.mode === 'fcr-only' ? 'selected' : ''}>FCR Only</option>
              <option value="merchant" ${node.mode === 'merchant' ? 'selected' : ''}>Merchant (Price Only)</option>
              <option value="fixed" ${node.mode === 'fixed' ? 'selected' : ''}>Fixed</option>
            </select>
          </div>
        </div>
        <div class="settings-row sep-top"><button class="gen-shutdown-btn" style="width:100%;padding:6px 0;border:1px solid #c0392b;border-radius:4px;cursor:pointer;font-size:13px;background:${node.tripped ? '#27ae60' : 'transparent'};color:${node.tripped ? '#fff' : '#c0392b'}">${node.tripped ? '🔄 Restart' : '🛑 Shut Down'}</button></div>
      </div>`;

    entry.outputEl = panel.querySelector('.gen-output');

    // Baseline Contract slider (updated by market, but user can tweak)
    const baselineSlider = panel.querySelector('.baseline-slider');
    const baselineVal = panel.querySelector('.baseline-value');
    entry.baselineSlider = baselineSlider;
    entry.baselineVal = baselineVal;
    baselineSlider.addEventListener('input', () => {
      const v = parseFloat(baselineSlider.value);
      baselineVal.textContent = Math.round(v) + ' MW';
      node.baselineContract = v;
    });
    baselineSlider.addEventListener('change', () => persist());

    // Rating slider
    const ratingSlider = panel.querySelector('.rating-slider');
    const ratingVal = panel.querySelector('.rating-value');
    ratingSlider.addEventListener('input', () => {
      const v = parseFloat(ratingSlider.value);
      ratingVal.textContent = v + ' MVA';
      node.rating = v;
      if (fcrSlider) fcrSlider.max = v;
      if (bidQtySlider) bidQtySlider.max = v;
      if (baselineSlider) baselineSlider.max = v;
    });
    ratingSlider.addEventListener('change', () => persist());

    // Bid Price slider
    const bidPriceSlider = panel.querySelector('.bid-price-slider');
    const bidPriceVal = panel.querySelector('.bid-price-value');
    if (bidPriceSlider) {
      bidPriceSlider.addEventListener('input', () => {
        const v = parseFloat(bidPriceSlider.value);
        bidPriceVal.textContent = '$' + v.toFixed(1) + '/MWh';
        node.bidPrice = v;
      });
      bidPriceSlider.addEventListener('change', () => persist());
    }

    // Bid Qty slider
    const bidQtySlider = panel.querySelector('.bid-qty-slider');
    const bidQtyVal = panel.querySelector('.bid-qty-value');
    if (bidQtySlider) {
      bidQtySlider.addEventListener('input', () => {
        const v = parseFloat(bidQtySlider.value);
        bidQtyVal.textContent = Math.round(v) + ' MWh';
        node.bidQty = v;
      });
      bidQtySlider.addEventListener('change', () => persist());
    }

    // FCR Headroom slider
    const fcrSlider = panel.querySelector('.fcr-headroom-slider');
    const fcrVal = panel.querySelector('.fcr-headroom-value');
    fcrSlider.addEventListener('input', () => {
      const v = parseFloat(fcrSlider.value);
      fcrVal.textContent = Math.round(v) + ' MW';
      node.fcrHeadroom = v;
    });
    fcrSlider.addEventListener('change', () => persist());

    // Inertia slider
    const inertiaSlider = panel.querySelector('.inertia-slider');
    const inertiaVal = panel.querySelector('.inertia-value');
    inertiaSlider.addEventListener('input', () => {
      const v = parseFloat(inertiaSlider.value);
      inertiaVal.textContent = v.toFixed(1) + 's';
      node.inertia = v;
    });
    inertiaSlider.addEventListener('change', () => persist());

    // Droop slider
    const droopSlider = panel.querySelector('.droop-slider');
    const droopVal = panel.querySelector('.droop-value');
    droopSlider.addEventListener('input', () => {
      const d = parseFloat(droopSlider.value);
      droopVal.textContent = d + '%';
      node.droop = d / 100;
    });
    droopSlider.addEventListener('change', () => persist());

    // Turbine TC slider
    const tcSlider = panel.querySelector('.tc-slider');
    const tcVal = panel.querySelector('.tc-value');
    tcSlider.addEventListener('input', () => {
      const v = parseFloat(tcSlider.value);
      tcVal.textContent = v.toFixed(1) + 's';
      node.turbineTimeConstant = v;
    });
    tcSlider.addEventListener('change', () => persist());

    // Ramp-Down TC slider
    const rdSlider = panel.querySelector('.rd-slider');
    const rdVal = panel.querySelector('.rd-value');
    rdSlider.addEventListener('input', () => {
      const v = parseFloat(rdSlider.value);
      rdVal.textContent = v.toFixed(2) + 's';
      node.rampDownTC = v;
    });
    rdSlider.addEventListener('change', () => persist());

    // Mode select
    const modeSelect = panel.querySelector('.gen-mode-select');
    if (modeSelect) {
      modeSelect.addEventListener('change', () => {
        node.mode = modeSelect.value;
        // Toggle market rows visibility (hidden for fixed mode)
        const marketRows = panel.querySelectorAll('.market-row');
        for (const row of marketRows) {
          row.style.display = modeSelect.value === 'fixed' ? 'none' : '';
        }
        persist();
      });
    }

    // Gen shutdown button
    const genShutdownBtn = panel.querySelector('.gen-shutdown-btn');
    if (genShutdownBtn) {
      genShutdownBtn.addEventListener('click', () => {
        node.tripped = !node.tripped;
        if (node.tripped) node.mw = 0;
        persist();
        genShutdownBtn.textContent = node.tripped ? '🔄 Restart' : '🛑 Shut Down';
        genShutdownBtn.style.background = node.tripped ? '#27ae60' : 'transparent';
        genShutdownBtn.style.color = node.tripped ? '#fff' : '#c0392b';
      });
      entry.shutdownBtn = genShutdownBtn;
    }

  } else if (node.type === 'storage') {
    const socVal = Math.round(node.mw || 0);
    const chgR = node.chargeRate || 50;
    const dchgR = node.dischargeRate || 50;
    const cap = node.maxCapacity || 100;
    const fcr = node.fcrHeadroom || 10;
    const drop = Math.round((node.droop || 0.04) * 100);
    const ft = node.fixedTarget || 0;
    const mode = node.mode || 'balancing';

    panel.innerHTML = `
      <div class="settings-header"><span class="settings-title">Storage ${tag}</span><span class="settings-close" data-action="close-settings">&times;</span></div>
      <div class="settings-body">
        <div class="settings-row"><label class="settings-label">State of Charge</label><div class="settings-slider-group"><input type="range" class="soc-slider" min="0" max="${cap}" step="0.1" value="${socVal}"><span class="settings-value-display storage-soc">${socVal} MWh</span></div></div>
        <div class="storage-fcr-group">
          <div class="settings-row"><label class="settings-label">Baseline Contract</label><div class="settings-slider-group"><input type="range" class="baseline-contract-slider" min="${-chgR}" max="${dchgR}" step="1" value="${node.baselineContract || 0}"><span class="baseline-contract-value">${(node.baselineContract || 0) >= 0 ? '+' : ''}${node.baselineContract || 0} MW</span></div></div>
          <div class="settings-row"><label class="settings-label">FCR Headroom</label><div class="settings-slider-group"><input type="range" class="fcr-headroom-slider" min="1" max="${Math.max(chgR, dchgR)}" step="1" value="${fcr}"><span class="fcr-headroom-value">${fcr} MW</span></div></div>
          <div class="settings-row"><label class="settings-label">Droop</label><div class="settings-slider-group"><input type="range" class="droop-slider" min="0.5" max="20" step="0.5" value="${drop}"><span class="droop-value">${drop}%</span></div></div>
        </div>
        <div class="storage-neutral-group" style="display:${mode === 'balancing' ? '' : 'none'}">
          <div class="settings-row" title="When enabled, AGC offset slowly decays to zero after frequency stabilizes (~60s). Prevents SoC drift and frees headroom by letting other units absorb the imbalance. Only active in Balancing mode.">
            <label class="settings-label" style="font-size:11px">Energy-Neutrality ⓘ</label>
            <div class="settings-slider-group">
              <label style="display:flex;align-items:center;gap:6px;cursor:pointer;user-select:none;font-size:12px;color:#aaa">
                <input type="checkbox" class="energy-neutral-checkbox" ${node.energyNeutral ? 'checked' : ''}>
                <span>return to baseline after disturbance</span>
              </label>
            </div>
          </div>
        </div>
        <div class="storage-fixed-group" style="display:${mode === 'fixed' ? '' : 'none'}">
          <div class="settings-row"><label class="settings-label">Target</label><div class="settings-slider-group"><input type="range" class="fixed-target-slider" min="${-chgR}" max="${dchgR}" step="1" value="${ft}"><span class="fixed-target-value">${ft >= 0 ? '+' : ''}${ft} MW</span></div></div>
        </div>
        <div class="settings-row"><label class="settings-label">Discharge Rate</label><div class="settings-slider-group"><input type="range" class="discharge-slider" min="1" max="500" step="1" value="${dchgR}"><span class="discharge-value">${dchgR} MW</span></div></div>
        <div class="settings-row"><label class="settings-label">Charge Rate</label><div class="settings-slider-group"><input type="range" class="charge-slider" min="1" max="500" step="1" value="${chgR}"><span class="charge-value">${chgR} MW</span></div></div>
        <div class="settings-row"><label class="settings-label">Max Capacity</label><div class="settings-slider-group"><input type="range" class="capacity-slider" min="10" max="1000" step="10" value="${cap}"><span class="capacity-value">${cap} MWh</span></div></div>
        <div class="settings-row sep-top"><label class="settings-label">Mode</label>
          <div class="settings-slider-group">
            <select class="storage-mode-select">
              <option value="balancing" ${mode === 'balancing' ? 'selected' : ''}>Balancing (FCR + AGC)</option>
              <option value="fcr-only" ${mode === 'fcr-only' ? 'selected' : ''}>FCR Only</option>
              <option value="grid-forming" ${mode === 'grid-forming' ? 'selected' : ''}>Grid Forming</option>
              <option value="fixed" ${mode === 'fixed' ? 'selected' : ''}>Fixed</option>
            </select>
          </div>
        </div>
        <div class="settings-row sep-top"><button class="storage-shutdown-btn" style="width:100%;padding:6px 0;border:1px solid #c0392b;border-radius:4px;cursor:pointer;font-size:13px;background:${node.tripped ? '#27ae60' : 'transparent'};color:${node.tripped ? '#fff' : '#c0392b'}">${node.tripped ? '🔄 Restart' : '🛑 Shut Down'}</button></div>
      </div>
      <div class="settings-resize-handle"></div>`;

    entry.socEl = panel.querySelector('.storage-soc');
    entry.mwRespEl = panel.querySelector('.storage-mw-response');
    entry.modeSelect = panel.querySelector('.storage-mode-select');
    entry.fcrGroup = panel.querySelector('.storage-fcr-group');
    entry.fixedGroup = panel.querySelector('.storage-fixed-group');

    // SoC slider
    const socSlider = panel.querySelector('.soc-slider');
    socSlider.addEventListener('input', () => { const v = parseFloat(socSlider.value); node.mw = Math.min(v, node.maxCapacity || 100); entry.socEl.textContent = v.toFixed(2) + ' MWh'; });
    socSlider.addEventListener('change', () => persist());

    // Baseline contract (dispatch) slider
    const bcSlider = panel.querySelector('.baseline-contract-slider');
    const bcVal = panel.querySelector('.baseline-contract-value');
    bcSlider.addEventListener('input', () => {
      const v = parseInt(bcSlider.value, 10);
      bcVal.textContent = (v >= 0 ? '+' : '') + v + ' MW';
      node.baselineContract = v;
    });
    bcSlider.addEventListener('change', () => persist());
    entry.bcSlider = bcSlider;
    entry.bcVal = bcVal;

    // Mode select
    entry.neutralGroup = panel.querySelector('.storage-neutral-group');
    const neutralCb = panel.querySelector('.energy-neutral-checkbox');
    neutralCb.addEventListener('change', () => {
      node.energyNeutral = neutralCb.checked;
      persist();
    });

    entry.modeSelect.addEventListener('change', () => {
      node.mode = entry.modeSelect.value;
      entry.fcrGroup.style.display = (node.mode === 'balancing' || node.mode === 'fcr-only' || node.mode === 'grid-forming') ? '' : 'none';
      entry.fixedGroup.style.display = node.mode === 'fixed' ? '' : 'none';
      if (entry.neutralGroup) entry.neutralGroup.style.display = node.mode === 'balancing' ? '' : 'none';
      persist();
    });

    // Storage shutdown button
    const stShutdownBtn = panel.querySelector('.storage-shutdown-btn');
    if (stShutdownBtn) {
      stShutdownBtn.addEventListener('click', () => {
        node.tripped = !node.tripped;
        if (node.tripped) { node.mwResponse = 0; node.mw = node.mw || 0; }
        persist();
        stShutdownBtn.textContent = node.tripped ? '🔄 Restart' : '🛑 Shut Down';
        stShutdownBtn.style.background = node.tripped ? '#27ae60' : 'transparent';
        stShutdownBtn.style.color = node.tripped ? '#fff' : '#c0392b';
      });
      entry.shutdownBtn = stShutdownBtn;
    }

    // FCR headroom slider
    const fcrSlider = panel.querySelector('.fcr-headroom-slider');
    const fcrVal = panel.querySelector('.fcr-headroom-value');
    entry.fcrSlider = fcrSlider;
    entry.fcrVal = fcrVal;
    fcrSlider.addEventListener('input', () => { const v = parseInt(fcrSlider.value, 10); fcrVal.textContent = v + ' MW'; node.fcrHeadroom = v; });
    fcrSlider.addEventListener('change', () => persist());

    // Droop slider
    const droopSlider = panel.querySelector('.droop-slider');
    const droopVal = panel.querySelector('.droop-value');
    entry.droopSlider = droopSlider;
    entry.droopVal = droopVal;
    droopSlider.addEventListener('input', () => { const v = parseFloat(droopSlider.value); droopVal.textContent = v + '%'; node.droop = v / 100; });
    droopSlider.addEventListener('change', () => persist());

    // Fixed target slider
    const fixedSlider = panel.querySelector('.fixed-target-slider');
    const fixedVal = panel.querySelector('.fixed-target-value');
    entry.fixedSlider = fixedSlider;
    entry.fixedVal = fixedVal;
    fixedSlider.addEventListener('input', () => { const v = parseInt(fixedSlider.value, 10); fixedVal.textContent = (v >= 0 ? '+' : '') + v + ' MW'; node.fixedTarget = v; });
    fixedSlider.addEventListener('change', () => persist());

    // Charge/discharge dual-range sliders
    const chg = panel.querySelector('.charge-slider'), chgV = panel.querySelector('.charge-value');
    const dchg = panel.querySelector('.discharge-slider'), dchgV = panel.querySelector('.discharge-value');
    chg.addEventListener('input', () => { const v = parseInt(chg.value, 10); chgV.textContent = v + ' MW'; node.chargeRate = v; fixedSlider.min = -v; });
    chg.addEventListener('change', () => persist());
    dchg.addEventListener('input', () => { const v = parseInt(dchg.value, 10); dchgV.textContent = v + ' MW'; node.dischargeRate = v; fixedSlider.max = v; });
    dchg.addEventListener('change', () => persist());

    // Capacity slider
    const capSlider = panel.querySelector('.capacity-slider'), capV = panel.querySelector('.capacity-value');
    capSlider.addEventListener('input', () => { const v = parseInt(capSlider.value, 10); capV.textContent = v + ' MWh'; node.maxCapacity = v; if (node.mw > v) { node.mw = v; entry.socEl.textContent = v.toFixed(2) + ' MWh'; socSlider.max = v; } });
    capSlider.addEventListener('change', () => persist());

  } else {
    panel.innerHTML = `
      <div class="settings-header"><span class="settings-title">Load ${tag}</span><span class="settings-close" data-action="close-settings">&times;</span></div>
      <div class="settings-body">
        <div class="settings-row">
          <label class="settings-label">Auto Demand Curve</label>
          <label class="toggle-switch">
            <input type="checkbox" class="noise-toggle" ${node.noiseEnabled ? 'checked' : ''}>
            <span class="toggle-slider"></span>
          </label>
        </div>
        <div class="settings-row noise-row"${node.noiseEnabled ? '' : ' style="display:none"'}>
          <label class="settings-label">Min (MW)</label>
          <div class="settings-slider-group"><input type="range" class="noise-min-slider" min="0" max="500" step="10" value="${node.noiseMin || 100}"><span class="noise-min-value">${node.noiseMin || 100}</span></div>
        </div>
        <div class="settings-row noise-row"${node.noiseEnabled ? '' : ' style="display:none"'}>
          <label class="settings-label">Max (MW)</label>
          <div class="settings-slider-group"><input type="range" class="noise-max-slider" min="0" max="500" step="10" value="${node.noiseMax || 200}"><span class="noise-max-value">${node.noiseMax || 200}</span></div>
        </div>
        <div class="settings-row noise-row"${node.noiseEnabled ? '' : ' style="display:none"'}>
          <label class="settings-label">Noise ±%</label>
          <div class="settings-slider-group"><input type="range" class="noise-pct-slider" min="0" max="100" step="1" value="${node.noisePct || 10}"><span class="noise-pct-value">${node.noisePct || 10}%</span></div>
        </div>
        <div class="settings-row noise-row"${node.noiseEnabled ? '' : ' style="display:none"'}>
          <canvas class="demand-preview" width="320" height="80" data-node-id="${node.id}"></canvas>
        </div>
        <div class="settings-row manual-row"${node.noiseEnabled ? ' style="display:none"' : ''}>
          <label class="settings-label">Demand (MW)</label>
          <div class="settings-slider-group"><input type="range" class="mw-slider" min="0" max="500" step="10" value="${node.mw || 10}"><span class="mw-value">${node.mw || 10}</span></div>
        </div>
      </div>
      <div class="settings-resize-handle"></div>`;

    const slider = panel.querySelector('.mw-slider'), valEl = panel.querySelector('.mw-value');
    slider.addEventListener('input', () => { const v = parseInt(slider.value, 10); valEl.textContent = v; node.mw = v; node.baseMw = v; draw(); });
    slider.addEventListener('change', () => persist());

    const noiseToggle = panel.querySelector('.noise-toggle');
    noiseToggle.addEventListener('change', () => {
      node.noiseEnabled = noiseToggle.checked;
      // Show/hide noise rows and manual row
      for (const el of panel.querySelectorAll('.noise-row')) el.style.display = noiseToggle.checked ? '' : 'none';
      const manualRow = panel.querySelector('.manual-row');
      if (manualRow) manualRow.style.display = noiseToggle.checked ? 'none' : '';
      draw();
      persist();
    });

    const noiseMinSlider = panel.querySelector('.noise-min-slider');
    const noiseMinVal = panel.querySelector('.noise-min-value');
    if (noiseMinSlider) {
      noiseMinSlider.addEventListener('input', () => {
        const v = parseInt(noiseMinSlider.value, 10);
        noiseMinVal.textContent = v;
        node.noiseMin = v;
        drawLoadCurvePreview(panel.querySelector('.demand-preview'), node);
        draw();
      });
      noiseMinSlider.addEventListener('change', () => persist());
    }

    const noiseMaxSlider = panel.querySelector('.noise-max-slider');
    const noiseMaxVal = panel.querySelector('.noise-max-value');
    if (noiseMaxSlider) {
      noiseMaxSlider.addEventListener('input', () => {
        const v = parseInt(noiseMaxSlider.value, 10);
        noiseMaxVal.textContent = v;
        node.noiseMax = v;
        drawLoadCurvePreview(panel.querySelector('.demand-preview'), node);
        draw();
      });
      noiseMaxSlider.addEventListener('change', () => persist());
    }

    const noisePctSlider = panel.querySelector('.noise-pct-slider');
    const noisePctVal = panel.querySelector('.noise-pct-value');
    if (noisePctSlider) {
      noisePctSlider.addEventListener('input', () => {
        const v = parseInt(noisePctSlider.value, 10);
        noisePctVal.textContent = v + '%';
        node.noisePct = v;
      });
      noisePctSlider.addEventListener('change', () => persist());
    }

    // Draw the preview canvas on open
    const previewCanvas = panel.querySelector('.demand-preview');
    if (previewCanvas) drawLoadCurvePreview(previewCanvas, node);
  }

  const count = Object.keys(openPanels).length;
  panel.style.left = (120 + count * 28) + 'px'; panel.style.top = (80 + count * 28) + 'px';
  document.body.appendChild(panel);

  panel.querySelector('[data-action="close-settings"]').addEventListener('click', (e) => { e.stopPropagation(); closeSettings(nodeId); });

  panel.addEventListener('mousedown', (e) => {
    if (e.target.closest('.settings-header')) { dragPanel = panel; dragOff = { x: e.clientX - panel.offsetLeft, y: e.clientY - panel.offsetTop }; panel.style.zIndex = Date.now(); e.preventDefault(); }
    if (e.target.closest('.settings-resize-handle')) { resizePanel = panel; resizeStart = { x: e.clientX, y: e.clientY, w: panel.offsetWidth, h: panel.offsetHeight }; panel.style.zIndex = Date.now(); e.preventDefault(); }
  });

  openPanels[nodeId] = entry;
}

function closeSettings(nodeId) { if (openPanels[nodeId]) { openPanels[nodeId].panel.remove(); delete openPanels[nodeId]; } }

function openLineSettings(connId) {
  const conn = state.connections.find(c => c.id === connId);
  if (!conn) return;
  // Close existing line settings
  if (openPanels['_line_' + connId]) { openPanels['_line_' + connId].panel.style.zIndex = Date.now(); return; }

  const panel = document.createElement('div');
  panel.className = 'settings-panel'; panel.style.zIndex = Date.now();
  panel.dataset.nodeId = '_line_' + connId;
  const src = state.nodes.find(n => n.id === conn.sourceId);
  const tgt = state.nodes.find(n => n.id === conn.targetId);
  const tag = (src ? (src.shortId || src.id.slice(-4)) : '?') + ' → ' + (tgt ? (tgt.shortId || tgt.id.slice(-4)) : '?');

  const x = (conn.reactance || 0.1);
  const t = conn.thermalLimit || 100;

  panel.innerHTML = `
    <div class="settings-header"><span class="settings-title">Line ${tag}</span><span class="settings-close" data-action="close-settings">&times;</span></div>
    <div class="settings-body">
      <div class="settings-row"><label class="settings-label">Reactance (p.u.)</label>
        <div class="settings-slider-group">
          <input type="range" min="0.001" max="1" step="0.001" value="${x}">
          <span class="settings-value-display">${x.toFixed(3)}</span>
        </div>
      </div>
      <div class="settings-row"><label class="settings-label">Thermal Limit (MW)</label>
        <div class="settings-slider-group">
          <input type="range" min="1" max="500" step="1" value="${t}">
          <span class="settings-value-display">${t} MW</span>
        </div>
      </div>
    </div>
  `;

  document.body.appendChild(panel);
  panel.style.left = Math.min(window.innerWidth - 240, Math.max(10, (window.innerWidth - 220) / 2)) + 'px';
  panel.style.top = Math.min(window.innerHeight - 200, Math.max(10, 80)) + 'px';

  const entry = { panel };
  const xSlider = panel.querySelectorAll('input[type="range"]')[0];
  const tSlider = panel.querySelectorAll('input[type="range"]')[1];
  const xVal = panel.querySelectorAll('.settings-value-display')[0];
  const tVal = panel.querySelectorAll('.settings-value-display')[1];

  xSlider.addEventListener('input', () => {
    const v = parseFloat(xSlider.value);
    xVal.textContent = v.toFixed(3);
    conn.reactance = v;
  });
  xSlider.addEventListener('change', () => persist());

  tSlider.addEventListener('input', () => {
    const v = parseInt(tSlider.value, 10);
    tVal.textContent = v + ' MW';
    conn.thermalLimit = v;
  });
  tSlider.addEventListener('change', () => persist());

  // Close button
  panel.querySelector('.settings-close').addEventListener('click', () => {
    panel.remove();
    delete openPanels['_line_' + connId];
  });

  // Make draggable
  panel.querySelector('.settings-header').addEventListener('mousedown', (e) => {
    if (e.target.closest('.settings-close')) return;
    dragPanel = panel;
    dragOff = { x: e.clientX - panel.offsetLeft, y: e.clientY - panel.offsetTop };
    panel.style.zIndex = Date.now();
    e.preventDefault();
  });

  openPanels['_line_' + connId] = entry;
}

document.addEventListener('mousemove', (e) => {
  if (dragPanel) { dragPanel.style.left = (e.clientX - dragOff.x) + 'px'; dragPanel.style.top = (e.clientY - dragOff.y) + 'px'; }
  if (resizePanel) { resizePanel.style.width = Math.max(220, resizeStart.w + e.clientX - resizeStart.x) + 'px'; resizePanel.style.height = Math.max(140, resizeStart.h + e.clientY - resizeStart.y) + 'px'; }
});
document.addEventListener('mouseup', () => { dragPanel = null; resizePanel = null; });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { for (const id of Object.keys(openPanels)) closeSettings(id); } });

// ─── Controls ──────────────────────────────────────────────────────────

function updateControls() {
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

// ─── Speed Control ───────────────────────────────────────────────────────
const speedSlider = document.getElementById('speed-slider');
const speedValue = document.getElementById('speed-value');
function updateSpeedDisplay() { speedValue.textContent = sim.speed + '×'; }
speedSlider.addEventListener('input', () => {
  sim.speed = parseFloat(speedSlider.value);
  updateSpeedDisplay();
});

// ─── Stats Panel ────────────────────────────────────────────────────────

let statsPanelVisible = false;
let selectedNetworkId = 'all';

function toggleStatsBreakdown(nodeId) {
  if (state.statsBreakdownExpanded.has(nodeId)) {
    state.statsBreakdownExpanded.delete(nodeId);
  } else {
    state.statsBreakdownExpanded.add(nodeId);
  }
  updateStatsPanel();
}

function updateStatsPanel() {
  const body = document.getElementById('stats-body');
  if (!body || !statsPanelVisible) return;

  // Build network selector
  const nets = state.networks && state.networks.length > 0 ? state.networks : [];
  let html = '';

  if (nets.length > 0) {
    html += '<div class="stats-island-select">';
    html += '<select id="island-select" onchange="selectedNetworkId=this.value;updateStatsPanel();" style="width:100%;padding:4px;font-size:13px;border:1px solid #d6d2c8;border-radius:4px;background:#faf8f4">';
    if (nets.length > 1) {
      html += '<option value="all"' + (selectedNetworkId === 'all' ? ' selected' : '') + '>🌐 All islands</option>';
    }
    for (const net of nets) {
      const netNodes = [...net.nodeIds].map(id => state.nodes.find(n => n.id === id)).filter(Boolean);
      const gCount = netNodes.filter(n => n.type === 'generator').length;
      const lCount = netNodes.filter(n => n.type === 'load').length;
      const sCount = netNodes.filter(n => n.type === 'storage').length;
      let label = '🌐 ' + net.id;
      const parts = [];
      if (gCount) parts.push(gCount + 'G');
      if (lCount) parts.push(lCount + 'L');
      if (sCount) parts.push(sCount + 'S');
      if (parts.length) label += ' (' + parts.join(', ') + ')';
      html += '<option value="' + net.id + '"' + (selectedNetworkId === net.id ? ' selected' : '') + '>' + label + '</option>';
    }
    html += '</select>';
    html += '</div>';
  }

  // Filter nodes by selected island
  const nodeFilter = selectedNetworkId === 'all' || !nets.length
    ? n => true
    : n => nets.find(net => net.id === selectedNetworkId)?.nodeIds.has(n.id);

  const gens = state.nodes.filter(n => n.type === 'generator' && nodeFilter(n));
  const loads = state.nodes.filter(n => n.type === 'load' && nodeFilter(n));
  const storages = state.nodes.filter(n => n.type === 'storage' && nodeFilter(n));
  const totalGen = gens.reduce((s, g) => s + (g.mw || 0), 0);
  const totalLoad = loads.reduce((s, l) => s + (l.mw || 0), 0);
  const totalStor = storages.reduce((s, st) => s + (st.mwResponse || 0), 0);
  const netImbalance = totalGen + totalStor - totalLoad;

  const islandFreq = selectedNetworkId !== 'all' && nets.length
    ? (nets.find(net => net.id === selectedNetworkId)?.freq || 50)
    : state.frequency;

  // --- Supply ---
  html += '<div class="stats-section">';
  html += '<div class="stats-section-title">⚡ Supply</div>';
  for (const gen of gens) {
    const base = gen.baselineContract || 0;
    const tag = gen.mode === 'fixed' ? '<span class="merchant-tag">🔒</span>' : (gen.mode === 'fcr-only' ? '<span class="merchant-tag">⚡FCR</span>' : '');
    html += '<div class="stats-row">';
    html += '<span><span class="gen-name">' + (gen.shortId || gen.id.slice(-4)) + '</span>' + tag + '</span>';
    html += '<span class="value">' + Math.round(gen.mw || 0) + ' MW</span>';
    html += '</div>';
    const dev = (islandFreq - 50) / 50;
    const govMod = -(1 / (gen.droop || 0.04)) * dev * (gen.rating || 100);
    const agcComp = gen.agcOffset || 0;
    const genExpanded = state.statsBreakdownExpanded.has(gen.id);
    if (genExpanded) {
      html += '<div class="stats-breakdown-row">';
      html += '<span class="stats-toggle" onclick="toggleStatsBreakdown(\'' + gen.id + '\')">▼ </span>';
      html += '<span class="stats-breakdown-value">base ' + Math.round(base) + ' + FCR ' + (govMod >= 0 ? '+' : '') + Math.round(govMod) + ' + AGC ' + (agcComp >= 0 ? '+' : '') + Math.round(agcComp) + '</span>';
      html += '</div>';
    } else {
      html += '<div class="stats-breakdown-row">';
      html += '<span class="stats-toggle" onclick="toggleStatsBreakdown(\'' + gen.id + '\')">▶</span>';
      html += '<span class="stats-breakdown-value"></span>';
      html += '</div>';
    }
  }
  html += '<div class="stats-row total"><span>Total supply</span><span class="value">' + Math.round(totalGen) + ' MW</span></div>';
  html += '</div>';

  // --- Demand ---
  html += '<div class="stats-section">';
  html += '<div class="stats-section-title">🔌 Demand</div>';
  for (const load of loads) {
    html += '<div class="stats-row"><span>' + (load.shortId || load.id.slice(-4)) + '</span><span class="value">' + Math.round(load.mw || 0) + ' MW</span></div>';
  }
  html += '<div class="stats-row total"><span>Total demand</span><span class="value">' + Math.round(totalLoad) + ' MW</span></div>';
  html += '</div>';

  // --- Storage ---
  if (storages.length > 0) {
    html += '<div class="stats-section">';
    html += '<div class="stats-section-title">🔋 Storage</div>';
    for (const st of storages) {
      const tag = st.mode === 'fixed' ? ' 🔒' : (st.mode === 'idle' ? ' 💤' : '');
      const mw = st.mwResponse || 0;
      const dir = mw > 0.5 ? 'discharge' : (mw < -0.5 ? 'charge' : 'idle');
      html += '<div class="stats-row"><span>' + (st.shortId || st.id.slice(-4)) + tag + ' (' + dir + ')</span><span class="value">' + (mw >= 0 ? '+' : '') + Math.round(mw) + ' MW</span></div>';
      html += '<div style="padding-left:12px;font-size:12px;color:#999;">SoC: ' + (st.mw || 0).toFixed(2) + '/' + Math.round(st.maxCapacity || 100) + ' MWh</div>';
      const bc = st.baselineContract || 0;
      const sDev = (islandFreq - 50) / 50;
      const sGovMod = -(1 / (st.droop || 0.04)) * sDev * (st.dischargeRate || 500);
      const sAgc = st.agcOffset || 0;
      const stExpanded = state.statsBreakdownExpanded.has(st.id);
      if (stExpanded) {
        html += '<div class="stats-breakdown-row">';
        html += '<span class="stats-toggle" onclick="toggleStatsBreakdown(\'' + st.id + '\')">▼ </span>';
        html += '<span class="stats-breakdown-value">base ' + Math.round(bc) + ' + FCR ' + (sGovMod >= 0 ? '+' : '') + Math.round(sGovMod) + ' + AGC ' + (sAgc >= 0 ? '+' : '') + Math.round(sAgc) + '</span>';
        html += '</div>';
      } else {
        html += '<div class="stats-breakdown-row">';
        html += '<span class="stats-toggle" onclick="toggleStatsBreakdown(\'' + st.id + '\')">▶</span>';
        html += '<span class="stats-breakdown-value"></span>';
        html += '</div>';
      }
    }
    html += '<div class="stats-row total"><span>Net storage</span><span class="value">' + (totalStor >= 0 ? '+' : '') + Math.round(totalStor) + ' MW</span></div>';
    html += '</div>';
  }

  // --- System ---
  html += '<div class="stats-section">';
  html += '<div class="stats-section-title">📊 System</div>';
  if (nets.length > 1 && selectedNetworkId === 'all') {
    html += '<div class="stats-row"><span>Islands</span><span class="value">' + nets.length + '</span></div>';
  }
  html += '<div class="stats-row"><span>Frequency</span><span class="value">' + islandFreq.toFixed(3) + ' Hz</span></div>';
  const imbClass = netImbalance > 0.5 ? 'positive' : (netImbalance < -0.5 ? 'negative' : '');
  html += '<div class="stats-row"><span>Net imbalance</span><span class="value ' + imbClass + '">' + (netImbalance > 0 ? '+' : '') + netImbalance.toFixed(1) + ' MW</span></div>';
  html += '<div class="stats-row"><span>Rated headroom</span><span class="value">' + gens.reduce((s, g) => s + Math.max(0, (g.rating || 100) - (g.mw || 0)), 0).toFixed(0) + ' MW</span></div>';
  html += '</div>';

  // --- Chart toggle button ---
  html += '<button class="stats-chart-btn" onclick="freqChartVisible=!freqChartVisible;document.getElementById(\'freq-chart-panel\').classList.toggle(\'hidden\',!freqChartVisible);if(freqChartVisible)drawFreqChart();">📈 Frequency Graph</button>';

  body.innerHTML = html;
}

// ─── Frequency Chart ──────────────────────────────────────────

let freqChartVisible = false;
let meritChartVisible = false;

function drawFreqChart() {
  const canvas = document.getElementById('freq-chart-canvas');
  if (!canvas || !freqChartVisible) return;
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  const w = rect.width, h = rect.height;
  const pad = { top: 10, right: 12, bottom: 22, left: 36 };
  const pw = w - pad.left - pad.right, ph = h - pad.top - pad.bottom;

  // Clear
  ctx.fillStyle = '#f5f3ee';
  ctx.fillRect(0, 0, w, h);

  // Data
  const data = sim.dataBuffer;
  if (data.length < 2) return;

  // Resolve which frequency trace to draw
  function getFreq(d) {
    if (selectedNetworkId !== 'all' && d.networks && d.networks[selectedNetworkId] !== undefined) {
      return d.networks[selectedNetworkId];
    }
    return d.frequency;
  }

  // Determine Y range — pad by 1 Hz above/below min/max
  let minF = 50, maxF = 50;
  for (const d of data) {
    const f = getFreq(d);
    if (f < minF) minF = f;
    if (f > maxF) maxF = f;
  }
  // Clamp to sensible range and add padding
  minF = Math.max(45, Math.min(49, minF - 0.5));
  maxF = Math.min(55, Math.max(51, maxF + 0.5));
  const fRange = maxF - minF || 1;

  // Draw grid lines
  ctx.strokeStyle = '#e0dcd2';
  ctx.lineWidth = 1;
  for (let f = Math.ceil(minF); f <= Math.floor(maxF); f++) {
    const y = pad.top + ph - ((f - minF) / fRange) * ph;
    ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(w - pad.right, y); ctx.stroke();
    ctx.fillStyle = '#8a867e';
    ctx.font = '10px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillText(f + ' Hz', pad.left - 4, y);
  }

  // Draw 50 Hz reference line (thicker)
  {
    const y50 = pad.top + ph - ((50 - minF) / fRange) * ph;
    ctx.strokeStyle = '#5a7a5a';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(pad.left, y50); ctx.lineTo(w - pad.right, y50); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#5a7a5a';
    ctx.font = '10px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText('50 Hz', w - pad.right + 4, y50);
  }

  // Draw frequency line
  const maxT = data[data.length - 1].t;
  const minT = Math.max(0, maxT - 60); // Show last 60 seconds
  const tRange = maxT - minT || 1;

  ctx.strokeStyle = '#2c6b9e';
  ctx.lineWidth = 2;
  ctx.beginPath();
  let started = false;
  for (let i = 0; i < data.length; i++) {
    const d = data[i];
    if (d.t < minT) continue;
    const x = pad.left + ((d.t - minT) / tRange) * pw;
    const y = pad.top + ph - ((getFreq(d) - minF) / fRange) * ph;
    if (!started) { ctx.moveTo(x, y); started = true; }
    else ctx.lineTo(x, y);
  }
  ctx.stroke();

  // Time labels
  ctx.fillStyle = '#8a867e';
  ctx.font = '10px -apple-system, BlinkMacSystemFont, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (let t = Math.ceil(minT / 10) * 10; t <= maxT; t += 10) {
    const x = pad.left + ((t - minT) / tRange) * pw;
    ctx.fillText(t + 's', x, h - pad.bottom + 6);
  }

  // Current frequency marker at end
  if (data.length > 0) {
    const last = data[data.length - 1];
    const lx = pw + pad.left;
    const ly = pad.top + ph - ((getFreq(last) - minF) / fRange) * ph;
    ctx.fillStyle = '#2c6b9e';
    ctx.beginPath(); ctx.arc(lx, ly, 3, 0, Math.PI * 2); ctx.fill();
  }
}

document.getElementById('stats-btn').addEventListener('click', () => {
  statsPanelVisible = !statsPanelVisible;
  document.getElementById('stats-panel').classList.toggle('hidden');
  if (statsPanelVisible) updateStatsPanel();
});

document.getElementById('stats-close-btn').addEventListener('click', () => {
  statsPanelVisible = false;
  document.getElementById('stats-panel').classList.add('hidden');
});

// Make stats panel draggable
document.getElementById('stats-panel').addEventListener('mousedown', (e) => {
  if (e.target.closest('.stats-header') && !e.target.closest('.stats-close')) {
    const panel = document.getElementById('stats-panel');
    dragPanel = panel;
    dragOff = { x: e.clientX - panel.offsetLeft, y: e.clientY - panel.offsetTop };
    panel.style.zIndex = Date.now();
    e.preventDefault();
  }
});

// ─── Merit Order Panel ───────────────────────────────────────────

document.getElementById('merit-btn').addEventListener('click', () => {
  meritChartVisible = !meritChartVisible;
  document.getElementById('merit-panel').classList.toggle('hidden');
  if (meritChartVisible) drawMeritOrderChart();
});

document.getElementById('merit-close-btn').addEventListener('click', () => {
  meritChartVisible = false;
  document.getElementById('merit-panel').classList.add('hidden');
});

// Make merit panel draggable
document.getElementById('merit-panel').addEventListener('mousedown', (e) => {
  if (e.target.closest('.merit-header') && !e.target.closest('.merit-close')) {
    const panel = document.getElementById('merit-panel');
    dragPanel = panel;
    dragOff = { x: e.clientX - panel.offsetLeft, y: e.clientY - panel.offsetTop };
    panel.style.zIndex = Date.now();
    e.preventDefault();
  }
});

function drawMeritOrderChart() {
  const canvas = document.getElementById('merit-canvas');
  if (!canvas || !meritChartVisible) return;
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return;
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  const w = rect.width, h = rect.height;
  const pad = { top: 28, right: 16, bottom: 30, left: 52 };
  const pw = w - pad.left - pad.right, ph = h - pad.top - pad.bottom;

  ctx.fillStyle = '#f5f3ee';
  ctx.fillRect(0, 0, w, h);
  ctx.save();
  ctx.translate(pad.left, pad.top);

  const gens = state.nodes.filter(n => n.type === 'generator' && !n.tripped && n.mode !== 'fixed')
    .sort((a, b) => a.bidPrice - b.bidPrice);
  const totalLoad = state.nodes.filter(n => n.type === 'load').reduce((s, l) => s + (l.mw || 0), 0);

  if (!gens.length) { ctx.restore(); return; }

  const maxPrice = Math.max(...gens.map(g => g.bidPrice), 1) * 1.15;
  const totalQty = gens.reduce((s, g) => s + (g.bidQty || g.rating || 100), 0);
  const xMax = Math.max(totalQty, totalLoad) * 1.1;

  // Grid lines
  ctx.strokeStyle = '#e0dcd2';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 5; i++) {
    const y = (ph / 5) * i;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(pw, y); ctx.stroke();
    ctx.fillStyle = '#999';
    ctx.font = '11px sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillText('$' + (maxPrice - (maxPrice / 5) * i).toFixed(0), -8, y);
  }
  for (let i = 0; i <= 5; i++) {
    const x = (pw / 5) * i;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, ph); ctx.stroke();
    ctx.fillStyle = '#999';
    ctx.font = '11px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText(Math.round((xMax / 5) * i) + ' MWh', x, ph + 6);
  }

  // Staircase
  let cum = 0;
  const steps = gens.map(g => {
    const q = g.bidQty || g.rating || 100;
    const s = { x1: cum, x2: cum + q, price: g.bidPrice, gen: g };
    cum += q;
    return s;
  });

  let marginal = null;
  for (const s of steps) { if (s.x1 < totalLoad) marginal = s; }

  for (const s of steps) {
    const x1 = (s.x1 / xMax) * pw, x2 = (s.x2 / xMax) * pw;
    const y = ph - (s.price / maxPrice) * ph, hh = ph - y;
    const t = s.price / maxPrice;
    ctx.fillStyle = `rgba(${Math.round(60 + t * 195)},${Math.round(180 - t * 150)},${Math.round(50 - t * 30)},0.7)`;
    ctx.fillRect(x1, y, x2 - x1, hh);
    ctx.strokeStyle = '#666';
    ctx.lineWidth = 1;
    ctx.strokeRect(x1, y, x2 - x1, hh);
    if (x2 - x1 > 40) {
      ctx.fillStyle = '#333';
      ctx.font = '10px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.fillText(s.gen.shortId + ' $' + s.price.toFixed(0), (x1 + x2) / 2, y - 2);
    }
  }

  // Load line
  const lx = (totalLoad / xMax) * pw;
  ctx.strokeStyle = '#2c6b9e';
  ctx.lineWidth = 2;
  ctx.setLineDash([5, 4]);
  ctx.beginPath(); ctx.moveTo(lx, 0); ctx.lineTo(lx, ph);
  ctx.stroke();
  ctx.setLineDash([]);

  // SMP marker
  if (marginal) {
    const sy = ph - (marginal.price / maxPrice) * ph;
    ctx.fillStyle = '#2c6b9e';
    ctx.beginPath(); ctx.arc(lx, sy, 6, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(lx, sy, 6, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = '#2c6b9e';
    ctx.font = 'bold 12px sans-serif';
    ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
    ctx.fillText('SMP $' + (state.smp || marginal.price).toFixed(1) + '/MWh', lx + 10, sy - 4);
  }

  if (totalLoad > totalQty) {
    ctx.fillStyle = '#b33';
    ctx.font = 'bold 13px sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('⚠ Insufficient generation capacity!', pw / 2, ph / 2);
  }

  ctx.restore();
}

// ─── Frequency Chart ──────────────────────────────────────────

// Detect clicks on any frequency HUD box
canvas.addEventListener('click', (e) => {
  const screen = mouseToScreen(e);

  // Check island header click (select island)
  const world = mouseToWorld(e);
  const islandHit = hitIsland(world.x, world.y);
  if (islandHit && islandHit.isHeader) {
    selectedNetworkId = islandHit.net.id;
    if (statsPanelVisible) updateStatsPanel();
    draw();
  } else if (!hitNode(world.x, world.y) && !islandHit) {
    // Click on empty canvas — deselect island, clean view
    if (selectedNetworkId !== 'all') {
      selectedNetworkId = 'all';
      if (statsPanelVisible) updateStatsPanel();
      draw();
    }
  }
});

document.getElementById('freq-chart-close-btn').addEventListener('click', () => {
  freqChartVisible = false;
  document.getElementById('freq-chart-panel').classList.add('hidden');
});

// Make chart panel draggable
document.getElementById('freq-chart-panel').addEventListener('mousedown', (e) => {
  if (e.target.closest('.freq-chart-header') && !e.target.closest('.freq-chart-close')) {
    const panel = document.getElementById('freq-chart-panel');
    dragPanel = panel;
    dragOff = { x: e.clientX - panel.offsetLeft, y: e.clientY - panel.offsetTop };
    panel.style.zIndex = Date.now();
    e.preventDefault();
  }
});

// ─── Balance Setup Modal ────────────────────────────────────────────────

function openBalanceModal() {
  if (sim.running) return;
  const nets = findNetworks();
  if (!nets.length) return;

  // Save originals for cancel
  const origBaselines = {};
  const origMw = {};
  const origShed = {};
  for (const n of state.nodes) {
    if (n.type === 'generator') {
      origBaselines[n.id] = n.baselineContract || 0;
      origMw[n.id] = n.mw;
      origShed[n.id] = n.shedPct || 0;
    } else if (n.type === 'storage') {
      origBaselines[n.id] = n.baselineContract || 0;
    } else if (n.type === 'load') {
      origMw[n.id] = n.mw;
      origShed[n.id] = n.shedPct || 0;
    }
  }
  const origConnTripped = {};
  for (const c of state.connections) origConnTripped[c.id] = c.tripped;
  const origNetsFreq = {};
  for (const net of nets) origNetsFreq[net.id] = net.freq || 50;

  // Build modal
  const overlay = document.createElement('div');
  overlay.className = 'balance-overlay';
  overlay.innerHTML = `<div class="balance-modal">
    <div class="balance-header">⚖️ Balance Setup</div>
    <div class="balance-body" id="balance-body"></div>
    <div class="balance-footer">
      <button class="balance-apply-btn">✓ Apply</button>
      <button class="balance-cancel-btn">✕ Cancel</button>
    </div>
  </div>`;
  document.body.appendChild(overlay);

  const bodyEl = overlay.querySelector('#balance-body');
  const applyBtn = overlay.querySelector('.balance-apply-btn');
  const cancelBtn = overlay.querySelector('.balance-cancel-btn');

  // Per-island state
  const islandStates = [];

  for (const net of nets) {
    const netNodes = [...net.nodeIds].map(id => state.nodes.find(n => n.id === id)).filter(Boolean);
    const loads = netNodes.filter(n => n.type === 'load');
    const gens = netNodes.filter(n => n.type === 'generator');
    const storages = netNodes.filter(n => n.type === 'storage');

    const islandState = {
      netId: net.id,
      loadEntries: [],
      flexGenEntries: [],
      flexStorEntries: [],
      fixedEntries: [],
      remainingEl: null,
    };

    // Clamp helper
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

    // Build section
    const section = document.createElement('div');
    section.className = 'balance-island';

    // Header
    const header = document.createElement('div');
    header.className = 'balance-island-header';
    header.innerHTML = `<span class="balance-island-name">Island ${net.id.slice(-4)}</span>`;
    const headerStats = document.createElement('span');
    headerStats.className = 'balance-island-stats';
    header.appendChild(headerStats);
    section.appendChild(header);

    function updateSummary() {
      // Recalculate remaining
      function isLocked(e) { return e.lockBtn.classList.contains('balance-locked'); }
      let totalDemand = 0, fixedSupply = 0, lockedSupply = 0;
      for (const e of islandState.loadEntries) totalDemand += Number(e.slider.value);
      for (const e of islandState.fixedEntries) {
        if (e.node.type === 'generator') fixedSupply += e.value;
        else fixedSupply += e.value;
      }
      for (const e of islandState.flexGenEntries) {
        if (isLocked(e)) lockedSupply += Number(e.slider.value);
      }
      for (const e of islandState.flexStorEntries) {
        if (isLocked(e)) lockedSupply += Number(e.slider.value);
      }
      const remaining = totalDemand - fixedSupply - lockedSupply;
      const totalDispatched = lockedSupply + fixedSupply;
      headerStats.textContent = `Load ${totalDemand} MW  •  Fixed ${fixedSupply} MW  •  Locked ${lockedSupply} MW`;
      if (islandState.remainingEl) {
        islandState.remainingEl.textContent = remaining >= 0
          ? `→ Remaining: ${Math.round(remaining)} MW`
          : `→ Surplus: ${Math.round(-remaining)} MW`;
      }
    }

    // Load rows
    for (const load of loads) {
      const row = document.createElement('div');
      row.className = 'balance-node-row';
      const label = document.createElement('span');
      label.className = 'balance-node-label';
      label.textContent = `📐 ${load.shortId || load.id.slice(-5)} (${load.mw || 0} MW)`;
      const ctrlDiv = document.createElement('div');
      ctrlDiv.className = 'balance-node-controls';
      const slider = document.createElement('input');
      slider.type = 'range';
      slider.className = 'balance-node-slider';
      slider.min = 0;
      slider.max = Math.max(load.mw || 0, 500);
      slider.step = 1;
      slider.value = load.mw || 0;
      const valSpan = document.createElement('span');
      valSpan.className = 'balance-node-value';
      valSpan.textContent = Math.round(slider.value) + ' MW';
      slider.addEventListener('input', () => {
        valSpan.textContent = Math.round(slider.value) + ' MW';
        updateSummary();
      });
      ctrlDiv.appendChild(slider);
      ctrlDiv.appendChild(valSpan);
      row.appendChild(label);
      row.appendChild(ctrlDiv);
      section.appendChild(row);
      islandState.loadEntries.push({ node: load, slider, valSpan });
    }

    // Fixed gens (read-only)
    for (const gen of gens.filter(g => g.mode === 'fixed')) {
      const val = Math.min(gen.dispatchTarget || 0, gen.rating || Infinity);
      const row = document.createElement('div');
      row.className = 'balance-node-row balance-fixed-row';
      row.innerHTML = `<span class="balance-node-label">🔒 ${gen.shortId || gen.id.slice(-5)} <span class="balance-rating">(${gen.rating || 100} MVA)</span></span>
        <div class="balance-node-controls"><span style="color:#888;font-size:12px">fixed @ ${Math.round(val)} MW</span></div>`;
      section.appendChild(row);
      islandState.fixedEntries.push({ node: gen, value: val });
    }

    // Fixed storage (read-only)
    for (const st of storages.filter(s => s.mode === 'fixed')) {
      const val = (st.baselineContract || 0) + (st.fixedTarget || 0);
      const row = document.createElement('div');
      row.className = 'balance-node-row balance-fixed-row';
      row.innerHTML = `<span class="balance-node-label">🔒 ${st.shortId || st.id.slice(-5)} <span class="balance-rating">(${st.dischargeRate || 50} MW)</span></span>
        <div class="balance-node-controls"><span style="color:#888;font-size:12px">fixed @ ${val >= 0 ? '+' : ''}${Math.round(val)} MW</span></div>`;
      section.appendChild(row);
      islandState.fixedEntries.push({ node: st, value: val });
    }

    // Flex gens
    const flexGens = gens.filter(g => g.mode !== 'fixed');
    for (const gen of flexGens) {
      const row = document.createElement('div');
      row.className = 'balance-node-row';
      const label = document.createElement('span');
      label.className = 'balance-node-label';
      label.textContent = `${gen.shortId || gen.id.slice(-5)} <span class="balance-rating">(${gen.rating || 100} MVA)</span>`;
      label.innerHTML = `${gen.shortId || gen.id.slice(-5)} <span class="balance-rating">(${gen.rating || 100} MVA)</span>`;
      const ctrlDiv = document.createElement('div');
      ctrlDiv.className = 'balance-node-controls';
      const lockBtn = document.createElement('button');
      lockBtn.className = 'balance-lock-btn';
      lockBtn.textContent = '🔓';
      let locked = false;
      lockBtn.addEventListener('click', () => {
        locked = !locked;
        lockBtn.textContent = locked ? '🔒' : '🔓';
        lockBtn.classList.toggle('balance-locked', locked);
        updateSummary();
      });
      const slider = document.createElement('input');
      slider.type = 'range';
      slider.className = 'balance-node-slider';
      const maxVal = gen.rating || 100;
      slider.min = 0;
      slider.max = maxVal;
      slider.step = 1;
      slider.value = clamp(origBaselines[gen.id] || 0, 0, maxVal);
      const valSpan = document.createElement('span');
      valSpan.className = 'balance-node-value';
      valSpan.textContent = (Number(slider.value) >= 0 ? '+' : '') + Math.round(slider.value) + ' MW';
      slider.addEventListener('input', () => {
        valSpan.textContent = (Number(slider.value) >= 0 ? '+' : '') + Math.round(slider.value) + ' MW';
      });
      ctrlDiv.appendChild(lockBtn);
      ctrlDiv.appendChild(slider);
      ctrlDiv.appendChild(valSpan);
      row.appendChild(label);
      row.appendChild(ctrlDiv);
      section.appendChild(row);
      islandState.flexGenEntries.push({ node: gen, slider, valSpan, lockBtn, locked: false, maxVal });
    }

    // Flex storage
    const flexStor = storages.filter(s => s.mode !== 'fixed');
    for (const st of flexStor) {
      const soc = st.mw || 0;
      const maxDischarge = st.dischargeRate || 50;
      const maxCharge = st.chargeRate || 50;
      const row = document.createElement('div');
      row.className = 'balance-node-row' + (soc === 0 ? ' balance-empty-row' : '');
      const label = document.createElement('span');
      label.className = 'balance-node-label';
      label.innerHTML = `${st.shortId || st.id.slice(-5)} <span class="balance-rating">(${maxDischarge} MW, SoC ${soc.toFixed(0)} MWh)</span>`;
      const ctrlDiv = document.createElement('div');
      ctrlDiv.className = 'balance-node-controls';
      const lockBtn = document.createElement('button');
      lockBtn.className = 'balance-lock-btn' + (soc === 0 ? ' balance-locked' : '');
      lockBtn.textContent = soc === 0 ? '🔒' : '🔓';
      let locked = soc === 0;
      if (soc > 0) {
        lockBtn.addEventListener('click', () => {
          locked = !locked;
          lockBtn.textContent = locked ? '🔒' : '🔓';
          lockBtn.classList.toggle('balance-locked', locked);
          updateSummary();
        });
      }
      const slider = document.createElement('input');
      slider.type = 'range';
      slider.className = 'balance-node-slider';
      slider.min = -maxCharge;
      slider.max = maxDischarge;
      slider.step = 1;
      const initVal = soc === 0 ? 0 : clamp(origBaselines[st.id] || 0, -maxCharge, maxDischarge);
      slider.value = initVal;
      const valSpan = document.createElement('span');
      valSpan.className = 'balance-node-value';
      valSpan.textContent = (Number(slider.value) >= 0 ? '+' : '') + Math.round(slider.value) + ' MW';
      slider.addEventListener('input', () => {
        valSpan.textContent = (Number(slider.value) >= 0 ? '+' : '') + Math.round(slider.value) + ' MW';
      });
      ctrlDiv.appendChild(lockBtn);
      ctrlDiv.appendChild(slider);
      ctrlDiv.appendChild(valSpan);
      row.appendChild(label);
      row.appendChild(ctrlDiv);
      section.appendChild(row);
      islandState.flexStorEntries.push({ node: st, slider, valSpan, lockBtn, locked, maxDischarge, maxCharge, soc });
    }

    // Island footer: remaining + redistribute
    const footer = document.createElement('div');
    footer.className = 'balance-island-footer';
    const remainingEl = document.createElement('span');
    remainingEl.className = 'balance-remaining';
    islandState.remainingEl = remainingEl;
    const redistributeBtn = document.createElement('button');
    redistributeBtn.className = 'balance-redistribute-btn';
    redistributeBtn.textContent = '🔄 Redistribute';
    redistributeBtn.addEventListener('click', () => {
      // Determine lock state from button classes (not stale object property)
      function isLocked(e) { return e.lockBtn.classList.contains('balance-locked'); }

      // Calculate remaining
      let totalDemand = 0, fixedSupply = 0, lockedSupply = 0;
      for (const e of islandState.loadEntries) totalDemand += Number(e.slider.value);
      for (const e of islandState.fixedEntries) fixedSupply += e.value;
      for (const e of islandState.flexGenEntries) {
        if (isLocked(e)) lockedSupply += Number(e.slider.value);
      }
      for (const e of islandState.flexStorEntries) {
        if (isLocked(e)) lockedSupply += Number(e.slider.value);
      }
      let remaining = totalDemand - fixedSupply - lockedSupply;

      if (remaining > 0) {
        // Distribute across unlocked flex gens + storage
        const unlockedGens = islandState.flexGenEntries.filter(e => !isLocked(e));
        const unlockedStor = islandState.flexStorEntries.filter(e => !isLocked(e) && e.soc > 0);
        const totalGenRating = unlockedGens.reduce((s, e) => s + (e.node.rating || e.maxVal), 0);
        const totalStorRate = unlockedStor.reduce((s, e) => s + e.maxDischarge, 0);
        const totalFlex = totalGenRating + totalStorRate;

        if (totalFlex > 0) {
          for (const e of unlockedGens) {
            const share = (e.node.rating || e.maxVal) / totalFlex;
            const val = clamp(Math.round(remaining * share), 0, e.maxVal);
            e.slider.value = val;
            e.valSpan.textContent = '+' + val + ' MW';
          }
          for (const e of unlockedStor) {
            const share = e.maxDischarge / totalFlex;
            const val = clamp(Math.round(remaining * share), 0, e.maxDischarge);
            e.slider.value = val;
            e.valSpan.textContent = '+' + val + ' MW';
          }
          // Redistribute shortfall from storage caps to gens
          const newLocked = islandState.flexGenEntries.filter(e => isLocked(e)).reduce((s, e) => s + Number(e.slider.value), 0);
          const newUnlockedGen = unlockedGens.reduce((s, e) => s + Number(e.slider.value), 0);
          const newUnlockedStor = unlockedStor.reduce((s, e) => s + Number(e.slider.value), 0);
          const totalAfter = fixedSupply + newLocked + newUnlockedGen + newUnlockedStor;
          let shortfall = totalDemand - totalAfter;
          if (shortfall > 1 && unlockedGens.length > 0) {
            const remainingRating = unlockedGens.reduce((s, e) => s + (e.node.rating || e.maxVal), 0);
            if (remainingRating > 0) {
              for (const e of unlockedGens) {
                const share = (e.node.rating || e.maxVal) / remainingRating;
                const add = clamp(Math.round(shortfall * share), 0, e.maxVal - Number(e.slider.value));
                const newVal = Number(e.slider.value) + add;
                e.slider.value = newVal;
                e.valSpan.textContent = '+' + newVal + ' MW';
              }
            }
          }
        }
      } else if (remaining < 0) {
        // Surplus: zero unlocked gens, distribute charge across unlocked storage
        for (const e of islandState.flexGenEntries) {
          if (!isLocked(e)) {
            e.slider.value = 0;
            e.valSpan.textContent = '+0 MW';
          }
        }
        const unlockedStor = islandState.flexStorEntries.filter(e => !isLocked(e));
        const surplus = -remaining;
        const totalCharge = unlockedStor.reduce((s, e) => s + e.maxCharge, 0);
        if (totalCharge > 0) {
          for (const e of unlockedStor) {
            const share = e.maxCharge / totalCharge;
            const val = clamp(-Math.round(surplus * share), -e.maxCharge, 0);
            e.slider.value = val;
            e.valSpan.textContent = Math.round(val) + ' MW';
          }
        }
      }
      updateSummary();
    });

    footer.appendChild(remainingEl);
    footer.appendChild(redistributeBtn);
    section.appendChild(footer);

    bodyEl.appendChild(section);
    islandStates.push(islandState);

    // Initial summary
    updateSummary();
  }

  // Apply handler
  applyBtn.addEventListener('click', () => {
    // Reset trips, shedding, frequencies
    for (const gen of state.nodes.filter(n => n.type === 'generator')) {
      gen.agcOffset = 0;
      gen.tripped = false;
      gen.freqTimer = 0;
    }
    for (const st of state.nodes.filter(n => n.type === 'storage')) {
      st.mwResponse = st.baselineContract || 0;
      st.agcOffset = 0;
      st.tripped = false;
    }
    for (const c of state.connections) { c.tripped = false; c.tripTimer = 0; }
    for (const load of state.nodes.filter(n => n.type === 'load')) {
      load.shedPct = 0;
    }
    for (const net of nets) {
      net.freq = 50;
      net.freqPrev = 50;
    }

    // Apply modal values
    for (const is of islandStates) {
      for (const e of is.loadEntries) {
        const val = Number(e.slider.value);
        e.node.mw = val;
        e.node.baseMw = val;
      }
      for (const e of is.flexGenEntries) {
        const val = Number(e.slider.value);
        e.node.baselineContract = val;
        e.node.mw = val;
      }
      for (const e of is.flexStorEntries) {
        const val = Number(e.slider.value);
        e.node.baselineContract = val;
        e.node.mwResponse = val;
      }
    }

    recomputeNetworks();
    persist();
    draw();
    updateControls();
    updateStatsPanel();

    // Update open settings panels
    for (const nodeId of Object.keys(openPanels)) {
      const entry = openPanels[nodeId];
      const st = state.nodes.find(n => n.id === nodeId && n.type === 'storage');
      if (st && entry.bcSlider && entry.bcVal) {
        entry.bcSlider.value = st.baselineContract || 0;
        entry.bcVal.textContent = (st.baselineContract || 0) >= 0
          ? '+' + Math.round(st.baselineContract || 0) + ' MW'
          : Math.round(st.baselineContract || 0) + ' MW';
      }
      const gen = state.nodes.find(n => n.id === nodeId && n.type === 'generator');
      if (gen && entry.bcSlider && entry.bcVal) {
        entry.bcSlider.value = gen.baselineContract || 0;
        entry.bcVal.textContent = '+' + Math.round(gen.baselineContract || 0) + ' MW';
      }
    }

    document.body.removeChild(overlay);
  });

  // Cancel handler — restore originals
  cancelBtn.addEventListener('click', () => {
    for (const n of state.nodes) {
      if (n.type === 'generator') {
        n.baselineContract = origBaselines[n.id] || 0;
        n.mw = origMw[n.id] || 0;
        n.shedPct = origShed[n.id] || 0;
      } else if (n.type === 'storage') {
        n.baselineContract = origBaselines[n.id] || 0;
      } else if (n.type === 'load') {
        n.mw = origMw[n.id] || 0;
        n.shedPct = origShed[n.id] || 0;
        if (n.baseMw) n.baseMw = n.mw;
      }
    }
    for (const c of state.connections) c.tripped = origConnTripped[c.id] || false;
    for (const net of nets) { net.freq = origNetsFreq[net.id] || 50; net.freqPrev = origNetsFreq[net.id] || 50; }
    recomputeNetworks();
    persist();
    draw();
    updateControls();
    updateStatsPanel();
    document.body.removeChild(overlay);
  });

  // Click outside modal closes it
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) {
      cancelBtn.click();
    }
  });
}

// ─── Init ──────────────────────────────────────────────

async function init() {
  await load();
  balanceGrid();
  resizeCanvas();
  draw();
  updateControls();
  updateStatsPanel();
}

window.addEventListener('resize', resizeCanvas);
init();
