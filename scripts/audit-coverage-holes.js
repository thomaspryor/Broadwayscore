#!/usr/bin/env node
'use strict';
/**
 * audit-coverage-holes.js (BRO-4849) — counts the four classes of "found reviews that never reach the site" across
 * every show open or opened in the last 120 days. Predicates live in scripts/lib/coverage-holes.js.
 *
 *   node scripts/audit-coverage-holes.js [--json=PATH] [--days=120] [--show=ID] [--strict] [--list=A|B|C|D]
 *
 * Advisory by default (exit 0). --strict exits 1 when A, B, C or a PUBLISHED D row (or an unreadable file) exists (arm only after the backlog is triaged,
 * CLAUDE.md section 19: new gates land advisory first).
 */
const { hasHelpFlag } = require('./lib/cli-help.js');
if (hasHelpFlag(process.argv.slice(2))) {
  console.log('Usage:\n  node scripts/audit-coverage-holes.js [--json=PATH] [--days=120] [--show=ID] [--strict] [--list=A|B|C|D]\n  --strict   exit 1 on any A, B or C row, a published D row, or an unreadable file (advisory by default)\n  --list=X   print every row of one class');
  process.exit(0);
}
const fs = require('fs');
const path = require('path');
const holes = require('./lib/coverage-holes');

const ROOT = path.join(__dirname, '..');
const arg = (n) => { const a = process.argv.find((x) => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : null; };

function sweep({ root = ROOT, days = 120, only = null, now = Date.now() } = {}) {
  const raw = JSON.parse(fs.readFileSync(path.join(root, 'data', 'shows.json'), 'utf8'));
  const shows = (Array.isArray(raw) ? raw : raw.shows || []).filter((s) => (only ? s.id === only : holes.isCurrentShow(s, now, days)));
  // reviews.json is the source of truth for what the site shows: D rows that are PUBLISHED are the ones doing harm.
  const published = new Set();
  try { for (const r of JSON.parse(fs.readFileSync(path.join(root, 'data', 'reviews.json'), 'utf8')).reviews || []) if (r && r.showId && r.url) published.add(`${r.showId}|${r.url}`); } catch { /* none readable: published counts stay 0 */ }
  const out = { shows: shows.length, files: 0, unreadable: 0, A: [], B: [], C: [], D: [], showsAffected: 0 };
  const affected = new Set();
  for (const show of shows) {
    const dir = path.join(root, 'data', 'review-texts', show.id);
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json') || f === 'failed-fetches.json') continue;
      const filePath = path.join(dir, f);
      let d;
      try { d = JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { out.unreadable++; continue; } // counted: corruption must not hide
      out.files++;
      const c = holes.classify(d, show, filePath);
      if (c.D) c.D = { ...c.D, published: !!(d.url && published.has(`${show.id}|${d.url}`)) };
      for (const [k, v] of Object.entries(c)) {
        out[k].push({ file: `${show.id}/${f}`, outletId: d.outletId || null, ...v });
        affected.add(show.id);
      }
    }
  }
  out.showsAffected = affected.size;
  return out;
}

function summary(out) {
  const tally = (rows, key) => rows.reduce((a, r) => { const k = String(r[key]); a[k] = (a[k] || 0) + 1; return a; }, {});
  return [
    `shows=${out.shows} files=${out.files} unreadable=${out.unreadable} showsAffected=${out.showsAffected}`,
    `A noUsableText=${out.A.length} ${JSON.stringify(tally(out.A, 'bucket'))}`,
    `B rejectedYetVerified=${out.B.length} urlOtherShow=${out.B.filter((r) => r.urlOtherShow).length} (repair the URL) / ${out.B.filter((r) => !r.urlOtherShow).length} (read the text) blockedBy=${JSON.stringify(tally(out.B, 'blockedBy'))}`,
    `C neverScored=${out.C.length} alreadyQueued=${out.C.filter((r) => r.queued).length}`,
    `D blockedUrlUnflagged=${out.D.length} ${JSON.stringify(tally(out.D, 'kind'))} publishedOnSite=${out.D.filter((r) => r.published).length} (the harm; the rest is hygiene)`,
  ].join('\n');
}

module.exports = { sweep, summary };

if (require.main === module) {
  const out = sweep({ days: Number(arg('days') || 120), only: arg('show') });
  console.log(summary(out));
  const list = arg('list');
  if (list && out[list]) for (const r of out[list]) console.log(JSON.stringify(r));
  if (arg('json')) fs.writeFileSync(arg('json'), JSON.stringify(out, null, 2));
  // D only counts when published: a blocked URL the rebuild already drops is hygiene, not a leak.
  if (process.argv.includes('--strict') && (out.A.length || out.B.length || out.C.length || out.D.some((r) => r.published) || out.unreadable)) process.exit(1);
}
