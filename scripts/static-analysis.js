const fs = require('fs');
const path = require('path');

const base = path.join(__dirname, '..', 'public');
const modules = {
  'core/Store.js': { class: 'Store', exports: ['Store'] },
  'simulation/Engine.js': { class: 'SimulationEngine', exports: ['SimulationEngine'] },
  'storage/Persister.js': { class: 'Persister', exports: ['Persister'] },
  'canvas/Renderer.js': { class: 'Renderer', exports: ['Renderer'] },
  'ui/Controls.js': { class: 'Controls', exports: ['Controls'] },
  'ui/StatsPanel.js': { class: 'StatsPanel', exports: ['StatsPanel'] },
  'ui/SettingsPanel.js': { class: 'SettingsPanel', exports: ['SettingsPanel'] },
  'ui/BalanceModal.js': { class: 'BalanceModal', exports: ['BalanceModal'] },
  'ui/Interactions.js': { class: 'Interactions', exports: ['Interactions'] },
};

// Extract Store properties from Store.js
const storeContent = fs.readFileSync(path.join(base, 'core/Store.js'), 'utf-8');
const storeProperties = [];
const storeLines = storeContent.split('\n');
let inConstructor = false;
for (let i = 0; i < storeLines.length; i++) {
  const t = storeLines[i].trim();
  if (t.includes('constructor()')) inConstructor = true;
  if (t.startsWith('this.') && inConstructor) {
    const match = t.match(/this\.(\w+)\s*[:=]/);
    if (match) storeProperties.push(match[1]);
  }
  if (inConstructor && t.startsWith('}') && !t.includes('{')) break;
}

console.log('Store properties:', storeProperties.join(', '));
console.log('---');

// Check each module file
let totalIssues = 0;

for (const [filePath, info] of Object.entries(modules)) {
  const fullPath = path.join(base, filePath);
  if (!fs.existsSync(fullPath)) continue;
  
  const content = fs.readFileSync(fullPath, 'utf-8');
  const lines = content.split('\n');
  const fileIssues = [];
  
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t.startsWith('//') || t.startsWith('*') || t.startsWith('import')) continue;
    
    // Skip lines that are specifically NOT in method bodies
    if (t.startsWith('class ') || t.startsWith('constructor(') || t.startsWith('}') ||
        t.startsWith('export ') || t.startsWith('[') || t.startsWith('  [')) continue;
    
    // Check if we're inside a method (between opening { and closing })
    // Simple heuristic: check if the line has a brace depth > 0
    // We'll check for method declarations
    
    for (const prop of storeProperties) {
      // Check if prop is used as a bare word (not preceded by this.store., this., or .)
      const re = new RegExp('(?<![.\\w])' + prop + '\\b');
      if (re.test(t) && 
          !t.includes('this.store.' + prop) && 
          !t.includes('this.' + prop) &&
          !t.includes('store.' + prop) &&
          !t.includes('const {') && 
          !t.includes('const ' + prop + ' ') &&
          !t.includes('let ' + prop + ' ') &&
          t !== '}') {
        // Check if it's a false positive (like CSS properties, Math, etc.)
        const knownFalsePositives = ['scale', 'x', 'y', 'type', 'mode', 'id', 'speed', 'color', 'label', 
          'value', 'name', 'source', 'target', 'size', 'min', 'max', 'step', 'top', 'left', 'right',
          'bottom', 'width', 'height', 'start', 'end', 'length', 'valid'];
        if (knownFalsePositives.includes(prop)) continue;
        
        fileIssues.push({ line: i + 1, prop, text: t.slice(0, 80) });
        totalIssues++;
      }
    }
  }
  
  if (fileIssues.length > 0) {
    console.log(`\n${filePath} (${fileIssues.length} issues):`);
    for (const issue of fileIssues) {
      console.log(`  L${issue.line}: bare "${issue.prop}" → ${issue.text}`);
    }
  }
}

console.log(`\nTotal issues: ${totalIssues}`);
