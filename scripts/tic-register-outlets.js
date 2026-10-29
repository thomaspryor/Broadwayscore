#!/usr/bin/env node
/**
 * Register Chicago outlets seen on theatreinchicago.com in data/outlet-registry.json
 * with explicit tiers (BRO-6518). The rebuild's auto-register would file them all
 * at tier 3; Chicago dailies are T2 and the blogs T4.
 *
 *   node scripts/tic-register-outlets.js [--write]     (default: dry-run diff)
 */
const fs = require('fs');
const path = require('path');
const REG = path.join(__dirname, '..', 'data', 'outlet-registry.json');
const IDX = path.join(__dirname, '..', 'data', 'theatreinchicago-index.json');

const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '');
// Explicit tiers; anything not listed is a blog/small site -> tier 4.
const TIER2 = ['Chicago Tribune', 'Chicago Sun-Times'];
const TIER3 = ['Chicago Reader', 'NewCity Chicago', 'Newcity', 'Third Coast Review', 'WTTW', 'Daily Herald', 'Chicago Theatre Review', 'Windy City Times', 'Chicago Stage Review', 'Time Out Chicago', 'Chicago Magazine', 'Variety', 'Hollywood Reporter', 'Evanston RoundTable', 'Evanston Roundtable', 'Pioneer Press', 'Chicago Theater Beat', 'Crain\'s Chicago Business', 'Chicago Business'];
const tierOf = (name) => {
  const n = norm(name);
  if (TIER2.some((x) => norm(x) === n)) return 2;
  if (TIER3.some((x) => norm(x) === n)) return 3;
  return 4;
};

function main() {
  const reg = JSON.parse(fs.readFileSync(REG, 'utf8'));
  const idx = JSON.parse(fs.readFileSync(IDX, 'utf8'));
  const known = new Set();
  for (const [k, o] of Object.entries(reg.outlets)) { known.add(norm(k)); (o.aliases || []).forEach((a) => known.add(norm(a))); }
  const seen = {};
  for (const s of Object.values(idx.shows)) for (const r of s.r) {
    const e = (seen[r.o] ||= { n: 0, hosts: {} });
    e.n++;
    try { const h = new URL(r.u).hostname.replace(/^www\./, ''); e.hosts[h] = (e.hosts[h] || 0) + 1; } catch {}
  }
  const add = [];
  for (const [name, e] of Object.entries(seen)) {
    if (known.has(norm(name))) continue;
    const domain = Object.entries(e.hosts).sort((a, b) => b[1] - a[1])[0]?.[0];
    const id = norm(name);
    add.push({ id, entry: { displayName: name, tier: tierOf(name), aliases: [...new Set([id, name.toLowerCase()])], ...(domain ? { domain } : {}), region: 'chicago', accessModel: tierOf(name) === 2 ? 'metered' : 'free' }, n: e.n });
  }
  add.sort((a, b) => b.n - a.n);
  for (const a of add) console.log(`${a.entry.tier} ${a.entry.displayName} (${a.entry.domain || '?'}) x${a.n}`);
  if (process.argv.includes('--write')) {
    for (const a of add) reg.outlets[a.id] = a.entry;
    fs.writeFileSync(REG, JSON.stringify(reg, null, 2) + '\n');
    console.log(`wrote ${add.length} outlets`);
  }
}
if (require.main === module) main();
