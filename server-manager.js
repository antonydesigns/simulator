const express = require("express");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

const MANAGER_PORT = 9000;
const CHILD_PORT = 3000;
const app = express();

// From .simma/workspace/simulator/server-manager.js → root is 3 levels up
const ROOT = path.resolve(__dirname, "..", "..", "..");
const SERVER_ENTRY = path.join(ROOT, "src", "server.js");

let childProcess = null;
let childStartTime = null;

function startChild() {
  if (childProcess) {
    console.log(`Killing existing child PID ${childProcess.pid}`);
    childProcess.kill("SIGTERM");
    childProcess = null;
  }

  // Read the current .env from root
  let envVars = { ...process.env };
  try {
    const envContent = fs.readFileSync(path.join(ROOT, ".env"), "utf-8");
    for (const line of envContent.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx === -1) continue;
      envVars[trimmed.slice(0, eqIdx).trim()] = trimmed.slice(eqIdx + 1).trim();
    }
  } catch (e) {
    console.warn("Could not read .env:", e.message);
  }

  envVars.PORT = String(CHILD_PORT);

  childProcess = spawn("node", [SERVER_ENTRY], {
    cwd: ROOT,
    env: envVars,
    stdio: ["ignore", "pipe", "pipe"],
  });

  // Capture child stderr for debugging
  let stderrBuf = "";
  childProcess.stderr.on("data", (d) => {
    stderrBuf += d.toString();
    const lines = stderrBuf.split("\n");
    if (lines.length > 50) stderrBuf = lines.slice(-20).join("\n");
  });
  setTimeout(() => {
    if (stderrBuf && !childProcess) console.error("Child stderr was:\n", stderrBuf);
  }, 3000);

  childStartTime = Date.now();
  console.log(`Spawned child PID ${childProcess.pid} → ${SERVER_ENTRY} on port ${CHILD_PORT}`);

  const thisChild = childProcess;
  thisChild.on("exit", (code, signal) => {
    console.log(`Child PID ${thisChild.pid} exited (code=${code}, signal=${signal})`);
    if (childProcess === thisChild) {
      childProcess = null;
    }
  });
}

app.get("/status", (req, res) => {
  res.json({
    manager: { port: MANAGER_PORT, alive: true },
    child: childProcess
      ? { pid: childProcess.pid, port: CHILD_PORT, uptimeMs: Date.now() - childStartTime }
      : null,
  });
});

app.post("/restart", (req, res) => {
  if (!childProcess) {
    startChild();
    return res.json({ ok: true, action: "started" });
  }
  startChild();
  res.json({ ok: true, action: "restarted" });
});

app.listen(MANAGER_PORT, () => {
  console.log(`Manager running on http://localhost:${MANAGER_PORT}`);
  startChild();
});
