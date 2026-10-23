#!/usr/bin/env node
/**
 * audit-verified-miss-presence.js (BRO-6018): progress meter for the BRO-5951
 * verified misses. For each T1/T2 miss in data/audit/crossmodel/verified-misses.json,
 * reports whether data/reviews.json holds it, matched by normalized URL (same
 * canonicalizer the rebuild dedups with) and, failing that, by outlet + critic-free
 * outlet match for the same show. Public URLs only, no review text. Read-only.
 *
 *   node scripts/audit-verified-miss-presence.js [--json] [--rows] [--tier=2]
 */
'use strict';
const fs = require('fs');
const path = require('path');
if (require('./lib/cli-help.js').hasHelpFlag(process.argv.slice(2))) {
  console.log('audit-verified-miss-presence.js [--json] [--rows] [--tier=N]: per-cohort count of verified misses now present in reviews.json (read-only)');
  process.exit(0);
}
const ROOT = path.join(__dirname, '..');

function fold(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
}
const OUTLET_STOP = new Set(['the', 'new', 'york', 'london', 'uk', 'com', 'online', 'theatre', 'theater', 'review', 'reviews']);
function outletKey(s) {
  return fold(s).split(' ').filter((w) => !OUTLET_STOP.has(w)).join('') || fold(s).replace(/ /g, '');
}
function sameOutlet(a, b) {
  const x = outletKey(a); const y = outletKey(b);
  return !!x && !!y && (x === y || (Math.min(x.length, y.length) >= 6 && (x.includes(y) || y.includes(x))));
}
function normUrl(u) {
  if (!u) return null;
  let c = null;
  try { c = require('./lib/review-guards.js').canonicalizeUrlForDedup(u); } catch (_) { /* fall through */ }
  c = c || String(u).trim().toLowerCase().replace(/[?#].*$/, '').replace(/\/+$/, '');
  return c.replace(/^https?:\/\//, '').replace(/^www\./, '');
}

/** Pure: misses + reviews -> rows [{...miss, present, via}] */
function measure(misses, reviews) {
  const byShow = new Map();
  for (const r of reviews) {
    if (!byShow.has(r.showId)) byShow.set(r.showId, []);
    byShow.get(r.showId).push(r);
  }
  return misses.map((m) => {
    const ours = byShow.get(m.id) || [];
    const mu = normUrl(m.url);
    if (mu && ours.some((r) => normUrl(r.url) === mu)) return { ...m, present: true, via: 'url' };
    if (ours.some((r) => sameOutlet(r.outlet || r.outletId, m.outlet) || sameOutlet(r.outletId, m.outlet))) return { ...m, present: true, via: 'outlet' };
    return { ...m, present: false, via: null };
  });
}

function summarize(rows) {
  const out = {};
  for (const r of rows) {
    const c = (out[r.cohort] = out[r.cohort] || { total: 0, url: 0, outlet: 0, absent: 0 });
    c.total++;
    if (r.via === 'url') c.url++; else if (r.via === 'outlet') c.outlet++; else c.absent++;
  }
  return out;
}

function main() {
  const argv = process.argv.slice(2);
  const tiers = argv.find((a) => a.startsWith('--tier=')) ? [Number(argv.find((a) => a.startsWith('--tier=')).slice(7))] : [1, 2];
  const misses = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/audit/crossmodel/verified-misses.json'), 'utf8')).filter((m) => tiers.includes(m.tier));
  const reviews = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/reviews.json'), 'utf8')).reviews;
  const rows = measure(misses, reviews);
  const sum = summarize(rows);
  if (argv.includes('--json')) { console.log(JSON.stringify(argv.includes('--rows') ? rows : sum, null, 2)); return; }
  let t = 0; let u = 0; let o = 0;
  console.log('cohort           total  byUrl  byOutletOnly  absent');
  for (const [c, v] of Object.entries(sum).sort()) {
    console.log(`${c.padEnd(16)} ${String(v.total).padStart(5)} ${String(v.url).padStart(6)} ${String(v.outlet).padStart(12)} ${String(v.absent).padStart(7)}`);
    t += v.total; u += v.url; o += v.outlet;
  }
  console.log(`TOTAL            ${String(t).padStart(5)} ${String(u).padStart(6)} ${String(o).padStart(12)} ${String(t - u - o).padStart(7)}   present(url+outlet)=${u + o}/${t}, url-only=${u}/${t}`);
  if (argv.includes('--rows')) for (const r of rows.filter((x) => !x.present)) console.log(`ABSENT ${r.cohort} ${r.id} ${r.outlet} ${r.url} texts=${r.inTextsDir}`);
}

module.exports = { measure, summarize, normUrl, sameOutlet };
if (require.main === module) main();
