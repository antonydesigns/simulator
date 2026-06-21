const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data.json');

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- Persistence ---

function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, 'utf-8');
      return JSON.parse(raw);
    }
  } catch (e) {
    console.error('Failed to load data:', e.message);
  }
  return { nodes: [], connections: [] };
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf-8');
}

// --- API Routes ---

app.get('/api/grid', (req, res) => {
  const data = loadData();
  res.json(data);
});

app.post('/api/grid', (req, res) => {
  const { nodes, connections } = req.body;
  const data = { nodes: nodes || [], connections: connections || [] };
  saveData(data);
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`Power Grid Simulator running at http://localhost:${PORT}`);
});
