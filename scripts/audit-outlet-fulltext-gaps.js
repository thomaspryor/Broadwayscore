#!/usr/bin/env node
// BRO-7569: full-text rate per major outlet for 2025/2026-production reviews.
// Usage: node scripts/audit-outlet-fulltext-gaps.js [--json] [outlet ...]  (outlets => list gap files)
const fs = require('fs');
const path = require('path');
const root = process.env.REVIEW_TEXTS_DIR || path.join(__dirname, '..', 'data', 'review-texts');
const base = fs.existsSync(root + '/data/review-texts') ? root + '/data/review-texts' : root;
const WANT = ['nytimes','nyt-theater','wsj','washpost','newyorker','financialtimes','times-uk','telegraph','thestage','vulture','variety','standard','independent','guardian'];
const args = process.argv.slice(2);
const asJson = args.includes('--json');
const list = args.filter(a => !a.startsWith('--'));
const t = {}; const gaps = [];
// Tier as the rebuild will write it (current classifier), so a fix to the classifier shows up
// before the nightly rebuild re-tiers the stored files. manualContentTier always wins.
const { classifyTierWriteBack } = require('./lib/content-tier-reason-sync');
function liveTier(r) {
  if (r.manualContentTier) return r.manualContentTier;
  try { return classifyTierWriteBack(r).tierResult.contentTier || r.contentTier; } catch { return r.contentTier; }
}
// An Unknown-critic, no-url aggregator placeholder beside a complete file by the same outlet for the same show
// is a duplicate row of that review (BRO-7569), not a second review missing its text.
function siblingComplete(show, file, outlet) {
  let fl; try { fl = fs.readdirSync(path.join(base, show)); } catch { return false; }
  return fl.some((g) => g !== file && g.startsWith(outlet + '--') && g.endsWith('.json') && (() => {
    try { const d = JSON.parse(fs.readFileSync(path.join(base, show, g))); return d.contentTier === 'complete' && !!d.url && !d.wrongShow && !d.wrongProduction && !d.isRoundupArticle && !d.duplicateOf; } catch { return false; }
  })());
}
function isFull(r) { return (r.fullText || '').length >= 1500 && !/truncat|excerpt|stub|invalid/.test(r.tier || ''); }
for (const s of fs.readdirSync(base)) {
  if (!/-(2025|2026)(\b|-)/.test(s)) continue;
  let fl; try { fl = fs.readdirSync(path.join(base, s)); } catch { continue; }
  for (const f of fl) {
    if (!f.endsWith('.json') || f.startsWith('_')) continue;
    let r; try { r = JSON.parse(fs.readFileSync(path.join(base, s, f))); } catch { continue; }
    r.tier = liveTier(r);
    const o = r.outletId || f.split('--')[0];
    if (!WANT.includes(o)) continue;
    if (r.wrongProduction || r.wrongShow || r.isRoundupArticle || r.duplicateOf) continue;
    const x = t[o] || (t[o] = { n: 0, full: 0, documented: 0 }); x.n++;
    if (isFull(r)) x.full++;
    else if (r.criticName === 'Unknown' && !r.url && !(r.fullText || '').trim() && siblingComplete(s, f, o)) { x.dupCovered = (x.dupCovered || 0) + 1; }
    else if (r.textUnrecoverable && require('./lib/gap-terminal').validateTerminal(r).valid) { x.documented++; }
    else gaps.push({ outlet: o, show: s, file: f, tier: r.tier || 'none', len: (r.fullText || '').length, url: r.url, reason: r.contentTierReason || r.incompleteReason || '' });
  }
}
if (asJson) { console.log(JSON.stringify({ rates: t, gaps }, null, 1)); process.exit(0); }
for (const [o, x] of Object.entries(t).sort((a, b) => b[1].n - a[1].n))
  console.log(o.padEnd(16), String(x.n).padStart(4), 'reviews', String(x.full).padStart(4), 'full', String(x.documented).padStart(3), 'terminal', String(x.dupCovered || 0).padStart(3), 'dup-placeholder', (100 * (x.full + x.documented + (x.dupCovered || 0)) / x.n).toFixed(0).padStart(4) + '%');
for (const o of list) { console.log(`--- gaps: ${o}`); gaps.filter(g => g.outlet === o).forEach(g => console.log(`  ${g.show}/${g.file} [${g.tier}] len=${g.len} ${g.url}`)); }
