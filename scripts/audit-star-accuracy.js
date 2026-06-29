#!/usr/bin/env node
'use strict';

/**
 * audit-star-accuracy.js — verify captured star ratings are correct and their
 * conversion to assignedScore is right. Catches the recurring bug class where:
 *   (a) a star-GOVERNED review's assignedScore disagrees with its own captured
 *       star (a conversion bug), and
 *   (b) the captured star itself is wrong — wildly diverging from the LLM/text
 *       score (e.g. Daily Mail "5/5" captured when the review verdict is 3/5).
 *
 * Reads the review-text source files (the captured stars live there:
 * originalScore / originalRating / aggregatorStars / originalScoreNormalized)
 * and cross-checks assignedScore from reviews.json. Pure conversion via
 * scripts/lib/star-parse.js so audit + scorer agree.
 *
 * Usage:
 *   node scripts/audit-star-accuracy.js [--show=ID] [--market=west-end]
 *        [--since=YYYY-MM-DD] [--json=PATH] [--gate]
 *   --gate   exit 1 if any HARD conversion error is found (for CI)
 *
 * Severity:
 *   HARD   star-governed scoreSource (originalScore-priority0 / human-review /
 *          *anchored* with a star) but assignedScore != the star conversion
 *          (>HARD_TOL pts). This is a definite bug.
 *   SUSPECT captured star diverges from assignedScore by >SUSPECT_TOL pts on an
 *          LLM-scored review — the star may be miscaptured (or a genuine
 *          star/text mismatch). Needs eyeball before trusting the displayed star.
 */
const fs = require('fs');
const path = require('path');
const { parseStar } = require('./lib/star-parse');
const { isLondonMarket } = require('./lib/venue-classification');

const ROOT = path.join(__dirname, '..');
const REVIEW_TEXTS = path.join(ROOT, 'data', 'review-texts');

const HARD_TOL = 6;      // star-governed: must match within rounding
const SUSPECT_TOL = 22;  // LLM-scored: flag a wide star↔score gap

const args = process.argv.slice(2);
const getArg = (n) => { const a = args.find((x) => x.startsWith(`--${n}=`)); return a ? a.split('=').slice(1).join('=') : null; };
const GATE = args.includes('--gate');
const showArg = getArg('show');
const marketArg = getArg('market');
const since = getArg('since');
const jsonOut = getArg('json');

function loadCoreJSON(name) {
  // data/ is symlinked to private repos; resolve through it.
  const p = path.join(ROOT, 'data', name);
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

// "star-governed" = the published star DIRECTLY set the score (must match within
// rounding). NOTE: 'anchored-v6' is NOT star-governed — it anchors to the star
// but the LLM adjusts WITHIN that star's band by sentiment (a 4/5 lands ~80-90),
// so it is checked separately by a band-crossing rule, not must-match.
//
// 'human-review' is NOT star-governed either (fixed 2026-06-29): humanReviewScore
// is an AUTHORITATIVE operator override — it deliberately deviates from the
// captured star when the star/grade is wrong or the review is nuanced (e.g.
// the-wiz EW carried an "A" grade but the operator scored 78 after the LLM read
// the text as Mixed; titanique NYSR operator scores diverged from mis-extracted
// unicode stars). Treating it as must-match-star reported 10 human judgments as
// "definite conversion bugs". A human override that diverges from the star is a
// SUSPECT at most (eyeball the captured star), never HARD.
function isStarGoverned(scoreSource) {
  if (!scoreSource) return false;
  if (/anchored/i.test(scoreSource)) return false;
  if (/human-review/i.test(scoreSource)) return false;
  return /originalScore|word-stars|manual-stars|aggregatorStars|json-ld/i.test(scoreSource);
}

// The [min,max] band a captured star legitimately permits. Star base ±~12 so an
// anchored score can sit anywhere within its own star and the adjacent gap, but
// NOT cross into a different star's territory (that = miscaptured star or a
// mis-anchor — the real bug, e.g. 5/5 scored 69).
function starBand(starScore) {
  return [Math.max(1, starScore - 12), Math.min(100, starScore + 12)];
}

// Pull the captured star string from a review-text record (first that parses).
function capturedStar(j) {
  for (const k of ['originalScore', 'originalRating', 'aggregatorStars']) {
    if (j[k]) { const p = parseStar(j[k]); if (p) return { raw: j[k], ...p, field: k }; }
  }
  // originalScoreNormalized is already 0-100 (no raw star string).
  if (Number.isFinite(j.originalScoreNormalized)) {
    return { raw: `${j.originalScoreNormalized}/100`, score: j.originalScoreNormalized, stars: null, outOf: null, field: 'originalScoreNormalized' };
  }
  return null;
}

function main() {
  const showsData = loadCoreJSON('shows.json');
  const shows = showsData.shows || showsData;
  const reviewsData = loadCoreJSON('reviews.json');
  const reviews = (Array.isArray(reviewsData) ? reviewsData : reviewsData.reviews);

  // assignedScore lookup by showId+outletId+criticName.
  const scoreByKey = new Map();
  for (const r of reviews) {
    if (r.assignedScore == null) continue;
    scoreByKey.set(`${r.showId}|${r.outletId}|${(r.criticName || '').toLowerCase()}`, r);
  }

  let targetShows = shows.filter((s) => s.id);
  if (showArg) targetShows = targetShows.filter((s) => s.id === showArg || s.slug === showArg);
  else {
    if (marketArg === 'west-end') targetShows = targetShows.filter((s) => isLondonMarket(s.category));
    if (since) targetShows = targetShows.filter((s) => (s.openingDate || '') >= since);
  }

  const hard = []; const suspect = [];
  for (const show of targetShows) {
    const dir = path.join(REVIEW_TEXTS, show.id);
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      let j; try { j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
      if (j.wrongProduction || j.wrongShow || j.duplicateOf) continue; // excluded — not displayed
      const star = capturedStar(j);
      if (!star) continue;
      const rec = scoreByKey.get(`${show.id}|${j.outletId}|${(j.criticName || '').toLowerCase()}`);
      if (!rec) continue; // not in reviews.json (unscored / excluded) — completeness audit's job, not this one
      const assigned = rec.assignedScore;
      const delta = Math.abs(assigned - star.score);
      const row = { show: show.id, outlet: j.outlet || j.outletId, critic: j.criticName, file: f, capturedStar: star.raw, starScore: star.score, assignedScore: assigned, scoreSource: rec.scoreSource, delta };
      if (isStarGoverned(rec.scoreSource)) {
        // The star directly set the score — must match within rounding.
        if (delta > HARD_TOL) hard.push(row);
      } else {
        // LLM/anchored: bug only if the score crosses OUT of the star's band
        // (miscaptured star or mis-anchor). In-band sentiment adjustment is fine.
        const [lo, hi] = starBand(star.score);
        if (assigned < lo || assigned > hi) suspect.push(row);
      }
    }
  }

  hard.sort((a, b) => b.delta - a.delta);
  suspect.sort((a, b) => b.delta - a.delta);

  console.log(`\n=== Star-Accuracy Audit ===`);
  console.log(`Shows scanned: ${targetShows.length} | HARD conversion bugs: ${hard.length} | SUSPECT captures: ${suspect.length}\n`);
  if (hard.length) {
    console.log(`🔴 HARD (star-governed score != its star, >${HARD_TOL}pts) — definite bugs:`);
    for (const r of hard) console.log(`  ${r.show.slice(0, 34).padEnd(36)} ${(r.outlet || '').padEnd(20)} star=${r.capturedStar} (→${r.starScore}) assigned=${r.assignedScore} src=${r.scoreSource}  [${r.file}]`);
    console.log('');
  }
  if (suspect.length) {
    console.log(`🟡 SUSPECT (captured star diverges from LLM score by >${SUSPECT_TOL}pts) — verify the captured star:`);
    for (const r of suspect) console.log(`  ${r.show.slice(0, 34).padEnd(36)} ${(r.outlet || '').padEnd(20)} star=${r.capturedStar} (→${r.starScore}) assigned=${r.assignedScore} src=${r.scoreSource}  [${r.file}]`);
    console.log('');
  }
  if (!hard.length && !suspect.length) console.log('✓ No star-accuracy issues found.');

  if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify({ hard, suspect }, null, 2) + '\n');

  process.exit(GATE && hard.length ? 1 : 0);
}

main();
