import { state, sim } from './state.js';
import { recomputeNetworks } from './simulation.js';

// ─── ID ────────────────────────────────────────────────────────────────

let idCounter = Date.now();

export function uid() { return 'n' + (idCounter++).toString(36); }

export function shortId(type) {
  const prefix = { generator: 'G', load: 'L', storage: 'S', junction: 'J' }[type] || 'N';
  const digits = Math.floor(Math.random() * 900) + 100;
  const letter = String.fromCharCode(65 + Math.floor(Math.random() * 26));
  return `${prefix}-${digits}${letter}`;
}

// ─── Snapshot ──────────────────────────────────────────────────────────

export async function saveSnapshot() {
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

// ─── Persistence ───────────────────────────────────────────────────────

export async function persist() {
  try { await fetch('/api/grid', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nodes: state.nodes, connections: state.connections, view: state.view }) }); }
  catch (e) { console.error('Persist failed:', e); }
}

export async function load() {
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
