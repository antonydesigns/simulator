# Plan: Separate dispatch from physics

## Goal
Dispatch only sets schedules (`baselineContract`). Physics loop handles actual output via turbine lag, FCR, and AGC. No direct `gen.mw` writes from dispatch during running sim.

## Changes

### 1. `dispatchMeritOrder()` — add `writeMw` param (Engine.js)
- Add optional param `writeMw = false`
- Line 114: `if (bid.node.type === "generator") bid.node.mw = dispatch;` → only when `writeMw === true`
- Line 165: `asset.node.mw = asset.node.baselineContract;` → only when `writeMw === true`

### 2. `restartSim()` — keep the cheat on restart (Engine.js)
- Line 1138: `this.dispatchMeritOrder(true)` → `this.dispatchMeritOrder(true, true)`
- This writes mw = new baselines at startup (the initial balance cheat)

### 3. Physics loop market dispatch — no mw writes (Engine.js)
- Line 254: `this.dispatchMeritOrder(true)` → stays the same (default `writeMw = false`)
- Running market cycles set schedules only, physics converges naturally

### 4. Settling grace period on restart (Engine.js)
- In `restartSim()`, add `sim.settlingTimer = 3.0`
- In physics loop, while `sim.settlingTimer > 0`:
  - Widen gen trip thresholds to 46–54 Hz (instead of 48–52)
  - Widen storage trip thresholds to 46–54 Hz
  - Count down `sim.settlingTimer -= physicsDt`
  - After timer expires, restore normal 48–52 Hz thresholds

### 5. Persister — preserve `settlingTimer` (Persister.js)
- No change needed — `sim` object gets rebuilt on snapshot load

## Edge cases
- **User saves snapshot during settling period** → on reload, `dispatchMeritOrder(true, true)` re-cheats on restart, resets settling timer. Fine.
- **Black start during settling** → black start has its own ramp logic, shouldn't interact negatively. The wider trip band only helps.
- **Storage energy depletion** → settling period is 3 seconds at most, negligible SoC impact.
