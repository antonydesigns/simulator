const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 4000;
const DATA_FILE = path.join(__dirname, "data.json");

app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, "public")));

// --- Persistence ---

function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, "utf-8");
      return JSON.parse(raw);
    }
  } catch (e) {
    console.error("Failed to load data:", e.message);
  }
  return { nodes: [], connections: [] };
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), "utf-8");
}

// --- API Routes ---

app.get("/api/grid", (req, res) => {
  const data = loadData();
  res.json(data);
});

app.post("/api/grid", (req, res) => {
  const { nodes, connections, view } = req.body;
  const data = { nodes: nodes || [], connections: connections || [], view };
  saveData(data);
  res.json({ ok: true });
});

// --- Snapshot saving ---

const SNAPSHOT_DIR = path.join(__dirname, "snapshots");
if (!fs.existsSync(SNAPSHOT_DIR))
  fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });

function randomHex(len) {
  let s = "";
  const chars = "0123456789abcdef";
  for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * 16)];
  return s;
}

app.post("/api/save-snapshot", (req, res) => {
  const snapshot = req.body;
  const ts = Date.now();
  const filename = `${ts}-${randomHex(5)}.json`;
  const filepath = path.join(SNAPSHOT_DIR, filename);
  fs.writeFileSync(filepath, JSON.stringify(snapshot, null, 2), "utf-8");
  res.json({ ok: true, filename });
});

app.listen(PORT, () => {
  console.log(`Power Grid Simulator running at http://localhost:${PORT}`);
});
