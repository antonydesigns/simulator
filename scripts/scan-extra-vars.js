const fs = require('fs');
const dirs = ['canvas', 'simulation', 'storage', 'ui'];
const files = [];
for (const d of dirs) {
  for (const f of fs.readdirSync(`.simma/workspace/simulator/public/${d}`).filter(f => f.endsWith('.js'))) {
    files.push(`${d}/${f}`);
  }
}

// Store vars NOT in the default destructuring template
const extraStoreVars = [
  'openPanels',
  'hoveredIslandId', 'hoveredIslandHeader', 'islandDrag',
  'selectedNetworkId', 'statsPanelVisible', 'freqChartVisible', 'meritChartVisible',
  'dragPanel', 'dragOff', 'resizePanel', 'resizeStart',
];

let found = 0;

for (const file of files) {
  const content = fs.readFileSync(`.simma/workspace/simulator/public/${file}`, 'utf-8');
  const lines = content.split('\n');
  let currentMethod = '';
  let inMethod = false;
  let depth = 0;
  let destructured = new Set();

  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    
    // Detect method start
    const methodMatch = t.match(/^(\w+)\(/);
    if (methodMatch && (t.endsWith('{') || t.endsWith(') {')) && 
        !['if','for','while','switch','catch','else','then','return'].includes(methodMatch[1])) {
      currentMethod = methodMatch[1];
      destructured = new Set();
      depth = 0;
      inMethod = true;
    }
    
    if (inMethod) {
      // Track destructuring from this.store
      if (t.includes('const {') && t.includes('this.store')) {
        const match = t.match(/\{([^}]+)\}/);
        if (match) {
          match[1].split(',').forEach(v => destructured.add(v.trim().split(/[:=]/)[0].trim()));
        }
      }
      
      // Track brace depth
      for (const c of lines[i]) { if (c === '{') depth++; if (c === '}') depth--; }
      
      // Check for bare extra store vars
      for (const v of extraStoreVars) {
        const re = new RegExp('(?<![.\\w])' + v + '\\b');
        if (re.test(t) && !destructured.has(v) && !t.includes('this.store.' + v) &&
            !t.startsWith('//') && !t.startsWith('*') && !t.includes('class ')) {
          console.log(`${file}:${i+1} (${currentMethod}): bare "${v}" — ${t.slice(0, 60)}`);
          found++;
        }
      }
      
      if (depth === 0) { inMethod = false; }
    }
  }
}

console.log(`\nTotal: ${found} issues`);
