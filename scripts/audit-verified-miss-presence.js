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
const ROOT = path.join(__dirname, '..');

function fold(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
}
const OUTLET_STOP = new Set(['the', 'new', 'york', 'london', 'uk', 'com', 'online', 'theatre', 'theater', 'review', 'reviews']);
function outletKey(s) {
  return fold(s).split(' ').filter((w) => !OUTLET_STOP.has(w)).join('') || fold(s).replace(/ /g, '');
}
const REGION = new Set(['york', 'london']);
const regionOf = (s) => fold(s).split(' ').filter((w) => REGION.has(w)).sort().join(',');
function sameOutlet(a, b) {
  // "The New York Times" must not match "The Times", nor Time Out New York match Time Out London.
  if (regionOf(a) !== regionOf(b)) return false;
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
  if (require('./lib/cli-help.js').hasHelpFlag(argv)) {
    console.log('audit-verified-miss-presence.js [--json] [--rows] [--tier=N]: per-cohort count of verified misses now present in reviews.json (read-only)');
    return;
  }
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
  if (argv.includes('--diagnose')) {
    const dir = ['data/review-texts', '/home/user/broadway-review-texts/data/review-texts'].map((p) => path.join(ROOT, p)).find((p) => fs.existsSync(p));
    if (!dir) { console.log('DIAGNOSE: data/review-texts not available (run via cloud-run-script.js --review-texts)'); return; }
    const tally = {};
    for (const r of rows.filter((x) => !x.present)) {
      const g = diagnose(r, loadShowFiles(dir, r.id));
      const k = g.stuck.split(':')[0];
      tally[k] = (tally[k] || 0) + 1;
      console.log(`STUCK ${r.cohort} ${r.id} ${r.outlet} :: ${g.stuck} file=${g.file} by=${g.matchedBy || '-'} textLen=${g.textLen ?? '-'} scores=${JSON.stringify(g.scores || {})}`);
    }
    console.log('TALLY', JSON.stringify(tally));
    return;
  }
  if (argv.includes('--rows')) for (const r of rows.filter((x) => !x.present)) console.log(`ABSENT ${r.cohort} ${r.id} ${r.outlet} ${r.url} texts=${r.inTextsDir}`);
}

const PROSE = /text|excerpt|quote|summary|body|content$|snippet|html/i;
/**
 * Pure: where is an absent miss stuck? `files` = [{file, data}] from the show's review-texts dir.
 * Never returns prose: only the file name, truthy flags, scores and text length.
 */
function diagnose(miss, files) {
  const mu = normUrl(miss.url);
  const hit = files.find((f) => normUrl(f.data.url) === mu)
    || files.find((f) => sameOutlet(f.data.outlet || f.data.outletId, miss.outlet));
  if (!hit) return { stuck: 'no-file', file: null };
  const d = hit.data;
  const flags = Object.keys(d).filter((k) => d[k] === true && !PROSE.test(k));
  const text = String(d.fullText || d.text || '');
  const scoreKeys = ['assignedScore', 'llmScore', 'originalScore', 'scoreSource', 'contentTier', 'aggregatorStars'];
  const scores = Object.fromEntries(scoreKeys.filter((k) => d[k] != null).map((k) => [k, d[k]]));
  let stuck = 'unknown';
  if (flags.length) stuck = `flagged:${flags.join(',')}`;
  else if (text.length < 200) stuck = 'no-text';
  else if (d.assignedScore == null && d.llmScore == null && d.originalScore == null) stuck = 'unscored';
  else stuck = 'scored-not-rebuilt';
  return { stuck, file: hit.file, matchedBy: normUrl(d.url) === mu ? 'url' : 'outlet', flags, textLen: text.length, scores };
}

function loadShowFiles(dir, id) {
  const base = path.join(dir, id);
  if (!fs.existsSync(base)) return [];
  return fs.readdirSync(base).filter((f) => f.endsWith('.json')).map((f) => {
    try { return { file: f, data: JSON.parse(fs.readFileSync(path.join(base, f), 'utf8')) }; } catch (_) { return null; }
  }).filter(Boolean);
}

module.exports = { diagnose,  measure, summarize, normUrl, sameOutlet };
if (require.main === module) main();
