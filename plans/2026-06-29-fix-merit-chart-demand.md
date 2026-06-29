# Plan: Fix merit order demand & chart refresh

## Problem 1: Storage charge demand inflated
`dispatchMeritOrder()` and `drawMeritOrderChart()` both add storage's full `chargeRate` to demand whenever `buyTrigger !== "off"`, ignoring whether the actual buy condition is met. This inflates the demand line and distorts dispatch.

### Fix 1a: `dispatchMeritOrder()` — match physics buy logic
Replace the simple `st.buyTrigger !== "off"` filter with a proper buy condition check matching the physics loop (Engine.js lines 538-551):
- `price` trigger: `state.smp <= st.buyPrice` (using prior cycle's SMP)
- `time` trigger: `tod` within buy start/duration window
- `both` trigger: either condition met

`patSec` and `tod` already computed on line 83-84.

### Fix 1b: `drawMeritOrderChart()` — same buy logic
StatsPanel.js lines 508-510: Replace the demand line's storage charge aggregation with the same buy condition check.

## Problem 2: Merit chart doesn't redraw during play
Chart only redraws on `dispatchMeritOrder()` call (every ~1.25s). Demand curve shifts continuously, demand line stays stale.

### Fix 2: Add merit chart redraw alongside freq chart
Engine.js line 1075, after `if (freqChartVisible) drawFreqChart();`:
```
if (meritChartVisible) drawMeritOrderChart();
```

Now the chart updates in sync with the freq chart (every data capture tick ~0.25s).
