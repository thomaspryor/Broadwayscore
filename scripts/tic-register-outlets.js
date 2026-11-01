#!/usr/bin/env node
/**
 * Register Chicago outlets seen on theatreinchicago.com in data/outlet-registry.json
 * with explicit tiers (BRO-6518). The rebuild's auto-register would file them all
 * at tier 3; Chicago dailies are T2 and the blogs T4.
 *
 *   node scripts/tic-register-outlets.js [--write]     (default: dry-run diff)
 *   node scripts/tic-register-outlets.js --city=dc --manifest=<staged manifest> [--write]   (BRO-6771)
 */
require('./lib/cli-help').exitOnHelp(module);
const fs = require('fs');
const path = require('path');
const REG = path.join(__dirname, '..', 'data', 'outlet-registry.json');
const IDX = path.join(__dirname, '..', 'data', 'theatreinchicago-index.json');

const { foldDiacritics } = require('./lib/title-match');
const norm = (s) => foldDiacritics(String(s)).toLowerCase().replace(/[^a-z0-9]+/g, '');
// Explicit tiers; anything not listed is a blog/small site -> tier 4.
const TIER2 = ['Chicago Tribune', 'Chicago Sun-Times'];
const TIER3 = ['Chicago Reader', 'NewCity Chicago', 'Newcity', 'Third Coast Review', 'WTTW', 'Daily Herald', 'Chicago Theatre Review', 'Windy City Times', 'Chicago Stage Review', 'Time Out Chicago', 'Chicago Magazine', 'Variety', 'Hollywood Reporter', 'Evanston RoundTable', 'Evanston Roundtable', 'Pioneer Press', 'Chicago Theater Beat', 'Crain\'s Chicago Business', 'Chicago Business'];
// Washington DC (BRO-6771): the Post is T1 in the registry already; dailies and the area's
// established theatre sites are T2/T3, blogs T4.
const DC_TIER2 = ['Washington City Paper', 'DC Theatre Scene', 'DCTheaterScene', 'Washingtonian'];
const DC_TIER3 = ['Washington Blade', 'DC Theater Arts', 'MD Theatre Guide', 'Maryland Theatre Guide', 'Metro Weekly', 'Stage and Cinema', 'Washington Examiner', 'DCist', 'Axios', 'Variety', 'Hollywood Reporter', 'Capital Gazette', 'ARLnow', 'Bethesda Magazine', 'Montgomery Community Media', 'K Street Magazine', 'Broadway World', 'BroadwayWorld'];
const getArg = (k) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : null; };
const CITY = getArg('city') || 'chicago';
const REGION = CITY === 'dc' ? 'washington-dc' : 'chicago';
const tierOf = (name) => {
  const n = norm(name);
  const [t2, t3] = CITY === 'dc' ? [DC_TIER2, DC_TIER3] : [TIER2, TIER3];
  if (t2.some((x) => norm(x) === n)) return 2;
  if (t3.some((x) => norm(x) === n)) return 3;
  return 4;
};

function main() {
  const reg = JSON.parse(fs.readFileSync(REG, 'utf8'));
  // Chicago reads the whole crawl index; DC reads only the staged (accepted) shows' reviews.
  const manifestPath = getArg('manifest');
  const idx = manifestPath
    ? { shows: Object.fromEntries(Object.entries(JSON.parse(fs.readFileSync(manifestPath, 'utf8')).staged).map(([k, v]) => [k, { r: v.reviews.map((r) => ({ o: r.outlet, u: r.url })) }])) }
    : JSON.parse(fs.readFileSync(IDX, 'utf8'));
  const known = new Set();
  for (const [k, o] of Object.entries(reg.outlets)) { known.add(norm(k)); (o.aliases || []).forEach((a) => known.add(norm(a))); }
  const seen = {};
  for (const s of Object.values(idx.shows)) for (const r of s.r) {
    const e = (seen[r.o] ||= { n: 0, hosts: {} });
    e.n++;
    try { const h = new URL(r.u).hostname.replace(/^www\./, ''); e.hosts[h] = (e.hosts[h] || 0) + 1; } catch {}
  }
  const add = [];
  // A second name for a site already in the registry (or already queued) is an alias
  // of that outlet; a second outlet on one domain fails the domain-collision gate.
  const byDomain = new Map();
  for (const [oid, o] of Object.entries(reg.outlets)) if (o.domain) byDomain.set(o.domain.replace(/^www\./, ''), { id: oid, entry: o });
  const aliasOnly = [];
  for (const [name, e] of Object.entries(seen)) {
    if (known.has(norm(name))) continue;
    const domain = Object.entries(e.hosts).sort((a, b) => b[1] - a[1])[0]?.[0];
    const id = norm(name);
    const twin = domain && byDomain.get(domain);
    // medium.com / blogspot / substack host many unrelated writers: never alias a blog name onto the platform's outlet.
    if (twin && /(^|\.)(medium\.com|blogspot\.com|substack\.com|wordpress\.com)$/.test(domain)) { console.log(`skip ${name}: shared platform ${domain}`); continue; }
    if (twin) { aliasOnly.push({ twin, alias: name.toLowerCase(), id }); continue; }
    if (domain) byDomain.set(domain, { id, entry: null });
    add.push({ id, entry: { displayName: name, tier: tierOf(name), aliases: [...new Set([id, name.toLowerCase()])], ...(domain ? { domain } : {}), region: REGION, accessModel: tierOf(name) === 2 ? 'metered' : 'free' }, n: e.n });
  }
  add.sort((a, b) => b.n - a.n);
  for (const a of aliasOnly) console.log(`alias ${a.alias} -> ${a.twin.id}`);
  for (const a of add) console.log(`${a.entry.tier} ${a.entry.displayName} (${a.entry.domain || '?'}) x${a.n}`);
  if (process.argv.includes('--write')) {
    for (const a of add) reg.outlets[a.id] = a.entry;
    for (const a of aliasOnly) {
      const o = reg.outlets[a.twin.id];
      o.aliases = [...new Set([...(o.aliases || []), a.alias, a.id])];
    }
    fs.writeFileSync(REG, JSON.stringify(reg, null, 2) + '\n');
    console.log(`wrote ${add.length} outlets`);
  }
}
if (require.main === module) main();
