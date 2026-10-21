#!/usr/bin/env node
'use strict';
/**
 * audit-cast-vs-reviews — report shows whose cast on file is named in none of
 * their reviews (the King of the Yees failure: a web-search backfill took
 * another company's cast and nothing re-checked it once reviews landed).
 *
 *   node scripts/audit-cast-vs-reviews.js [--show=ID] [--json] [--suspect] [--strict]
 *                                         [--shows=PATH] [--reviews=DIR] [--cast=DIR]
 *   --suspect  also list the advisory class (big cast, <20% named)
 *   --strict   exit 1 when any show is `contradicted` (lands advisory first, CLAUDE.md §19)
 *
 * Report-only. Fix a hit with a data/pending-fixes plan (data-edit on `cast`) and
 * correct data/cast/<id>.json so enrich-cast-from-files does not copy it back.
 */
const fs = require('fs');
const path = require('path');
const { crossCheckCast, explainContradiction, loadEvidenceTexts } = require('./lib/cast-review-crosscheck');

require('./lib/cli-help').exitOnHelp(module);

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const opt = (k) => (args.find((a) => a.startsWith(`--${k}=`)) || '').slice(k.length + 3) || null;
const only = opt('show');
const showsPath = opt('shows') || path.join(ROOT, 'data', 'shows.json');
const reviewsDir = opt('reviews') || path.join(ROOT, 'data', 'review-texts');
const castDir = opt('cast') || path.join(ROOT, 'data', 'cast');
const readCastFile = (id) => { try { return JSON.parse(fs.readFileSync(path.join(castDir, `${id}.json`), 'utf8')); } catch { return null; } };
const asJson = args.includes('--json');

const raw = JSON.parse(fs.readFileSync(showsPath, 'utf8'));
const shows = Array.isArray(raw) ? raw : raw.shows;

const hits = [];
const explained = []; // open rows listing today's company while reviews name the opening one (BRO-5857)
let checked = 0;
for (const s of shows) {
  if (only && s.id !== only) continue;
  const texts = loadEvidenceTexts(path.join(reviewsDir, s.id));
  const r = crossCheckCast(s.cast, texts);
  if (r.verdict === 'insufficient') continue;
  if (r.verdict === 'contradicted') {
    const why = explainContradiction(s, readCastFile(s.id), texts);
    if (why) { explained.push({ showId: s.id, why }); r.verdict = 'ok'; }
  }
  checked++;
  if (r.verdict === 'contradicted' || (r.verdict === 'suspect' && args.includes('--suspect'))) {
    hits.push({ showId: s.id, title: s.title, verdict: r.verdict, texts: r.texts, onFile: r.names, named: r.named.length, missing: r.missing.slice(0, 8) });
  }
}

if (asJson) console.log(JSON.stringify({ checked, hits, explained }, null, 2));
else {
  console.log(`${checked} shows checked (>=3 full reviews, >=2 named cast); ${hits.length} flagged; ${explained.length} excused`);
  const WHY = { 'current-cast': 'row lists the current company; the reviews name the opening cast on file', 'hand-checked': 'row checked by hand against cast announcements; see HAND_CHECKED' };
  for (const e of explained) console.log(`  ${e.why.padEnd(12)} ${e.showId}  (${WHY[e.why]})`);
  for (const h of hits) console.log(`  ${h.verdict.padEnd(12)} ${h.showId}  (${h.named}/${h.onFile} named in ${h.texts} reviews)  e.g. ${h.missing.slice(0, 4).join(', ')}`);
}
if (args.includes('--strict') && hits.some((h) => h.verdict === 'contradicted')) process.exit(1);
