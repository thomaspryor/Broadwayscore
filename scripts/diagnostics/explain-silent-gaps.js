#!/usr/bin/env node
'use strict';
/**
 * explain-silent-gaps.js — say WHY each T1/T2 silent gap is unscored (BRO-5166).
 *
 * data/audit/t1-silent-gaps.json names each gap and a generic fix command, but
 * not the file state behind it (flags, skip reason, provenance). Cloud sessions
 * cannot read data/review-texts, so this prints that state as metadata only:
 * never fullText, excerpts or headlines. Run it where the texts are:
 *
 *   node scripts/cloud-run-script.js --review-texts scripts/diagnostics/explain-silent-gaps.js
 *   node scripts/diagnostics/explain-silent-gaps.js [--show=ID] [--file=NAME] [--report=PATH]
 *
 * Read-only. Exit 0 always (a diagnostic), 2 on a bad report path.
 */
const fs = require('fs');
const path = require('path');
const { unscoredSkipReason } = require('../lib/scoring-queue-counts');
const { classifyReviewUrl } = require('../lib/non-review-url-patterns');
const { isIncludableForRebuild, hasValidScore } = require('../lib/review-guards');
const { foldDiacritics } = require('../lib/title-match');

const ROOT = path.join(__dirname, '..', '..');
const arg = (name) => {
  const a = process.argv.slice(2).find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : null;
};

// Fields that can carry article prose; never printed, only their length.
const TEXT_FIELDS = new Set(['fullText', 'excerpt', 'dtliExcerpt', 'bwwExcerpt', 'showScoreExcerpt',
  'nycTheatreExcerpt', 'playbillExcerpt', 'pullQuote', 'headline', 'title', 'summary', 'llmScore',
  'ensembleData', 'rawHtml', 'description', 'snippet']);

function describe(fp, show) {
  const d = JSON.parse(fs.readFileSync(fp, 'utf8'));
  const flags = Object.keys(d).filter((k) => d[k] === true).sort();
  const lengths = {};
  for (const k of Object.keys(d)) {
    if (TEXT_FIELDS.has(k) && typeof d[k] === 'string') lengths[k] = d[k].length;
  }
  const scalars = {};
  for (const [k, v] of Object.entries(d)) {
    if (TEXT_FIELDS.has(k) || v === true || v == null) continue;
    if (typeof v === 'string' && v.length <= 200) scalars[k] = v;
    else if (typeof v === 'number' || v === false) scalars[k] = v;
  }
  let skip = null;
  try {
    skip = unscoredSkipReason(d, { show, showTitle: show && show.title, filePath: fp });
  } catch (e) { skip = `THREW: ${e.message}`; }
  const ft = typeof d.fullText === 'string' ? foldDiacritics(d.fullText.toLowerCase()) : '';
  const titleWord = show && show.title ? foldDiacritics(show.title.toLowerCase()).replace(/[^a-z0-9 ]/g, ' ').trim() : '';
  return {
    flags,
    textLengths: lengths,
    showTitleInText: titleWord ? ft.includes(titleWord) : null,
    includable: isIncludableForRebuild(d, show, fp),
    hasValidScore: hasValidScore(d),
    hasLlmScore: !!d.llmScore,
    unscoredSkipReason: skip,
    urlClass: typeof d.url === 'string' ? classifyReviewUrl(d.url) : null,
    objectKeys: Object.keys(d).filter((k) => d[k] && typeof d[k] === 'object' && !TEXT_FIELDS.has(k)),
    scalars,
  };
}

function main() {
  const reportPath = arg('report') || path.join(ROOT, 'data', 'audit', 't1-silent-gaps.json');
  let targets;
  if (arg('show') && arg('file')) {
    targets = [{ showId: arg('show'), file: arg('file') }];
  } else {
    if (!fs.existsSync(reportPath)) { console.error(`no report at ${reportPath}`); process.exit(2); }
    targets = JSON.parse(fs.readFileSync(reportPath, 'utf8')).gaps || [];
    if (arg('show')) targets = targets.filter((g) => g.showId === arg('show'));
  }
  const showsRaw = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'shows.json'), 'utf8'));
  const shows = new Map((Array.isArray(showsRaw) ? showsRaw : showsRaw.shows).map((s) => [s.id, s]));
  for (const g of targets) {
    const fp = path.join(ROOT, 'data', 'review-texts', g.showId, g.file);
    console.log(`\n### ${g.showId} / ${g.file}  (${g.type || '?'}, tier ${g.tier || '?'})`);
    if (!fs.existsSync(fp)) { console.log('  FILE MISSING (already recovered, moved or deleted)'); continue; }
    try {
      console.log(JSON.stringify(describe(fp, shows.get(g.showId)), null, 1));
    } catch (e) {
      console.log(`  ERROR: ${e.message}`);
    }
    const siblings = fs.readdirSync(path.dirname(fp)).filter((f) => f.startsWith(g.file.split('--')[0] + '--'));
    console.log(`  same-outlet files: ${siblings.join(', ')}`);
  }
}

if (require.main === module) main();
module.exports = { describe };
