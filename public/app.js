import { Store } from "./core/Store.js";
import { SimulationEngine } from "./simulation/Engine.js";
import { Controls } from "./ui/Controls.js";
import { Renderer } from "./canvas/Renderer.js";
import { StatsPanel } from "./ui/StatsPanel.js";
import { Persister } from "./storage/Persister.js";
import { SettingsPanel } from "./ui/SettingsPanel.js";
import { Interactions } from "./ui/Interactions.js";

const store = new Store();
const renderer = new Renderer(store);
const controls = new Controls(store);
const statsPanel = new StatsPanel(store);
const engine = new SimulationEngine(store, {
  draw: renderer.draw.bind(renderer),
  updateControls: controls.updateControls.bind(controls),
  updateStatsPanel: statsPanel.update.bind(statsPanel),
    drawFreqChart: () => statsPanel.drawFreqChart(),
    drawMeritOrderChart: () => statsPanel.drawMeritOrderChart(),
});
const persister = new Persister(store, engine);
engine.onPersist = () => persister.persist();
const settingsPanel = new SettingsPanel(
  store,
  engine,
  renderer,
  persister,
  statsPanel,
);

const interactions = new Interactions(
  store,
  engine,
  renderer,
  settingsPanel,
  persister,
  controls,
  statsPanel,
);

async function init() {
  await persister.load();
  engine.balanceGrid();
  renderer.resizeCanvas();
  renderer.draw();
  controls.updateControls();
  statsPanel.update();
}

window.addEventListener("resize", () => renderer.resizeCanvas());
init();
