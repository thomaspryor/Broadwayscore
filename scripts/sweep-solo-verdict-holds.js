#!/usr/bin/env node
'use strict';
/**
 * BRO-7050 sweep: lists every review hidden by a lone automated classifier verdict although an
 * aggregator lists it or the scorer scored it from full text. DRY RUN by default (read-only).
 *   node scripts/sweep-solo-verdict-holds.js [--since=2025-11-01] [--json=out.json] [--plan=out.json]
 * --plan writes a pending-fix plan of ids only (no review text) for the restores.
 */
const fs = require('fs');
const path = require('path');
const { explainExclusion, soloVerdictHeld } = require('./lib/review-guards');
const arg = (n, d) => (process.argv.find((a) => a.startsWith(`--${n}=`)) || '').split('=').slice(1).join('=') || d;
const since = arg('since', '2025-11-01');
const root = path.join(__dirname, '..', 'data', 'review-texts');
const shows = require('../data/shows.json');
const list = Array.isArray(shows) ? shows : shows.shows;
const rows = [];
const counts = {};
const hiddenWithoutGuard = (data, show, file) => {
  process.env.SINGLE_VERDICT_GUARD_DISABLED = '1';
  try { return explainExclusion(data, show, file); } finally { delete process.env.SINGLE_VERDICT_GUARD_DISABLED; }
};
for (const show of list) {
  if (!show.openingDate || show.openingDate < since) continue;
  const dir = path.join(root, show.id);
  if (!fs.existsSync(dir)) continue;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    const fp = path.join(dir, f);
    let data;
    try { data = JSON.parse(fs.readFileSync(fp, 'utf8')); } catch { continue; }
    const kinds = [];
    if (data.isNonReview === true) kinds.push('nonReview');
    if (data.wrongProduction === true) kinds.push('wrongProduction');
    if (data.wrongShow === true) kinds.push('wrongShow');
    if (data.rejectionReason) kinds.push('rejection');
    if (!kinds.length) continue;
    const holds = kinds.map((k) => [k, soloVerdictHeld(data, k)]).filter(([, h]) => h.held);
    if (!holds.length) continue;
    const before = hiddenWithoutGuard(data, show, fp);
    if (!before) continue; // not hidden today
    const after = explainExclusion(data, show, fp);
    const restored = !after;
    for (const [k, h] of holds) {
      const key = `${k}/${h.families.join('+')}/${restored ? 'restored' : 'still-excluded:' + after}`;
      counts[key] = (counts[key] || 0) + 1;
    }
    rows.push({ showId: show.id, file: f, outletId: data.outletId || null, kinds: holds.map(([k]) => k),
      families: [...new Set(holds.flatMap(([, h]) => h.families))], listedBy: holds[0][1].listedBy,
      scored: holds[0][1].scored, hiddenBy: before, afterGuard: after || null, restored });
  }
}
console.log(`hidden today & held by guard: ${rows.length} (restored ${rows.filter((r) => r.restored).length})`);
for (const [k, v] of Object.entries(counts).sort((a, b) => b[1] - a[1])) console.log(String(v).padStart(5), k);
const out = arg('json', '');
if (out) fs.writeFileSync(out, JSON.stringify(rows, null, 2));
const plan = arg('plan', '');
if (plan) {
  fs.writeFileSync(plan, JSON.stringify({ issue: 'BRO-7050', note: 'ids only; restore = stop hiding via the single-verdict hold (flags stay on disk)',
    restores: rows.filter((r) => r.restored).map((r) => ({ showId: r.showId, file: r.file, families: r.families })) }, null, 2));
}
