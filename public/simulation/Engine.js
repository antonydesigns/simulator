// ─── SimulationEngine ────────────────────────────────────────────

export class SimulationEngine {
  constructor(store, callbacks) {
    this.onPersist = () => {};
    this.store = store;
    this.callbacks = callbacks;
  }

  recomputeNetworks() {
    const { state, sim } = this.store;
    const { draw, updateControls, updateStatsPanel } = this.callbacks;

    state.networks = this.findNetworks();
    for (const net of state.networks) {
      if (net.freqPrev === undefined) net.freqPrev = net.freq || 50;
    }
  }

  demandCurve(t) {
    const { state, sim } = this.store;
    const { draw, updateControls, updateStatsPanel } = this.callbacks;

    const day = 86400;
    const week = 7 * day;
    const tod = (((t % day) / day) * 24 + 24) % 24; // hour of day (0-24)
    const dow = Math.floor((t % week) / day); // day of week (0-6, Mon=0)

    // Daily shape: valley ~4AM, morning peak ~10AM, afternoon peak ~4-6PM
    let daily = 0.5 - 0.45 * Math.cos(((tod - 4) / 24) * 2 * Math.PI);
    // Morning bump (~10AM)
    daily += 0.15 * Math.exp(-Math.pow((tod - 10) / 1.5, 2));
    // Lunch recovery bump
    daily += 0.05 * Math.exp(-Math.pow((tod - 14) / 2, 2));
    daily = Math.max(0, Math.min(1, daily));

    // Weekly: weekends (Sat=5, Sun=6) 15% lower
    const weekend = dow === 5 || dow === 6 ? 0.85 : 1;
    return daily * weekend;
  }

  dispatchMeritOrder(topUpBalancing = false, writeMw = false, network = null) {
    const { state, sim } = this.store;
    const { draw, updateControls, updateStatsPanel } = this.callbacks;

    // Scope to a specific network's nodes when provided
    const netIds = network ? network.nodeIds : null;
    const inNet = (n) => !netIds || (netIds.has(n.id));

    const allGens = state.nodes.filter(
      (n) => n.type === "generator" && !n.tripped && inNet(n),
    );
    // Reset baselines for merchant + balancing gens (fixed keeps user-set baseline, load-follow gets set by dispatch)
    for (const gen of allGens) {
      if (gen.mode !== "fixed") gen.baselineContract = 0;
    }
    // Reset merchant storage baselines too
    const allStorages = state.nodes.filter(
      (n) => n.type === "storage" && !n.tripped && n.mode === "merchant" && inNet(n)
    );
    for (const st of allStorages) {
      st.baselineContract = 0;
    }

    const loadTotal = state.nodes
      .filter((n) => n.type === "load" && inNet(n))
      .reduce((s, l) => s + (l.mw || 0), 0);
    // Add charging demand from merchant storage with active buy contracts
    const patSec2 = sim.simTime * 720;
    const tod2 = ((patSec2 % 86400) / 86400) * 24;
    const stChargeDemand = allStorages
      .filter((st) => {
        const trigger = st.buyTrigger || "off";
        if (trigger === "off") return false;
        const buyByPrice = (trigger === "price" || trigger === "both") && (state.smp != null) && state.smp <= (st.buyPrice || 20);
        let buyByTime = false;
        if (trigger === "time" || trigger === "both") {
          const start = st.buyStartHour || 3;
          const dur = st.buyDuration || 4;
          if (dur > 0) {
            if (start + dur <= 24) buyByTime = tod2 >= start && tod2 < start + dur;
            else buyByTime = tod2 >= start || tod2 < ((start + dur) % 24);
          }
        }
        return buyByPrice || buyByTime;
      })
      .reduce((s, st) => s + Math.max(0, -(st.mwResponse || 0)), 0);
    const totalLoad = loadTotal + stChargeDemand;
    let remaining = totalLoad;
    let smp = 0;

    // --- Step 1: Fixed gens (must-run at baselineContract) ---
    for (const gen of allGens) {
      if (gen.mode === "fixed") {
        const alloc = Math.min(gen.baselineContract || 0, gen.rating || Infinity);
        gen.baselineContract = alloc;
        if (writeMw) gen.mw = alloc;
        remaining -= alloc;
      }
    }

    // --- Step 2: Load-follow gens (proportional by rating) ---
    const lfGens = allGens.filter(g => g.mode === "load-follow");
    if (lfGens.length > 0 && remaining > 0) {
      const totalLfRating = lfGens.reduce((s, g) => s + (g.rating || 100), 0);
      for (const gen of lfGens) {
        const share = (gen.rating || 100) / totalLfRating;
        const alloc = Math.round(remaining * share * 10) / 10;
        gen.baselineContract = Math.min(alloc, gen.rating || Infinity);
        if (writeMw) gen.mw = gen.baselineContract;
      }
      // Recompute remaining from actual allocations
      const lfTotal = lfGens.reduce((s, g) => s + (g.baselineContract || 0), 0);
      remaining -= lfTotal;
    }

    // Build merit order: non-fixed gens + merchant storage with sell triggers
    const bids = [];
    // Generator bids
    for (const gen of allGens) {
      if (gen.mode === "fixed" || gen.mode === "load-follow") continue;
      bids.push({
        node: gen,
        price: gen.bidPrice || 50,
        qty: gen.bidQty || gen.rating || 100,
      });
    }
    // Storage sell bids (merchant mode)
    const patSec = sim.simTime * 720;
    const tod = ((patSec % 86400) / 86400) * 24;
    for (const st of allStorages) {
      if (st.sellTrigger === "off") continue;
      // Check time window for time-based triggers
      if (st.sellTrigger === "time" || st.sellTrigger === "both") {
        const start = st.sellStartHour || 17;
        const dur = st.sellDuration || 4;
        let inWindow = false;
        if (dur > 0) {
          if (start + dur <= 24) inWindow = tod >= start && tod < start + dur;
          else inWindow = tod >= start || tod < ((start + dur) % 24);
        }
        if (st.sellTrigger === "time" && !inWindow) continue;
        if (st.sellTrigger === "both" && !inWindow) continue;
      }
      const dr = st.dischargeRate || 50;
      const soc = st.mw || 0;
      if (soc <= 0) continue;
      const qty = dr;
      bids.push({ node: st, price: st.sellPrice || 50, qty });
    }
    // Sort by price (cheapest first)
    bids.sort((a, b) => a.price - b.price);

    // Remaining load goes to bid-based market units
    let marketRemaining = Math.max(0, remaining);

    for (const bid of bids) {
      const dispatch = Math.min(marketRemaining, bid.qty);
      bid.node.baselineContract = Math.max(0, dispatch);
      if (writeMw && bid.node.type === "generator") bid.node.mw = dispatch;
      marketRemaining -= dispatch;
      if (dispatch > 0) smp = bid.price;
    }

    // Scarcity price = highest bid in the market
    const maxBidPrice = bids.length > 0 ? bids.reduce((m, b) => Math.max(m, b.price), 0) : 0;
    state.smp = marketRemaining <= 0 ? smp : maxBidPrice;

    // Track marginal generators (those at SMP price) for AGC scope
    state.marginalGenIds = new Set();
    if (marketRemaining <= 0) {
      for (const bid of bids) {
        if (bid.node.type === "generator" && (bid.node.baselineContract || 0) > 0 && bid.price === smp) {
          state.marginalGenIds.add(bid.node.id);
        }
      }
    }
    // Under scarcity, marginalGenIds stays empty — AGC falls back to all balancing gens

    // Reset AGC offsets for merchant gens only (load-follow + balancing keep their accumulated offset)
    for (const gen of allGens) {
      if (gen.mode === "merchant") gen.agcOffset = 0;
    }
    for (const st of allStorages) st.agcOffset = 0;
    // Reset balancing storages too (not in merchant scope)
    for (const st of state.nodes.filter(n => n.type === "storage" && !n.tripped && n.mode === "balancing" && inNet(n))) st.agcOffset = 0;

    state.marketLoad = marketRemaining;
  }

  simTick() {
    const { state, sim, openPanels, freqChartVisible, meritChartVisible } =
      this.store;
    const {
      draw,
      updateControls,
      updateStatsPanel,
      drawFreqChart,
      drawMeritOrderChart,
    } = this.callbacks;

    this.recomputeNetworks();
    // === Market dispatch (once per tick, scoped to main grid) ===
    const mainNet = state.networks.find(net => {
      const netNodes = [...net.nodeIds]
        .map(id => state.nodes.find(n => n.id === id))
        .filter(Boolean);
      return netNodes.some(n => n.type === "load");
    });
    const patSec = sim.simTime * 720;
    if (mainNet && patSec - (sim.lastMarketPat || 0) >= 900) {
      sim.lastMarketPat = patSec;
      this.dispatchMeritOrder(true, false, mainNet);
      if (meritChartVisible) drawMeritOrderChart();
    }
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
      const netNodes = [...net.nodeIds]
        .map((id) => state.nodes.find((n) => n.id === id))
        .filter(Boolean);
      const allGens = netNodes.filter((n) => n.type === "generator");
      const gens = allGens.filter((g) => !g.tripped);
      const loads = netNodes.filter((n) => n.type === "load");
      const allStorages = netNodes.filter((n) => n.type === "storage");
      const storages = allStorages.filter((s) => !s.tripped);

      if (gens.length === 0 && loads.length === 0 && allStorages.length === 0)
        continue;

      // --- Auto Demand Curve (noise) ---
      for (const load of loads) {
        if (load.noiseEnabled) {
          const patSec = sim.simTime * 720;
          const weekSec = 7 * 86400;
          const currentPattern = Math.floor(patSec / weekSec);
          // Detect pattern boundary and apply demand growth
          if (load._lastPattern === undefined) load._lastPattern = currentPattern;
          if (currentPattern > load._lastPattern) {
            const growth = (load.demandGrowthPct || 0) / 100;
            if (growth > 0) {
              load.noiseMin = Math.round((load.noiseMin || 100) * (1 + growth));
              load.noiseMax = Math.round((load.noiseMax || 200) * (1 + growth));
            }
            load._lastPattern = currentPattern;
          }
          const mult = this.demandCurve(patSec);
          const noisePct = (load.noisePct || 10) / 100;
          const step = noisePct * 0.04;
          load._noiseDrift =
            (load._noiseDrift || 0) + (Math.random() - 0.5) * step;
          load._noiseDrift = Math.max(
            -noisePct,
            Math.min(noisePct, load._noiseDrift),
          );
          load.mw = Math.round(
            (load.noiseMin || 100) +
              ((load.noiseMax || 200) - (load.noiseMin || 100)) *
                mult *
                (1 + load._noiseDrift),
          );
          load.baseMw = load.mw;
        }
      }



      const totalGen = gens.reduce((s, g) => s + (g.mw || 0), 0);
      const totalLoad = loads.reduce((s, l) => s + (l.mw || 0), 0);

      // --- Handle stranded island types ---
      const hasGen = gens.length > 0,
        hasLoad = loads.length > 0,
        hasStor = storages.length > 0;
      const hasEffectiveStor = storages.some(
        (s) =>
          (s.mw || 0) > 0.5 &&
          s.mode !== "fixed" &&
          (s.dischargeRate || 50) > 0,
      );
      if (hasGen && !hasLoad && !hasStor) {
        for (const gen of gens) gen.mw = 0;
        for (const c of state.connections)
          if (net.nodeIds.has(c.sourceId) && net.nodeIds.has(c.targetId)) {
            c.mw = 0;
            c.loadingPct = 0;
          }
        net.freq = f0;
        continue;
      }
      if (!hasGen && !hasEffectiveStor && hasLoad) {
        for (const load of loads) {
          load._preBlackoutBaseMw =
            load._preBlackoutBaseMw || load.baseMw || load.mw || 0;
          load.mw = 0;
          state.strandedLoadIds.add(load.id);
        }
        for (const c of state.connections)
          if (net.nodeIds.has(c.sourceId) && net.nodeIds.has(c.targetId)) {
            c.mw = 0;
            c.loadingPct = 0;
          }
        net.freq = f0;
        continue;
      }
      if (!hasGen && !hasLoad && hasStor) {
        for (const st of storages) {
          st.mwResponse = 0;
        }
        for (const c of state.connections)
          if (net.nodeIds.has(c.sourceId) && net.nodeIds.has(c.targetId)) {
            c.mw = 0;
            c.loadingPct = 0;
          }
        net.freq = f0;
        continue;
      }
      if (hasGen && !hasLoad && hasStor) {
        for (const gen of gens) gen.mw = 0;
        for (const st of storages) st.mwResponse = 0;
        for (const c of state.connections)
          if (net.nodeIds.has(c.sourceId) && net.nodeIds.has(c.targetId)) {
            c.mw = 0;
            c.loadingPct = 0;
          }
        net.freq = f0;
        continue;
      }

      // Note: stranded loads within mixed islands are zeroed after the stranded detection step, below

      // --- Black Start logic ---
      if (net.blackStart) {
        const bs = net.blackStart;
        const bsDt = dt;
        bs.progress = Math.min(1, bs.progress + bsDt / bs.duration);

        if (bs.phase === "gfs-only") {
          if (bs.progress >= 0.15) {
            bs.phase = "gen-restart";
            const islandGens = allGens.filter((g) => g.type === "generator");
            bs.genOrder = islandGens
              .map((g) => ({ id: g.id, tc: g.turbineTimeConstant || 1 }))
              .sort((a, b) => a.tc - b.tc);
            bs.genRampStartProgress = 0.15;
          }
        }

        if (bs.phase === "gen-restart") {
          const rampProgress = Math.min(1, (bs.progress - 0.15) / 0.85);
          const totalRating =
            allGens.reduce((s, g) => s + (g.rating || 100), 0) || 1;

          for (const load of loads) {
            const baseMw =
              load._preBlackoutBaseMw || load.baseMw || load.mw || 0;
            load.mw = Math.round(baseMw * rampProgress);
            load.shedPct = Math.max(0, 1 - rampProgress);
          }

          const totalLoad = loads.reduce((s, l) => s + (l.mw || 0), 0);
          for (let i = 0; i < bs.genOrder.length; i++) {
            const ge = bs.genOrder[i];
            const gen = allGens.find((g) => g.id === ge.id);
            if (!gen) continue;
            const genStartPct = i / bs.genOrder.length;
            if (rampProgress >= genStartPct) {
              if (gen.tripped) {
                gen.tripped = false;
                gen.mw = 0;
                gen.freqTimer = 0;
                gen.agcOffset = 0;
              }
              const genLocalPct = Math.min(
                1,
                (rampProgress - genStartPct) / (1 / bs.genOrder.length),
              );
              const share = (gen.rating || 100) / totalRating;
              const rampMw = Math.round(share * totalLoad * genLocalPct);
              gen.baselineContract = rampMw;
              gen.agcOffset = 0;
              gen.mw = rampMw;
            }
          }

          for (const gen of allGens) {
            if (gen.tripped) continue;
            if (gen._preBlackStartMode === undefined) {
              gen._preBlackStartMode = gen.mode;
            }
            gen.mode = "fixed";
          }

          if (rampProgress >= 1.0) {
            bs.phase = "handover";
            bs.handoverTimer = 0;
          }
        }

        if (bs.phase === "handover") {
          bs.handoverTimer += dt;
          if (bs.handoverTimer >= 2.0) {
            for (const gen of allGens) {
              if (gen._preBlackStartMode) {
                gen.mode = gen._preBlackStartMode;
                delete gen._preBlackStartMode;
              }
              gen.baselineContract = gen.mw || 0;
              gen.agcOffset = 0;
            }
            for (const load of loads) {
              load.shedPct = 0;
              delete load._preBlackoutBaseMw;
            }
            sim.lastMarketPat = Math.floor(sim.simTime * 720);
            state.blackStartNets.delete(net.id);
            delete net.blackStart;
            sim.events.push({
              t: (sim.dataBuffer.length || 0) * 0.25,
              type: "blackstart-complete",
              netId: net.id,
            });
          }
        }
      }

      // --- Physics sub-step loop (smooth at any sim speed) ---
      {
        const physicsSteps = Math.max(1, Math.ceil(dt / 0.05));
        const physicsDt = dt / physicsSteps;
        const subFreqRef = { value: net.freq }; // mutable ref for sub-step freq
        for (let _p = 0; _p < physicsSteps; _p++) {
          const subFreq = subFreqRef.value;

          // --- Step 1: Governor droop + baseline + AGC offset ---
          for (const gen of gens) {
            if (gen.tripped) {
              gen.mw = 0;
              continue;
            }
            let totalTarget;
            if (gen.mode === "merchant") {
              totalTarget = (gen.baselineContract || 0);
            } else if (gen.mode === "fixed") {
              totalTarget = (gen.baselineContract || 0);
            } else if (gen.mode === "fcr-only") {
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
              totalTarget =
                (gen.baselineContract || 0) + govMod + (gen.agcOffset || 0);
            }
            const genRating = gen.rating || Infinity;
            totalTarget = Math.max(0, Math.min(genRating, totalTarget));
            const current = gen.mw || 0;
            const T =
              totalTarget < current
                ? gen.rampDownTC || 0.3
                : gen.turbineTimeConstant || 1;
            gen.mw = current + ((totalTarget - current) * physicsDt) / T;
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

const rampUpTC = st.rampUpTC || 0.1;
              const rampDownTC = st.rampDownTC || 0.1;

            if (st.mode === "balancing") {
              const droop = st.droop || 0.04;
              const dev = (subFreq - f0) / f0;
              const effectiveRating = dr;
              const govMod = -(1 / droop) * dev * effectiveRating;
              let target = bc + govMod + (st.agcOffset || 0);
              target = Math.max(-cr, Math.min(dr, target));
              target = Math.max(-maxChargeP, Math.min(maxDischargeP, target));
              const prevResp = st.mwResponse || 0;
              const rt = target >= prevResp ? rampUpTC : rampDownTC;
              st.mwResponse =
                prevResp + (target - prevResp) * Math.min(1, physicsDt / rt);
            } else if (st.mode === "fcr-only") {
              const droop = st.droop || 0.04;
              const dev = (subFreq - f0) / f0;
              const govMod = -(1 / droop) * dev * dr;
              let target = bc + govMod;
              target = Math.max(-cr, Math.min(dr, target));
              target = Math.max(-maxChargeP, Math.min(maxDischargeP, target));
              const prevResp = st.mwResponse || 0;
              const rt = target >= prevResp ? rampUpTC : rampDownTC;
              st.mwResponse =
                prevResp + (target - prevResp) * Math.min(1, physicsDt / rt);
            } else if (st.mode === "grid-forming") {
              const droop = st.droop || 0.04;
              const dev = (subFreq - f0) / f0;
              const govMod = -(1 / droop) * dev * dr;
              st.freqRestore =
                (st.freqRestore || 0) + 5 * (f0 - subFreq) * physicsDt;
              st.freqRestore = Math.max(-dr, Math.min(dr, st.freqRestore));
              let target = bc + govMod + st.freqRestore;
              target = Math.max(-cr, Math.min(dr, target));
              target = Math.max(-maxChargeP, Math.min(maxDischargeP, target));
              const prevResp = st.mwResponse || 0;
              const rt = target >= prevResp ? rampUpTC : rampDownTC;
              st.mwResponse =
                prevResp + (target - prevResp) * Math.min(1, physicsDt / rt);
            } else if (st.mode === "fixed") {
              let target = bc + (st.fixedTarget || 0);
              target = Math.max(-cr, Math.min(dr, target));
              target = Math.max(-maxChargeP, Math.min(maxDischargeP, target));
              const prevResp = st.mwResponse || 0;
              const rt = target >= prevResp ? rampUpTC : rampDownTC;
              st.mwResponse =
                prevResp + (target - prevResp) * Math.min(1, physicsDt / rt);
            } else if (st.mode === "merchant") {
              const smp = this.store.state.smp;
              const patSec = sim.simTime * 720;
              const tod = ((patSec % 86400) / 86400) * 24;
              // Sell contract: dispatched by merit order (baselineContract)
              const sellDispatch = Math.max(0, st.baselineContract || 0);
              // Buy contract: real-time check
              let buyActive = false;
              const stBuy = st.buyTrigger || "off";
              if (stBuy !== "off") {
                const buyByPrice = (stBuy === "price" || stBuy === "both") && smp !== null && smp <= (st.buyPrice || 20);
                let buyByTime = false;
                if (stBuy === "time" || stBuy === "both") {
                  const start = st.buyStartHour || 3;
                  const dur = st.buyDuration || 4;
                  if (dur > 0) {
                    if (start + dur <= 24) buyByTime = tod >= start && tod < start + dur;
                    else buyByTime = tod >= start || tod < ((start + dur) % 24);
                  }
                }
                buyActive = buyByPrice || buyByTime;
              }
              let target = 0;
              if (sellDispatch > 0) target += sellDispatch;
              else if (buyActive) target -= cr;
              target = Math.max(-cr, Math.min(dr, target));
              target = Math.max(-maxChargeP, Math.min(maxDischargeP, target));
              const prevResp = st.mwResponse || 0;
              const rt = target >= prevResp ? rampUpTC : rampDownTC;
              st.mwResponse = prevResp + (target - prevResp) * Math.min(1, physicsDt / rt);
            }
            st.mw = Math.max(
              0,
              Math.min(cap, soc - (st.mwResponse * physicsDt) / 3600),
            );
          }

          const subTotalGen = gens.reduce((s, g) => s + (g.mw || 0), 0);
          const subTotalLoad = loads.reduce((s, l) => s + (l.mw || 0), 0);
          const totalStorage = storages.reduce(
            (s, st) => s + (st.mwResponse || 0),
            0,
          );
          const imbalance = subTotalGen + totalStorage - subTotalLoad;

          // --- Step 3: Swing equation ---
          if (gens.length > 0) {
            net.freqPrev = net.freq;
            let totalInertiaEnergy = 0;
            for (const gen of gens)
              totalInertiaEnergy += (gen.inertia || 5) * (gen.rating || 100);
            let dfdt = 0;
            if (totalInertiaEnergy > 0)
              dfdt = (imbalance * f0) / (2 * totalInertiaEnergy);
            subFreqRef.value = Math.max(
              45,
              Math.min(55, subFreq + dfdt * physicsDt),
            );
          } else if (storages.length > 0) {
            net.freqPrev = net.freq;
            const stoInertia = storages.reduce(
              (s, st) => s + (st.dischargeRate || 500) * 3,
              0,
            );
            let dfdt = stoInertia > 0 ? (imbalance * f0) / (2 * stoInertia) : 0;
            subFreqRef.value = Math.max(
              45,
              Math.min(55, subFreq + dfdt * physicsDt),
            );
          } else {
            net.freqPrev = net.freq;
            subFreqRef.value = Math.max(0, subFreq - 10 * physicsDt);
          }

          // --- Settling grace period ---
          if ((sim.settlingTimer || 0) > 0) {
            sim.settlingTimer = Math.max(0, sim.settlingTimer - physicsDt);
          }
          const settling = (sim.settlingTimer || 0) > 0;
          const tripHigh = settling ? 54 : 52;
          const tripLow = settling ? 46 : 48;

          // --- Step 4: Generator frequency protection ---
          for (const gen of allGens) {
            if (gen.tripped) continue;
            if (subFreqRef.value > tripHigh || subFreqRef.value < tripLow) {
              gen.freqTimer = (gen.freqTimer || 0) + physicsDt;
              if (gen.freqTimer >= 1) {
                gen.tripped = true;
                gen.mw = 0;
                const cause =
                  subFreqRef.value > tripHigh ? "overspeed" : "underfrequency";
                sim.events.push({
                  t: (sim.dataBuffer.length || 0) * 0.25,
                  type: "gen-trip",
                  nodeId: gen.id,
                  freq: subFreqRef.value,
                  cause,
                });
              }
            } else {
              gen.freqTimer = 0;
            }
          }

          // --- Step 4b: Storage frequency protection ---
          for (const st of storages) {
            if (st.tripped || st.mode === "grid-forming") continue;
            if (subFreqRef.value > tripHigh || subFreqRef.value < tripLow) {
              st.freqTimer = (st.freqTimer || 0) + physicsDt;
              if (st.freqTimer >= 1) {
                st.tripped = true;
                st.mwResponse = 0;
                sim.events.push({
                  t: (sim.dataBuffer.length || 0) * 0.25,
                  type: "storage-trip",
                  nodeId: st.id,
                  freq: subFreqRef.value,
                  cause:
                    subFreqRef.value > tripHigh ? "overfrequency" : "underfrequency",
                });
              }
            } else {
              st.freqTimer = 0;
            }
          }

          // --- Step 5: DC Power Flow ---
          if (hasLoad)
            this.solveDCPowerFlow(net, state.nodes, state.connections);

          // --- Step 6: Line Overload / trip logic ---
          const tripCurve = [
            { limit: 200, time: 0.5 },
            { limit: 150, time: 1 },
            { limit: 120, time: 5 },
            { limit: 100, time: Infinity },
          ];
          const netConns = state.connections.filter(
            (c) => net.nodeIds.has(c.sourceId) && net.nodeIds.has(c.targetId),
          );
          for (const c of netConns) {
            if (c.tripped) continue;
            const pct = c.loadingPct || 0;
            if (pct > 100) {
              let tripTime = 0;
              for (const tc of tripCurve) {
                if (pct >= tc.limit) {
                  tripTime = tc.time;
                  break;
                }
              }
              if (tripTime > 0) {
                c.tripTimer = (c.tripTimer || 0) + physicsDt;
                if (c.tripTimer >= tripTime) {
                  c.tripped = true;
                  c.tripTimer = tripTime;
                  sim.events.push({
                    t: (sim.dataBuffer.length || 0) * 0.25,
                    type: "line-trip",
                    lineId: c.id,
                    loading: pct,
                    flow: c.mw,
                  });
                }
              }
            } else {
              c.tripTimer = 0;
            }
          }

          // --- Step 7: Under-Frequency Load Shedding (UFLS) ---
          // Auto-shed on underfrequency, auto-restore when freq stable at 49.5+ Hz for 5s
          if (hasLoad) {
            for (const load of loads) {
              if (load.baseMw === undefined) load.baseMw = load.mw || 0;
              const f = subFreqRef.value;
              let targetShed = 0;
              if (f < 48.0) targetShed = 0.5;
              else if (f < 48.3) targetShed = 0.4;
              else if (f < 48.5) targetShed = 0.3;
              else if (f < 48.7) targetShed = 0.2;
              else if (f < 49.0) targetShed = 0.1;
              const deadband = 0.05;
              // Apply shedding only when underfrequency
              if (f < 50.0 - deadband) {
                load.shedTimer = 0; // reset restoration timer
                load.shedPct = Math.max(load.shedPct || 0, targetShed);
                load.mw = Math.round(load.baseMw * (1 - (load.shedPct || 0)));
              } else {
                // Auto-restoration: restore slowly when freq stable at 49.5+ Hz for 5s
                if ((load.shedPct || 0) > 0) {
                  if (f >= 49.5) {
                    load.shedTimer = (load.shedTimer || 0) + physicsDt;
                    if (load.shedTimer >= 5.0) {
                      load.shedPct = Math.max(0, (load.shedPct || 0) - 0.05 * physicsDt);
                    }
                  } else {
                    load.shedTimer = 0;
                  }
                  load.mw = Math.round(load.baseMw * (1 - (load.shedPct || 0)));
                } else {
                  load.shedTimer = 0;
                  load.mw = Math.round(load.baseMw);
                }
              }
            }
          }
          // --- Step 7b: Blackout load shedding (grid-forming headroom) ---
          if (hasLoad && !hasGen) {
            const gfStorages = storages.filter(
              (s) => s.mode === "grid-forming",
            );
            if (gfStorages.length > 0) {
              const gfCapacity = gfStorages.reduce(
                (s, st) => s + (st.dischargeRate || 500),
                0,
              );
              const targetLoad = gfCapacity * 0.5;
              const currentLoad = loads.reduce((s, l) => s + (l.mw || 0), 0);
              if (currentLoad > targetLoad) {
                const scale = targetLoad / currentLoad;
                for (const load of loads) {
                  const newMw = (load.mw || 0) * scale;
                  load.shedPct = Math.max(
                    load.shedPct || 0,
                    1 - newMw / (load.baseMw || load.mw),
                  );
                  load.mw = newMw;
                }
              }
            }
          }

          // --- Step 8: AGC (gens) ---
          const balancingGens = gens.filter((g) =>
            (g.mode === "balancing" && (state.marginalGenIds.size === 0 || state.marginalGenIds.has(g.id))) ||
            g.mode === "load-follow"
          );
          // Decay agcOffset of non-marginal balancing gens (unconditional)
          if (state.marginalGenIds) {
            for (const gen of gens) {
              if (gen.mode !== "balancing") continue;
              if (state.marginalGenIds.has(gen.id)) continue;
              if (!gen.agcOffset) continue;
              gen.agcOffset *= Math.exp(-physicsDt / 20);
              if (Math.abs(gen.agcOffset) < 0.001) gen.agcOffset = 0;
            }
          }
          const freqErr = f0 - subFreqRef.value;
          if (balancingGens.length > 0) {
            const agcRateLimit = 5;
            const maxDelta = agcRateLimit * physicsDt;
            const totalAgc = 50 * freqErr * physicsDt;

            for (const gen of balancingGens) {
              const rating = gen.rating || 100;
              const bc = gen.baselineContract || 0;
              const fcr = gen.fcrHeadroom || 10;
              let headroom;
              if (freqErr >= 0) {
                // Need upward correction (deficit) — share of upward headroom from actual output
                headroom = Math.max(0, rating - (gen.mw || 0) - fcr);
              } else {
                // Need downward correction (surplus) — share of downward headroom from actual output
                headroom = Math.max(0, (gen.mw || 0) - fcr);
              }
              if (headroom <= 0) continue;

              // Total headroom in the needed direction
              const totalDirHeadroom = balancingGens.reduce((s, g) => {
                const r = g.rating || 100;
                const m = g.mw || 0;
                const c = g.fcrHeadroom || 10;
                return (
                  s +
                  (freqErr >= 0 ? Math.max(0, r - m - c) : Math.max(0, m - c))
                );
              }, 0);
              if (totalDirHeadroom <= 0) continue;

              const share = headroom / totalDirHeadroom;
              const agcDelta = totalAgc * share;
              const clamped = Math.max(-maxDelta, Math.min(maxDelta, agcDelta));
              if (Math.abs(clamped) > 0.0001) {
                gen.agcOffset = (gen.agcOffset || 0) + clamped;
                gen.agcOffset = Math.max(
                  -bc,
                  Math.min(rating - bc, gen.agcOffset),
                );
              }
            }
          }

          // --- Step 8b: AGC (storage) ---
          const balancingStorages = storages.filter(
            (s) =>
              s.mode === "balancing" &&
              !s.energyNeutral &&
              (s.dischargeRate || 500) > 0,
          );
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
                const clamped = Math.max(
                  -maxDelta,
                  Math.min(maxDelta, agcDelta),
                );
                if (Math.abs(clamped) > 0.0001) {
                  st.agcOffset = (st.agcOffset || 0) + clamped;
                  const maxStAgc = dr - bc - (st.fcrHeadroom || 10);
                  const minStAgc = -(cr + bc - (st.fcrHeadroom || 10));
                  st.agcOffset = Math.max(
                    minStAgc,
                    Math.min(maxStAgc, st.agcOffset),
                  );
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
      const netNodes = [...net.nodeIds]
        .map((id) => state.nodes.find((n) => n.id === id))
        .filter(Boolean);
      const activeConns = state.connections.filter(
        (c) =>
          !c.tripped &&
          net.nodeIds.has(c.sourceId) &&
          net.nodeIds.has(c.targetId),
      );
      const adj = {};
      for (const n of netNodes) adj[n.id] = [];
      for (const c of activeConns) {
        adj[c.sourceId].push(c.targetId);
        adj[c.targetId].push(c.sourceId);
      }
      const visited = new Set();
      for (const n of netNodes) {
        if (
          visited.has(n.id) ||
          (n.type !== "generator" && n.type !== "storage")
        )
          continue;
        const q = [n.id];
        visited.add(n.id);
        while (q.length) {
          const id = q.shift();
          for (const nb of adj[id] || []) {
            if (!visited.has(nb)) {
              visited.add(nb);
              q.push(nb);
            }
          }
        }
      }
      for (const n of netNodes) {
        if (n.type === "load" && !visited.has(n.id)) {
          state.strandedLoadIds.add(n.id);
          n.mw = 0;
        }
      }
    }

    let changed = true;

    // --- Step 7: Update open settings panels ---
    for (const nodeId of Object.keys(openPanels)) {
      const gen = state.nodes.find(
        (n) => n.id === nodeId && n.type === "generator",
      );
      if (gen) {
        const entry = openPanels[nodeId];
        if (entry.outputEl)
          entry.outputEl.textContent = Math.round(gen.mw || 0) + " MW";
        if (entry.baselineSlider && entry.baselineVal) {
          const d = gen.baselineContract || 0;
          if (d > parseInt(entry.baselineSlider.max))
            entry.baselineSlider.max = d;
          entry.baselineSlider.value = d;
          entry.baselineVal.textContent = Math.round(d) + " MW";
        }
        if (entry.shutdownBtn) {
          entry.shutdownBtn.textContent = gen.tripped
            ? "🔄 Restart"
            : "🛑 Shut Down";
          entry.shutdownBtn.style.background = gen.tripped
            ? "#27ae60"
            : "transparent";
          entry.shutdownBtn.style.color = gen.tripped ? "#fff" : "#c0392b";
        }
      }
      const st = state.nodes.find(
        (n) => n.id === nodeId && n.type === "storage",
      );
      if (st) {
        const entry = openPanels[nodeId];
        if (entry.socEl)
          entry.socEl.textContent = (st.mw || 0).toFixed(2) + " MWh";
        if (entry.mwRespEl)
          entry.mwRespEl.textContent =
            (st.mwResponse || 0) >= 0
              ? "+" + Math.round(st.mwResponse || 0) + " MW"
              : Math.round(st.mwResponse || 0) + " MW";
        if (entry.modeSelect) entry.modeSelect.value = st.mode || "balancing";
        if (entry.fcrGroup)
          entry.fcrGroup.style.display =
            st.mode === "balancing" || st.mode === "fcr-only" || st.mode === "load-follow" ? "" : "none";
        if (entry.fixedGroup)
          entry.fixedGroup.style.display = st.mode === "fixed" ? "" : "none";
        if (entry.neutralGroup)
          entry.neutralGroup.style.display =
            st.mode === "balancing" ? "" : "none";
        if (entry.fcrSlider && entry.fcrVal) {
          entry.fcrSlider.value = st.fcrHeadroom || 10;
          entry.fcrVal.textContent = Math.round(st.fcrHeadroom || 10) + " MW";
        }
        if (entry.droopSlider && entry.droopVal) {
          entry.droopSlider.value = (st.droop || 0.04) * 100;
          entry.droopVal.textContent =
            Math.round((st.droop || 0.04) * 100) + "%";
        }
        if (entry.fixedSlider && entry.fixedVal) {
          entry.fixedSlider.value = st.fixedTarget || 0;
          entry.fixedVal.textContent =
            (st.fixedTarget || 0) >= 0
              ? "+" + Math.round(st.fixedTarget || 0) + " MW"
              : Math.round(st.fixedTarget || 0) + " MW";
        }
        if (entry.bcSlider && entry.bcVal) {
          entry.bcSlider.value = st.baselineContract || 0;
          entry.bcVal.textContent =
            (st.baselineContract || 0) >= 0
              ? "+" + Math.round(st.baselineContract || 0) + " MW"
              : Math.round(st.baselineContract || 0) + " MW";
        }
        if (entry.shutdownBtn) {
          entry.shutdownBtn.textContent = st.tripped
            ? "🔄 Restart"
            : "🛑 Shut Down";
          entry.shutdownBtn.style.background = st.tripped
            ? "#27ae60"
            : "transparent";
          entry.shutdownBtn.style.color = st.tripped ? "#fff" : "#c0392b";
        }
      }
    }

    // --- Step 5a: Update FCR / aFRR status badges ---
    {
      const fcrBadge = document.getElementById("fcr-badge");
      const agcBadge = document.getElementById("agc-badge");
      const allGens = state.nodes.filter((n) => n.type === "generator");
      const fcrGens = allGens.filter(
        (g) => g.mode === "balancing" || g.mode === "fcr-only" || g.mode === "load-follow",
      );
      const fcrActive = fcrGens.some((g) => {
        const dev = (state.frequency - f0) / f0;
        const govMod = -(1 / (g.droop || 0.04)) * dev * (g.rating || 100);
        return (
          Math.abs(govMod) > 0.5 && Math.abs(govMod) <= (g.fcrHeadroom || 10)
        );
      });
      fcrBadge.className =
        "status-badge " + (fcrActive ? "fcr-active" : "fcr-inactive");
      const balancingGens = allGens.filter((g) => g.mode === "balancing" || g.mode === "load-follow");
      const agcActive =
        Math.abs(f0 - state.frequency) > 0.001 && balancingGens.length > 0;
      agcBadge.className =
        "status-badge " + (agcActive ? "agc-active" : "agc-inactive");
    }

    // --- Step 5b: Refresh stats panel ---
    this.callbacks.updateStatsPanel();

    // --- Step 6: Time-series capture at 1/4 s intervals ---
    sim.captureAccum += dt;
    if (sim.captureAccum >= 0.25) {
      sim.captureAccum -= 0.25;
      const netFreqs = {};
      for (const net of state.networks) netFreqs[net.id] = net.freq;
      const entry = {
        t: sim.dataBuffer.length * 0.25,
        frequency: state.frequency,
        networks: netFreqs,
        nodes: {},
        connections: {},
        nodeNetworks: {},
      };
      for (const node of state.nodes) {
        entry.nodes[node.id] = { type: node.type, mw: node.mw || 0 };
        if (node.type === "generator") {
          entry.nodes[node.id].baselineContract = node.baselineContract || 0;
          entry.nodes[node.id].agcOffset = node.agcOffset || 0;
          entry.nodes[node.id].mode = node.mode || "balancing";
          entry.nodes[node.id].rating = node.rating || 100;
          entry.nodes[node.id].droop = node.droop || 0.04;
          entry.nodes[node.id].fcrHeadroom = node.fcrHeadroom || 10;
          entry.nodes[node.id].bidPrice = node.bidPrice || 50;
          entry.nodes[node.id].bidQty = node.bidQty || node.rating || 100;
          entry.nodes[node.id].turbineTimeConstant =
            node.turbineTimeConstant || 1;
        }
        if (node.type === "storage") {
          entry.nodes[node.id].mwResponse = node.mwResponse || 0;
          entry.nodes[node.id].mode = node.mode || "balancing";
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

    if (changed) this.callbacks.draw();
    if (freqChartVisible) drawFreqChart();
    if (meritChartVisible) drawMeritOrderChart();
  }

  startSim() {
    const { state, sim } = this.store;
    const { draw, updateControls, updateStatsPanel } = this.callbacks;

    if (sim.running) return;
    sim.running = true;
    sim.interval = setInterval(() => this.simTick(), 1000 / sim.tickHz);
  }

  stopSim() {
    const { state, sim } = this.store;
    const { draw, updateControls, updateStatsPanel } = this.callbacks;

    sim.running = false;
    if (sim.interval) {
      clearInterval(sim.interval);
      sim.interval = null;
    }
  }

  restartSim() {
    const { state, sim } = this.store;
    const { draw, updateControls, updateStatsPanel } = this.callbacks;

    this.stopSim();
    sim.dataBuffer = [];
    sim.captureAccum = 0;
    sim.events = [];
    sim.simTime = 0;
    sim.lastMarketPat = 0;

    // Reset trips, shedding, FCR/AGC offsets — but keep baselines intact
    for (const gen of state.nodes.filter((n) => n.type === "generator")) {
      gen.agcOffset = 0;
      gen.mw = gen.baselineContract || 0;
      gen.tripped = false;
      gen.freqTimer = 0;
    }
    for (const st of state.nodes.filter((n) => n.type === "storage")) {
      st.mwResponse = st.baselineContract || 0;
      st.agcOffset = 0;
      st.freqRestore = 0;
      st.tripped = false;
    }
    for (const load of state.nodes.filter((n) => n.type === "load")) {
      load.shedPct = 0;
      if (load.baseMw) load.mw = load.baseMw;
    }
    for (const c of state.connections) {
      c.tripped = false;
      c.tripTimer = 0;
    }
    state.frequency = 50;
    state.networks = this.findNetworks();
    for (const net of state.networks) {
      net.freq = 50;
      net.freqPrev = 50;
    }

    // Clear black start state
    state.blackStartNets = new Set();
    for (const net of state.networks) {
      delete net.blackStart;
    }
    for (const node of state.nodes) {
      if (node.type === "load") delete node._preBlackoutBaseMw;
      if (node.type === "generator") delete node._preBlackStartMode;
    }
    // Pre-compute demand curve loads for t=0 so dispatch sees correct demand
    for (const load of state.nodes.filter((n) => n.type === "load")) {
      if (load.noiseEnabled) {
        const mult = this.demandCurve(0);
        load.mw = Math.round(
          (load.noiseMin || 100) +
            ((load.noiseMax || 200) - (load.noiseMin || 100)) * mult
        );
        load.baseMw = load.mw;
      }
    }
    // Re-dispatch merchant bids and top up with balancing storage
    sim.settlingTimer = 3.0;
    // Find main network (one with loads) for restart dispatch
    const restartMainNet = state.networks.find(net => {
      const netNodes = [...net.nodeIds]
        .map(id => state.nodes.find(n => n.id === id))
        .filter(Boolean);
      return netNodes.some(n => n.type === "load");
    });
    this.dispatchMeritOrder(true, true, restartMainNet);
    this.callbacks.draw();
    this.callbacks.updateControls();
    this.callbacks.updateStatsPanel();
  }

  balanceGrid() {
    const { state, sim, openPanels } = this.store;
    const { draw, updateControls, updateStatsPanel } = this.callbacks;

    // Balance supply with demand per island.
    // Each island's flexible generators share that island's load proportionally by rating.
    const nets = this.findNetworks();
    if (!nets.length) return;

    // Reset all gen trips and load shedding (baselines preserved for fixed gens)
    for (const gen of state.nodes.filter((n) => n.type === "generator")) {
      if (gen.mode !== "fixed") gen.baselineContract = 0;
      gen.agcOffset = 0;
      gen.tripped = false;
      gen.freqTimer = 0;
    }
    for (const st of state.nodes.filter((n) => n.type === "storage")) {
      st.baselineContract = 0;
      st.mwResponse = 0;
      st.agcOffset = 0;
      st.freqRestore = 0;
      st.tripped = false;
    }
    for (const c of state.connections) {
      c.tripped = false;
      c.tripTimer = 0;
    }
    for (const load of state.nodes.filter((n) => n.type === "load")) {
      load.shedPct = 0;
      if (load.baseMw) load.mw = load.baseMw;
    }
    // Reset island frequencies to nominal so governor doesn't override balanced dispatch
    for (const net of nets) {
      net.freq = 50;
      net.freqPrev = 50;
    }

    for (const net of nets) {
      const netNodes = [...net.nodeIds]
        .map((id) => state.nodes.find((n) => n.id === id))
        .filter(Boolean);
      const loads = netNodes.filter((n) => n.type === "load");
      const gens = netNodes.filter((n) => n.type === "generator");
      const storages = netNodes.filter((n) => n.type === "storage");
      if (!loads.length) continue;

      const totalDemand = loads.reduce((sum, n) => sum + (n.mw || 0), 0);
      const fixedGens = gens.filter((g) => g.mode === "fixed");
      const flexGens = gens.filter((g) => g.mode !== "fixed" && g.mode !== "load-follow");
      const lfGens = gens.filter((g) => g.mode === "load-follow");
      const notFixedStor = storages.filter((s) => s.mode !== "fixed");

      const fixedSupply = fixedGens.reduce(
        (sum, g) => sum + Math.min(g.baselineContract || 0, g.rating || Infinity),
        0,
      );
      let remaining = totalDemand - fixedSupply;

      // Load-follow gens get proportional share of remaining
      if (lfGens.length > 0 && remaining > 0) {
        const totalLfRating = lfGens.reduce((s, g) => s + (g.rating || 100), 0);
        for (const gen of lfGens) {
          const share = (gen.rating || 100) / totalLfRating;
          gen.baselineContract = Math.min(
            Math.round(remaining * share * 10) / 10,
            gen.rating || Infinity,
          );
          gen.mw = gen.baselineContract;
        }
        remaining -= lfGens.reduce((s, g) => s + (g.baselineContract || 0), 0);
      }

      // Distribute remaining proportionally across flexible gens AND storage
      // Exclude storage with insufficient SoC (can't discharge what it doesn't have)
      const dispatchableStor = notFixedStor.filter(
        (s) => s.mw === undefined || s.mw > 0,
      );
      const flexGenRating = flexGens.reduce(
        (sum, g) => sum + (g.rating || 100),
        0,
      );
      const flexStorRate = dispatchableStor.reduce(
        (sum, s) => sum + (s.dischargeRate || 50),
        0,
      );
      const totalFlex = flexGenRating + flexStorRate;

      if (totalFlex > 0 && remaining > 0) {
        for (const gen of flexGens) {
          const share = (gen.rating || 100) / totalFlex;
          gen.baselineContract = Math.min(
            Math.round(remaining * share * 10) / 10,
            gen.rating || Infinity,
          );
          gen.mw = gen.baselineContract;
        }
        for (const st of dispatchableStor) {
          const share = (st.dischargeRate || 50) / totalFlex;
          st.baselineContract = Math.min(
            Math.round(remaining * share * 10) / 10,
            st.dischargeRate || 50,
          );
          if (st.mw !== undefined && st.mw < st.baselineContract * 0.05)
            st.baselineContract = 0;
          st.mwResponse = st.baselineContract;
        }
        // Redistribute any shortfall from zeroed storage to flexible gens
        const totalAllocated =
          flexGens.reduce((s, g) => s + (g.baselineContract || 0), 0) +
          dispatchableStor.reduce((s, st) => s + (st.baselineContract || 0), 0);
        const shortfall = remaining - totalAllocated;
        if (shortfall > 1 && flexGens.length > 0) {
          for (const gen of flexGens) {
            const addShare = (gen.rating || 100) / flexGenRating;
            gen.baselineContract = Math.min(
              (gen.baselineContract || 0) + shortfall * addShare,
              gen.rating || Infinity,
            );
            gen.mw = gen.baselineContract;
          }
        }
      } else if (totalFlex > 0 && remaining < 0) {
        // Surplus: charge storage to absorb excess (gens can't absorb, only curtail)
        for (const gen of flexGens) gen.baselineContract = 0;
        const surplus = -remaining;
        const totalRate = notFixedStor.reduce(
          (s, st) => s + (st.chargeRate || 50),
          0,
        );
        for (const st of notFixedStor) {
          const cr = st.chargeRate || 50;
          st.baselineContract = -Math.min(
            Math.round(surplus * (cr / totalRate) * 10) / 10,
            cr,
          );
          st.mwResponse = st.baselineContract;
        }
      }
    }

    // Run initial merit order dispatch so baselines reflect market prices
    this.dispatchMeritOrder();

    // Update the UI
    this.recomputeNetworks();
    this.onPersist();
    this.callbacks.draw();
    this.callbacks.updateControls();
    this.callbacks.updateStatsPanel();

    // Update open settings panels for storage dispatch slider
    for (const nodeId of Object.keys(openPanels)) {
      const entry = openPanels[nodeId];
      const st = state.nodes.find(
        (n) => n.id === nodeId && n.type === "storage",
      );
      if (st && entry.bcSlider && entry.bcVal) {
        entry.bcSlider.value = st.baselineContract || 0;
        entry.bcVal.textContent =
          (st.baselineContract || 0) >= 0
            ? "+" + Math.round(st.baselineContract || 0) + " MW"
            : Math.round(st.baselineContract || 0) + " MW";
      }
    }
  }

  async saveSnapshot() {
    const snapshot = {
      savedAt: Date.now(),
      tickHz: sim.tickHz,
      captureInterval: 0.25,
      grid: {
        nodes: state.nodes.map((n) => ({ ...n })),
        connections: state.connections.map((c) => ({ ...c })),
        view: { ...state.view },
      },
      timeseries: sim.dataBuffer,
      events: sim.events,
    };
    try {
      const res = await fetch("/api/save-snapshot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(snapshot),
      });
      const data = await res.json();
      if (data.ok) {
        const btn = document.getElementById("save-data-btn");
        const orig = btn.textContent;
        btn.textContent = "✅ " + data.filename;
        btn.disabled = true;
        setTimeout(() => {
          btn.textContent = orig;
          btn.disabled = false;
        }, 2000);
      }
    } catch (e) {
      console.error("Save failed:", e);
    }
  }

  solveDCPowerFlow(net) {
    const { state, sim } = this.store;
    const { draw, updateControls, updateStatsPanel } = this.callbacks;

    const allNodes = [...net.nodeIds]
      .map((id) => state.nodes.find((n) => n.id === id))
      .filter(Boolean);
    if (allNodes.length < 2) return;

    const allConns = state.connections.filter(
      (c) =>
        !c.tripped &&
        net.nodeIds.has(c.sourceId) &&
        net.nodeIds.has(c.targetId) &&
        (c.reactance || 0) > 0,
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
      const queue = [n.id];
      visited.add(n.id);
      while (queue.length) {
        const id = queue.shift();
        nodeIds.add(id);
        for (const neighbor of adj[id] || []) {
          if (!visited.has(neighbor)) {
            visited.add(neighbor);
            queue.push(neighbor);
          }
        }
      }
      const compNodes = allNodes.filter((n) => nodeIds.has(n.id));
      const compConns = allConns.filter(
        (c) => nodeIds.has(c.sourceId) && nodeIds.has(c.targetId),
      );
      if (compNodes.length >= 2 && compConns.length > 0)
        components.push({ nodes: compNodes, conns: compConns });
    }

    // Solve each component independently
    for (const comp of components) {
      const { nodes, conns } = comp;
      const nB = nodes.length;
      const busIdx = {};
      nodes.forEach((n, i) => {
        busIdx[n.id] = i;
      });

      const B = Array.from({ length: nB }, () => new Float64Array(nB));
      const P = new Float64Array(nB);

      for (const c of conns) {
        const i = busIdx[c.sourceId],
          j = busIdx[c.targetId];
        const bij = 1 / c.reactance;
        B[i][j] -= bij;
        B[j][i] -= bij;
        B[i][i] += bij;
        B[j][j] += bij;
      }

      for (const n of nodes) {
        const idx = busIdx[n.id];
        if (n.tripped) continue;
        if (n.type === "generator") P[idx] += n.mw || 0;
        else if (n.type === "load") P[idx] -= n.mw || 0;
        else if (n.type === "storage") P[idx] += n.mwResponse || 0;
      }

      // If no active supply in this component, zero flows and skip
      const hasActiveInjection = nodes.some(
        (n) =>
          !n.tripped &&
          ((n.type === "generator" && (n.mw || 0) > 0) ||
            (n.type === "storage" && (n.mwResponse || 0) > 0)),
      );
      if (!hasActiveInjection) {
        for (const c of conns) {
          c.mw = 0;
          c.loadingPct = 0;
        }
        continue;
      }

      let slack = nodes.findIndex(
        (n) => !n.tripped && n.type === "generator" && (n.mw || 0) > 0,
      );
      if (slack < 0)
        slack = nodes.findIndex(
          (n) => !n.tripped && n.type === "storage" && (n.mwResponse || 0) > 0,
        );
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
        for (let r = col + 1; r < m; r++)
          if (Math.abs(Br[r][col]) > Math.abs(Br[pivot][col])) pivot = r;
        if (Math.abs(Br[pivot][col]) < 1e-12) continue;
        if (pivot !== col) {
          [Br[col], Br[pivot]] = [Br[pivot], Br[col]];
          [Pr[col], Pr[pivot]] = [Pr[pivot], Pr[col]];
        }
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
        const i = busIdx[c.sourceId],
          j = busIdx[c.targetId];
        const flow = (theta[i] - theta[j]) / c.reactance;
        c.mw = flow;
        c.loadingPct =
          c.thermalLimit > 0 ? (Math.abs(flow) / c.thermalLimit) * 100 : 0;
      }

      // Scale flows to match actual slack bus capability (storage/gen may be output-limited)
      const slackNode = nodes[slack];
      let actualSlackMW = 0;
      if (slackNode.type === "generator") actualSlackMW = slackNode.mw || 0;
      else if (slackNode.type === "storage")
        actualSlackMW = slackNode.mwResponse || 0;
      let computedSlackMW = 0;
      for (const c of conns) {
        const si = busIdx[c.sourceId],
          ti = busIdx[c.targetId];
        if (si === slack) computedSlackMW += c.mw;
        else if (ti === slack) computedSlackMW -= c.mw;
      }
      if (
        Math.abs(computedSlackMW) > Math.abs(actualSlackMW) + 0.01 &&
        Math.abs(actualSlackMW) > 0.01
      ) {
        const scale = Math.abs(actualSlackMW) / Math.abs(computedSlackMW);
        for (const c of conns) {
          c.mw *= scale;
          c.loadingPct =
            c.thermalLimit > 0 ? (Math.abs(c.mw) / c.thermalLimit) * 100 : 0;
        }
      }
    }

    // Any active connection not in a solved component → 0 flow
    for (const c of allConns) {
      if (c.mw === undefined) {
        c.mw = 0;
        c.loadingPct = 0;
      }
    }
  }

  computeBoundingBox(net) {
    const { state, sim } = this.store;
    const { draw, updateControls, updateStatsPanel } = this.callbacks;

    const nodes = [...net.nodeIds]
      .map((id) => state.nodes.find((n) => n.id === id))
      .filter(Boolean);
    if (nodes.length === 0) return { x: 0, y: 0, w: 0, h: 0 };
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    for (const n of nodes) {
      if (n.x < minX) minX = n.x;
      if (n.y < minY) minY = n.y;
      if (n.x > maxX) maxX = n.x;
      if (n.y > maxY) maxY = n.y;
    }
    const pad = 60;
    return {
      x: minX - pad,
      y: minY - pad,
      w: maxX - minX + pad * 2,
      h: maxY - minY + pad * 2,
    };
  }

  setsEqual(a, b) {
    if (a.size !== b.size) return false;
    for (const v of a) if (!b.has(v)) return false;
    return true;
  }

  findNetworks() {
    const { state, sim, ISLAND_COLORS } = this.store;
    const { draw, updateControls, updateStatsPanel } = this.callbacks;

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
        for (const neighbor of adj[id] || []) {
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
      const netNodes = [...nodeIds]
        .map((id) => state.nodes.find((n) => n.id === id))
        .filter(Boolean);
      const hasGen = netNodes.some((n) => n.type === "generator");
      const hasLoad = netNodes.some((n) => n.type === "load");
      const hasConnection = state.connections.some(
        (c) => nodeIds.has(c.sourceId) && nodeIds.has(c.targetId),
      );
      const match = oldNets.find(
        (o) => o.nodeIds && this.setsEqual(o.nodeIds, nodeIds),
      );
      const net = match || {
        id: "net_" + newNets.length,
        freq: 50,
        color: ISLAND_COLORS[newNets.length % ISLAND_COLORS.length],
      };
      net.nodeIds = nodeIds;
      net.valid = (hasGen || hasLoad) && hasConnection;
      net.boundingBox = this.computeBoundingBox(net);
      if (!match) net.customName = null;
      newNets.push(net);
    }
    return newNets;
  }
}
