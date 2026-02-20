const fs = require('fs');
const path = require('path');
const baseDir = path.join(__dirname, '..', 'data', 'review-texts');

const outlets = {
  'wsj': 'Wall Street Journal',
  'newyorker': 'New Yorker',
  'nytimes': 'New York Times',
  'washpost': 'Washington Post',
  'bloomberg': 'Bloomberg',
  'financialtimes': 'Financial Times',
};

const stats = {};
for (const id of Object.keys(outlets)) {
  stats[id] = { total: 0, complete: 0, reasons: {} };
}

const dirs = fs.readdirSync(baseDir).filter(d => {
  try { return fs.statSync(path.join(baseDir, d)).isDirectory(); } catch { return false; }
});

for (const dir of dirs) {
  for (const file of fs.readdirSync(path.join(baseDir, dir))) {
    if (!file.endsWith('.json')) continue;
    try {
      const data = JSON.parse(fs.readFileSync(path.join(baseDir, dir, file), 'utf8'));
      const oid = data.outletId;
      if (!stats[oid]) continue;
      stats[oid].total++;
      if (data.fullText && data.fullText.length > 100) {
        stats[oid].complete++;
      } else {
        const reason = data.incompleteReason || 'unknown';
        stats[oid].reasons[reason] = (stats[oid].reasons[reason] || 0) + 1;
      }
    } catch {}
  }
}

console.log('| Outlet | Total | Complete | % | Gap | Top Reasons |');
console.log('|--------|-------|----------|---|-----|-------------|');
for (const [id, name] of Object.entries(outlets)) {
  const s = stats[id];
  const pct = s.total > 0 ? (s.complete / s.total * 100).toFixed(1) : '0.0';
  const gap = s.total - s.complete;
  const topReasons = Object.entries(s.reasons).sort((a,b) => b[1] - a[1]).slice(0, 2).map(([r,c]) => `${r}(${c})`).join(', ');
  console.log(`| ${name} | ${s.total} | ${s.complete} | ${pct}% | ${gap} | ${topReasons} |`);
}
