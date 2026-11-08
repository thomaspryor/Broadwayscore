#!/usr/bin/env node
'use strict';
/**
 * BRO-7167 test bench, step 2: grade the last N openings as they actually ran
 * (the old path), timed from the OBSERVED embargo where step 1 found one.
 *
 * Same grading as scripts/grade-openings.js (gradeOpening over review-texts git
 * history); the only difference is the embargo: a night whose nights.json row
 * has an observed cluster is graded from that time, and the row says so
 * (embargoCorrected, estimateAt, shiftMin). Nights with no exact publish times
 * keep the recorded or estimated embargo.
 *
 * Needs review-texts with full history (run-script.yml review_texts=true,
 * review_texts_depth=0). Prints the whole result as JSON on stdout (run-script
 * discards written files), and writes --out when given.
 *
 *   node scripts/test-bench-old-path-audit.js --nights=data/audit/test-bench/nights.json [--out=PATH] [--review-texts=DIR]
 * Exit 0 on success, 1 on unusable input.
 */
const fs = require('fs');
const path = require('path');
const og = require('./lib/opening-grade');
const { historyFrom, loadCommits, loadFiles } = require('./grade-openings');
const { citedUncollectedNow } = require('./lib/audit-show-review-gap');
const { loadBlocklist } = require('./lib/poller-blocklist');

const ROOT = path.join(__dirname, '..');
const arg = (k) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : null; };
const readJson = (p, fb) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fb; } };

/** The press-night record to grade with: the real one, with embargoAt moved to the observed time when there is one. Pure. */
function pressNightWithObserved(record, night) {
  const observedAt = night && night.observed && night.observed.source === 'observed-cluster' ? night.observed.at : null;
  if (!observedAt) return record || null;
  return { ...(record || {}), embargoAt: observedAt };
}

function main() {
  const nightsPath = path.resolve(ROOT, arg('nights') || 'data/audit/test-bench/nights.json');
  const nightsDoc = readJson(nightsPath, null);
  if (!nightsDoc || !nightsDoc.nights) { console.error(`no nights in ${nightsPath} (run test-bench-publish-times.js first)`); process.exit(1); }
  const rtDir = path.resolve(ROOT, arg('review-texts') || 'data/review-texts');
  const dataDir = path.resolve(ROOT, arg('data-dir') || 'data');
  const showsDoc = readJson(path.join(dataDir, 'shows.json'), null);
  const shows = Array.isArray(showsDoc) ? showsDoc : showsDoc && showsDoc.shows;
  if (!Array.isArray(shows)) { console.error('shows.json unreadable'); process.exit(1); }

  let hist;
  try { hist = historyFrom(rtDir); } catch (e) { console.error(`${rtDir} is not a git checkout (${e.message.split('\n')[0]})`); process.exit(1); }
  const pnDir = path.join(dataDir, 'audit', 'press-night');
  const records = (fs.existsSync(pnDir) ? fs.readdirSync(pnDir) : []).filter((n) => n.endsWith('.json')).map((n) => readJson(path.join(pnDir, n), null)).filter(Boolean);
  const gap = readJson(path.join(dataDir, 'audit', 'show-review-gap.json'), { results: [] });
  const gapById = new Map((gap.results || []).map((r) => [r.showId, r]));

  const ids = Object.keys(nightsDoc.nights);
  const targets = ids.map((id) => shows.find((s) => s.id === id)).filter(Boolean);
  const dates = targets.map((s) => Date.parse(`${s.openingDate}T00:00:00Z`)).filter(Number.isFinite);
  const nowMs = Date.now();
  const sinceMs = Math.min(...dates) - (og.BEFORE_H + 24) * 3600000;
  const untilMs = Math.min(nowMs, Math.max(...dates) + (og.AFTER_H + 48) * 3600000);
  const commits = targets.length ? loadCommits(rtDir, new Date(sinceMs).toISOString(), new Date(untilMs).toISOString()) : [];

  const grades = targets.map((show) => {
    const night = nightsDoc.nights[show.id];
    const record = og.pickPressNight(records, show);
    const files = loadFiles(rtDir, show.id);
    const base = {
      show, files, commits, historyFromMs: hist,
      gapResult: gapById.get(show.id) || null,
      missingCited: gapById.has(show.id) ? citedUncollectedNow(gapById.get(show.id), { heldFiles: files, blocklist: loadBlocklist(path.join(rtDir, show.id)), show }) : null,
      nowMs,
    };
    const g = og.gradeOpening({ ...base, pressNight: pressNightWithObserved(record, night) });
    // A spurious cluster must not silently change the grade: keep the grade on the recorded/estimated embargo beside it.
    const onRecord = night.embargoCorrected ? og.gradeOpening({ ...base, pressNight: record }) : null;
    return { ...g, embargoFrom: night.observed.source === 'observed-cluster' ? 'observed publish cluster' : g.embargoFrom,
      embargoCorrected: Boolean(night.embargoCorrected), estimateAt: night.estimate.at, shiftMin: night.observed.shiftMin,
      onRecordEmbargo: onRecord && { verdict: onRecord.verdict, line: og.gradeLine(onRecord) } };
  }).sort((a, b) => b.openingDate.localeCompare(a.openingDate) || a.showId.localeCompare(b.showId));

  const doc = {
    generatedAt: new Date(nowMs).toISOString(), generator: 'scripts/test-bench-old-path-audit.js (BRO-7167)',
    nights: nightsPath.startsWith(ROOT) ? path.relative(ROOT, nightsPath) : nightsPath,
    historyFrom: hist == null ? 'full' : new Date(hist).toISOString(), commitsScanned: commits.length,
    missingShows: ids.filter((id) => !shows.some((s) => s.id === id)),
    summary: og.summarize(grades), grades,
  };
  for (const g of grades) console.error(`${g.verdict.padEnd(13)} ${g.showId}${g.embargoCorrected ? ` (embargo ${g.shiftMin > 0 ? '+' : ''}${g.shiftMin}m)` : ''}  ${og.gradeLine(g)}`);
  console.log(JSON.stringify(doc));
  if (arg('out')) { const out = path.resolve(ROOT, arg('out')); fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, `${JSON.stringify(doc, null, 1)}\n`); }
}

if (require.main === module) main();
module.exports = { pressNightWithObserved };
