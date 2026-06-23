#!/usr/bin/env node
/**
 * codebase-index generator for Power Grid Simulator
 *
 * Scans project files (JS, HTML, CSS), extracts symbols, imports, exports,
 * and writes a machine-readable codebase-index.json with edge graphs.
 *
 * Usage: node scripts/index-codebase.js
 */

const fs = require("fs");
const path = require("path");

const PROJECT = path.resolve(__dirname, "..");

// ─── Helpers ──────────────────────────────────────────────────────────

function getGitCommit() {
  try {
    const cp = require("child_process");
    const { stdout } = cp.spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: PROJECT,
      encoding: "utf8",
      timeout: 5000,
    });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

const INCLUDE_EXTS = new Set([".js", ".mjs", ".cjs"]);
const SKIP_DIRS = new Set(["node_modules", ".git", "snapshots"]);

function collectFiles(dir, base = dir) {
  const results = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) results.push(...collectFiles(full, base));
    } else if (INCLUDE_EXTS.has(path.extname(e.name))) {
      results.push(full);
    }
  }
  return results;
}

function relPath(full) {
  return path.relative(PROJECT, full).replace(/\\/g, "/");
}

// ─── JS Parsing ───────────────────────────────────────────────────────

const IMPORT_RE =
  /(?:import\s+(?:(?:[\w*\s{},]+\s+from\s+)?["']([^"']+)["'])|(?:const\s+\w+\s*=\s*require\s*\(\s*["']([^"']+)["']\s*\)))/g;

const EXPORT_RE =
  /(?:export\s+(?:default\s+)?(?:function|const|let|var|class)\s+(\w+)|module\.exports\s*=\s*(\w+)|exports\.(\w+)\s*=)/g;

function parseJs(content) {
  const imports = [];
  const exports = [];
  const symbols = [];

  // Imports
  let m;
  IMPORT_RE.lastIndex = 0;
  while ((m = IMPORT_RE.exec(content)) !== null) {
    const src = m[1] || m[2];
    if (src && !imports.includes(src)) imports.push(src);
  }

  // Exports
  EXPORT_RE.lastIndex = 0;
  while ((m = EXPORT_RE.exec(content)) !== null) {
    const name = m[1] || m[2] || m[3];
    if (name && !exports.includes(name)) exports.push(name);
  }

  // Symbols: function declarations, const/let/var at top level
  // Match: function foo(...) or async function foo(...)
  const FUNC_RE = /(?:async\s+)?function\s+(\w+)\s*\(([\s\S]*?)\)/g;
  FUNC_RE.lastIndex = 0;
  while ((m = FUNC_RE.exec(content)) !== null) {
    const line = content.slice(0, m.index).split("\n").length;
    const name = m[1];
    const params = parseParams(m[2]);
    if (name && !symbols.some((s) => s.name === name)) {
      symbols.push({ name, kind: "function", line, exported: false, params });
    }
  }

  // Arrow function const/let/var assignments: const foo = (args) => or = async (args) =>
  const ARROW_RE =
    /(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?(?:\(([\s\S]*?)\)|(\w+))\s*=>/g;
  ARROW_RE.lastIndex = 0;
  while ((m = ARROW_RE.exec(content)) !== null) {
    const line = content.slice(0, m.index).split("\n").length;
    const name = m[1];
    const params = parseParams(m[2] || m[3] || "");
    if (name && !symbols.some((s) => s.name === name)) {
      symbols.push({ name, kind: "arrow_function", line, exported: false, params });
    }
  }

  // Async function expressions assigned to const
  const ASYNC_FUNC_RE =
    /(?:const|let|var)\s+(\w+)\s*=\s*async\s+function\s*(?:\(([\s\S]*?)\))?/g;
  ASYNC_FUNC_RE.lastIndex = 0;
  while ((m = ASYNC_FUNC_RE.exec(content)) !== null) {
    const line = content.slice(0, m.index).split("\n").length;
    const name = m[1];
    const params = parseParams(m[2] || "");
    if (name && !symbols.some((s) => s.name === name)) {
      symbols.push({ name, kind: "async_function", line, exported: false, params });
    }
  }

  // Check exported status
  for (const sym of symbols) {
    const lineIdx = sym.line - 1;
    const lines = content.split("\n");
    // Check if the function/const is preceded by "export" on the same or previous line
    for (let i = Math.max(0, lineIdx - 1); i <= lineIdx; i++) {
      const l = lines[i] || "";
      if (l.trim().startsWith("export")) {
        sym.exported = true;
        break;
      }
    }
  }

  return { imports, exports, symbols };
}

function parseParams(str) {
  return str
    .split(",")
    .map((p) => p.trim().split("=")[0].trim().replace(/^\.\.\./, ""))
    .filter(Boolean);
}

// ─── Build Index ──────────────────────────────────────────────────────

function buildIndex() {
  const files = collectFiles(PROJECT);
  const index = {
    version: 1,
    builtAt: new Date().toISOString(),
    gitCommit: getGitCommit(),
    fileCount: 0,
    symbolCount: 0,
    symbols: {},
    edges: {
      imports: {},
      importedBy: {},
    },
  };

  // Track importedBy relationships
  const importMap = {}; // importedFile -> [importing files]

  for (const full of files) {
    const rp = relPath(full);
    const content = fs.readFileSync(full, "utf-8");
    const { imports, exports, symbols } = parseJs(content);

    index.fileCount++;

    // Register each symbol
    for (const sym of symbols) {
      const symKey = sym.name;
      if (!index.symbols[symKey]) {
        index.symbols[symKey] = [];
      }
      index.symbols[symKey].push({
        kind: sym.kind,
        file: rp,
        line: sym.line,
        exported: sym.exported,
        params: sym.params,
      });
      index.symbolCount++;
    }

    // Register imports
    index.edges.imports[rp] = imports;
    for (const imp of imports) {
      if (!importMap[imp]) importMap[imp] = [];
      if (!importMap[imp].includes(rp)) importMap[imp].push(rp);
    }
  }

  // Build importedBy from the reverse map
  for (const [imported, importers] of Object.entries(importMap)) {
    index.edges.importedBy[imported] = importers;
  }

  // Sort for deterministic output
  const sorted = Object.keys(index.symbols).sort();
  const sortedSymbols = {};
  for (const k of sorted) {
    sortedSymbols[k] = index.symbols[k];
  }
  index.symbols = sortedSymbols;

  return index;
}

// ─── Write ────────────────────────────────────────────────────────────

const indexPath = path.join(PROJECT, "codebase-index.json");
const index = buildIndex();
fs.writeFileSync(indexPath, JSON.stringify(index, null, 2), "utf-8");

console.log(`✅ codebase-index.json generated`);
console.log(`   Files: ${index.fileCount}`);
console.log(`   Symbols: ${index.symbolCount}`);
console.log(`   Git: ${index.gitCommit || "N/A"}`);
