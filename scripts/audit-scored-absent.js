#!/usr/bin/env node
'use strict';
// BRO-7945: scored+includable review files absent from reviews.json. Advisory by default
// (exit 0, writes data/audit/scored-absent.json); --strict exits 1 on any SILENT drop
// (no recorded rebuild reason, older than the grace window). Run it right after a full
// rebuild: the reasons come from that run's data/audit/rebuild-exclusions-<show>.json.
//   node scripts/audit-scored-absent.js [--strict] [--grace-hours=48] [--no-write]
const fs = require('fs');
const path = require('path');
const { findScoredAbsent, summarizeScoredAbsent } = require('./lib/scored-absent');
const { explainRecoveryExclusion } = require('./lib/recovery-exclusions');
const { isScoreable } = require('./lib/is-scoreable');
const { loadOutletRegistry } = require('./lib/review-normalization');
const { buildOutletRegionMap } = require('./lib/cross-market-guard');
const { normalizeOutlet } = require('./lib/review-normalization');
const { resolveReviewTextsDir } = require('./lib/review-texts-dir');

function run({ root = path.join(__dirname, '..'), argv = process.argv.slice(2), log = console.log } = {}) {
  const strict = argv.includes('--strict');
  const noWrite = argv.includes('--no-write');
  const graceHours = Number((argv.find((a) => a.startsWith('--grace-hours=')) || '').split('=')[1]) || 48;
  const auditDir = path.join(root, 'data', 'audit');
  const shows = JSON.parse(fs.readFileSync(path.join(root, 'data', 'shows.json'), 'utf8'));
  const byId = new Map((Array.isArray(shows) ? shows : shows.shows || []).map((s) => [s.id, s]));
  const reviews = JSON.parse(fs.readFileSync(path.join(root, 'data', 'reviews.json'), 'utf8')).reviews || [];
  const present = new Map();
  for (const r of reviews) { if (!present.has(r.showId)) present.set(r.showId, new Set()); present.get(r.showId).add(r.outletId); }
  const registry = loadOutletRegistry();
  const dual = new Set();
  for (const [id, o] of Object.entries(registry.outlets)) {
    if (!o.isDualMarket) continue;
    dual.add(id); for (const a of o.aliases || []) dual.add(a.toLowerCase());
  }
  const marketContext = { outletRegionMap: buildOutletRegionMap(registry), dualMarketOutlets: dual };
  const explain = (d, s, p) => explainRecoveryExclusion(d, s, p, marketContext);
  const textsDir = resolveReviewTextsDir();
  const rows = [];
  for (const showId of fs.readdirSync(textsDir)) {
    if (/^[_.]/.test(showId)) continue;
    const show = byId.get(showId); if (!show) continue;
    const dir = path.join(textsDir, showId);
    let names; try { names = fs.readdirSync(dir).filter((f) => f.endsWith('.json') && !f.startsWith('_')); } catch { continue; }
    const files = [];
    for (const f of names) {
      try { const fp = path.join(dir, f); files.push({ file: f, data: JSON.parse(fs.readFileSync(fp, 'utf8')), mtimeMs: fs.statSync(fp).mtimeMs }); } catch { /* unreadable: not ours */ }
    }
    const ledger = new Map();
    try {
      for (const e of JSON.parse(fs.readFileSync(path.join(auditDir, `rebuild-exclusions-${showId}.json`), 'utf8')).exclusions || []) ledger.set(e.file, e.reason);
    } catch { /* no ledger for this show */ }
    rows.push(...findScoredAbsent({ showId, show, files, presentOutlets: present.get(showId) || new Set(), ledger, explain, scoreable: isScoreable, normalize: normalizeOutlet, graceHours }));
  }
  const summary = summarizeScoredAbsent(rows);
  log(`scored-absent: total ${summary.total}, explained ${summary.explained}, grace ${summary.grace}, SILENT ${summary.silent}`);
  log(`by reason: ${JSON.stringify(summary.byReason)}`);
  for (const r of rows.filter((x) => x.status === 'silent').slice(0, 25)) log(`  SILENT ${r.showId}/${r.file}`);
  if (!noWrite) {
    fs.mkdirSync(auditDir, { recursive: true });
    fs.writeFileSync(path.join(auditDir, 'scored-absent.json'), JSON.stringify({ generatedAt: new Date().toISOString(), ...summary, rows: rows.slice(0, 400) }, null, 1) + '\n');
  }
  return { summary, rows, exitCode: strict && summary.silent > 0 ? 1 : 0 };
}

if (require.main === module) process.exit(run().exitCode);
module.exports = { run };
