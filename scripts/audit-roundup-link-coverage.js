#!/usr/bin/env node
/**
 * audit-roundup-link-coverage.js (BRO-5557): every review link on an archived
 * BroadwayWorld roundup / Playbill Verdict page, checked against reviews.json
 * and data/review-texts. Reports links we hold nowhere ("missing") and links we
 * ingested but excluded ("excluded", with the reason) so a roundup that names a
 * review we never scored is a finding, not something the owner spots by eye.
 *
 * Usage: node scripts/audit-roundup-link-coverage.js [--since=YYYY-MM-DD] [--market=broadway|west-end|...|all] [--show=ID] [--json=PATH] [--strict]
 *   --since   only shows opened on/after this date (default: 45 days ago)
 *   --market  show market to scan (default broadway; a West End show's archived roundup is often the
 *             New York production of the same title, which is a different bug and floods the report)
 *   --strict  exit 1 when any link is missing (advisory by default, CLAUDE.md §19)
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { reviewLinksForShow, classifyLinks } = require('./lib/roundup-link-coverage');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log(`Usage: node scripts/audit-roundup-link-coverage.js [--since=YYYY-MM-DD] [--market=broadway|west-end|all] [--show=ID] [--json=PATH] [--strict]
Lists review links named on archived BroadwayWorld roundup / Playbill Verdict pages that data/reviews.json does not hold. Advisory; exits 0 unless --strict and a link is missing.`);
  process.exit(0);
}
const arg = (k) => (args.find((a) => a.startsWith(`--${k}=`)) || '').split('=').slice(1).join('=');
const since = arg('since') || new Date(Date.now() - 45 * 86400000).toISOString().slice(0, 10);
const onlyShow = arg('show');
const market = arg('market') || 'broadway';
const jsonOut = arg('json');
const STRICT = args.includes('--strict');

const shows = (j => (Array.isArray(j) ? j : j.shows))(JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'shows.json'), 'utf8')));
const reviews = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'reviews.json'), 'utf8')).reviews;
const rowsByShow = new Map();
for (const r of reviews) { if (!rowsByShow.has(r.showId)) rowsByShow.set(r.showId, []); rowsByShow.get(r.showId).push(r); }

const KINDS = ['bww-roundups', 'playbill-verdict'];
const report = [];
for (const s of shows) {
  if (onlyShow ? s.id !== onlyShow : ((s.openingDate || '') < since || (market !== 'all' && s.market !== market))) continue;
  const dir = path.join(ROOT, 'data', 'review-texts', s.id);
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => {
    try { return { ...JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')), __file: f }; } catch { return null; }
  }).filter(Boolean) : [];
  for (const kind of KINDS) {
    const p = path.join(ROOT, 'data', 'aggregator-archive', kind, `${s.id}.html`);
    if (!fs.existsSync(p)) continue;
    const links = reviewLinksForShow(fs.readFileSync(p, 'utf8'), kind, s);
    for (const c of classifyLinks(links, rowsByShow.get(s.id) || [], files)) {
      if (c.status !== 'covered') report.push({ showId: s.id, source: kind, ...c });
    }
  }
}

const missing = report.filter((r) => r.status === 'missing');
const excluded = report.filter((r) => r.status === 'excluded');
console.log(`Roundup links not in reviews.json (shows opened since ${since}, market ${market}): ${missing.length} missing, ${excluded.length} excluded`);
console.log('APPROXIMATE: a link is skipped when its slug names another show or an out-of-window year, and counted covered when we hold as many rows on that site; see the blind spots in scripts/lib/roundup-link-coverage.js. Read the rows, do not trust their absence.');
for (const r of [...missing, ...excluded]) {
  console.log(`  [${r.status}${r.reason ? ` ${r.reason}` : ''}] ${r.showId} (${r.source}) ${r.label} ${r.url}`);
}
if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify({ since, missing, excluded }, null, 2) + '\n');
process.exit(STRICT && missing.length ? 1 : 0);
