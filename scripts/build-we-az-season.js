#!/usr/bin/env node
/**
 * Theatre Record A-Z of London productions -> one season's title list
 * (BRO-6298, extends BRO-6268).
 *
 * Input: positioned-line dumps (`AZL|issue|page|x|y|x2|text`, printed by
 * `probe-tr-scanned.js azraw` in we-historical-tr-ocr-probe.yml). Each issue
 * is parsed by lib/tr-az-parse.js, entries are merged across issues by
 * normalised title, and a title is kept when the A-Z does not date it outside
 * the season window. Output is a public audit file: titles, venues, dates
 * from the A-Z listing, never review text.
 *
 * Usage:
 *   node scripts/build-we-az-season.js --season=2015-2016 --lines=<dump.txt>[,<more>]
 */
// venue-write-guard-ok: reads Theatre Record A-Z text and builds audit lookups; nothing here writes shows.json
'use strict';

const fs = require('fs');
const path = require('path');
const { parseAzText, parseAzLines } = require('./lib/tr-az-parse');
const { validateSeason } = require('./lib/we-seasons');
const { normalizeTitle } = require('./lib/title-match');

const ROOT = path.join(__dirname, '..');
const outPath = season => path.join(ROOT, 'data', 'audit', `we-historical-az-${season}.json`);

/** Merge per-issue parses into one row per title. */
function mergeIssues(parsed) {
  const rows = new Map();
  for (const { issue, asAt, entries } of parsed) {
    for (const e of entries) {
      const key = normalizeTitle(e.title);
      if (!key) continue;
      const r = rows.get(key) || { title: e.title, venue: null, opened: null, seasonFrom: null, seasonTo: null, issues: [], firstAsAt: asAt, lastAsAt: asAt };
      if (!r.issues.includes(issue)) r.issues.push(issue);
      if (e.venue && !r.venue) r.venue = e.venue;
      if (e.opened && !r.opened) r.opened = e.opened;
      // 2015-layout limited runs give "season dd.mm-dd.mm.yy" instead of an opened date.
      if (e.seasonFrom && !r.seasonFrom) { r.seasonFrom = e.seasonFrom; r.seasonTo = e.seasonTo || null; }
      if (asAt && (!r.firstAsAt || asAt < r.firstAsAt)) r.firstAsAt = asAt;
      if (asAt && (!r.lastAsAt || asAt > r.lastAsAt)) r.lastAsAt = asAt;
      rows.set(key, r);
    }
  }
  return [...rows.values()].sort((a, b) => a.title.localeCompare(b.title));
}

/** Keep a title unless the A-Z dates its opening (or season start) outside [start, end]. */
function inSeason(row, start, end) {
  const d = row.opened || row.seasonFrom;
  return !d || (d >= start && d <= end);
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) { console.log('usage: node scripts/build-we-az-season.js --season=2015-2016 --lines=<dump.txt>[,<dump.txt>]'); process.exit(0); }
  const opt = n => (args.find(a => a.startsWith(`--${n}=`)) || '').split('=').slice(1).join('=');
  const season = opt('season');
  const files = opt('lines').split(',').filter(Boolean);
  if (!season || !files.length) { console.error('usage: --season=2015-2016 --lines=<dump>[,<dump>]'); process.exit(2); }
  validateSeason(season);
  const [y1, y2] = season.split('-');
  const start = `${y1}-09-01`;
  const end = `${y2}-08-31`;
  const lines = files.flatMap(f => parseAzText(fs.readFileSync(f, 'utf8')));
  const byIssue = {};
  for (const l of lines) (byIssue[l.issue] = byIssue[l.issue] || []).push(l);
  const parsed = Object.keys(byIssue).map(issue => ({ issue, ...parseAzLines(byIssue[issue]) }));
  const merged = mergeIssues(parsed);
  const titles = merged.filter(r => inSeason(r, start, end));
  const out = {
    generatedAt: new Date().toISOString(),
    season,
    issues: parsed.map(p => ({ issue: p.issue, format: p.format, asAt: p.asAt, entries: p.entries.length })),
    counts: { merged: merged.length, inSeasonOrUndated: titles.length },
    titles,
  };
  fs.writeFileSync(outPath(season), JSON.stringify(out, null, 2) + '\n');
  console.log(`wrote ${path.relative(ROOT, outPath(season))}: ${merged.length} titles, ${titles.length} kept for ${season}`);
}

if (require.main === module) main();
module.exports = { mergeIssues, inSeason };
