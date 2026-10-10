#!/usr/bin/env node
'use strict';

/**
 * backfill-contamination-allow-signals.js — one-time backfill for reviews the
 * tour/film contamination adjudicator (adjudicate-review-queue.js) already
 * judged legit (tourCheckVerified: 'false-positive') but which stayed excluded
 * as tourContaminationInText / filmTvContaminationInText, because the guards
 * only read allowTourSignal / allowFilmSignal. The adjudicator now sets those
 * itself (scripts/lib/contamination-allow-signal.js); this fixes the files it
 * wrote before that.
 *
 * Which flag: the queue reason is no longer on the file, so the same detectors
 * the guards run (isTourReviewExcerpt / isFilmTvReview on fullText[0..600])
 * are re-run. Exactly one may fire; when both do, nothing is granted and the
 * file is listed for a person (the adjudicator only judged one signal).
 *
 * Usage:
 *   node scripts/backfill-contamination-allow-signals.js             # dry run
 *   node scripts/backfill-contamination-allow-signals.js --apply
 *   node scripts/backfill-contamination-allow-signals.js --dir=PATH  # or REVIEW_TEXTS_DIR
 */

const fs = require('fs');
const path = require('path');
const { listShowDirs } = require('./lib/list-show-dirs');
const { hasHelpFlag } = require('./lib/cli-help.js');
const { explainExclusion } = require('./lib/review-guards');
const { applyContaminationAllow, pickContaminationAllowKind } = require('./lib/contamination-allow-signal');

const ROOT = path.join(__dirname, '..');
const CONTAMINATION_EXCLUSIONS = new Set(['tourContaminationInText', 'filmTvContaminationInText']);

const USAGE = `backfill-contamination-allow-signals.js — set allowTourSignal/allowFilmSignal on adjudicated-legit (tourCheckVerified=false-positive) reviews still excluded by the fullText contamination guard.

Usage:
  node scripts/backfill-contamination-allow-signals.js [--apply] [--dir=PATH]
`;

function main() {
  const argv = process.argv.slice(2);
  if (hasHelpFlag(argv)) { console.log(USAGE); return; }
  const apply = argv.includes('--apply');
  const dirArg = argv.find((a) => a.startsWith('--dir='));
  const dir = dirArg ? dirArg.slice(6) : (process.env.REVIEW_TEXTS_DIR || path.join(ROOT, 'data', 'review-texts'));
  if (!fs.existsSync(dir)) { console.error(`review-texts dir missing: ${dir}`); process.exit(2); }

  const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'shows.json'), 'utf8'));
  const shows = new Map((raw.shows || raw).filter((s) => s && s.id).map((s) => [s.id, s]));
  const { safeWriteReview } = apply ? require('./lib/review-write-guard') : {};
  const today = new Date().toISOString().slice(0, 10);

  const rows = [];
  for (const showDir of listShowDirs(dir)) {
    const showPath = path.join(dir, showDir);
    let files;
    try { files = fs.readdirSync(showPath); } catch { continue; }
    const show = shows.get(showDir);
    for (const file of files) {
      if (!file.endsWith('.json') || file === 'failed-fetches.json') continue;
      const fp = path.join(showPath, file);
      let d;
      try { d = JSON.parse(fs.readFileSync(fp, 'utf8')); } catch { continue; }
      if (d.tourCheckVerified !== 'false-positive') continue;
      const before = explainExclusion(d, show, fp);
      if (!CONTAMINATION_EXCLUSIONS.has(before)) continue;
      const { kind, ambiguous } = pickContaminationAllowKind(d, show);
      const reason = `backfill ${today}: adjudicated tourCheckVerified=false-positive — ${String(d.tourCheckNote || '').slice(0, 300)}`;
      if (kind) applyContaminationAllow(d, kind, reason);
      const after = explainExclusion(d, show, fp);
      rows.push({ rel: `${showDir}/${file}`, kind, ambiguous, before, after });
      if (apply && kind) safeWriteReview(fp, d, { force: true });
    }
  }

  const fixed = rows.filter((r) => r.after === null).length;
  const review = rows.filter((r) => r.ambiguous);
  console.log(`[contamination-allow-backfill] ${rows.length} adjudicated-legit file(s) still excluded by the contamination guard; ${fixed} includable after the flag; ${review.length} need a person (both tour AND film detectors fire)${apply ? ' (written)' : ' (dry run)'}`);
  for (const r of rows) console.log(`    - ${r.rel}  ${r.kind ? `+${r.kind}` : r.ambiguous ? 'NEEDS REVIEW (tour+film)' : 'none'}  ${r.before} -> ${r.after ?? 'included'}`);
}

if (require.main === module) main();
