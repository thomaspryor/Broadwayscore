#!/usr/bin/env node
/**
 * Audit Script: shows.json director field vs critic-mention consensus.
 *
 * Origin: 2026-05-08 session ad-hoc audit found 15 director misattributions in
 * shows.json (e.g. hamlet-off-broadway-2026 said Michael Grandage but actual
 * production is Robert Hastie — caught by 0 of 30+ reviews mentioning Grandage,
 * 30+ mentioning Hastie). The named-entity bypass (commit 14c58bfdbb) hard-
 * depends on shows.json director accuracy. This script generalizes the audit
 * for periodic CI use.
 *
 * Methodology: for each show with ≥MIN_REVIEWS reviews and a single recorded
 * stage director, count last-name mentions of recorded director across all
 * unflagged review fullText. Flag where:
 *   STRICT  — recorded mentioned in 0/N reviews AND alternative ≥3 mentions
 *   SOFT    — recorded mentioned in ≤2/N (≤20%) AND alternative ≥5 mentions
 *
 * Output: JSON to stdout, exit 0 if no findings, 1 if any STRICT findings.
 *
 * Usage:
 *   node scripts/audit-show-director-consensus.js [--soft] [--limit=N] [--min-reviews=N]
 *
 * --soft         include SOFT findings (default: STRICT only — high precision)
 * --limit=N      cap output to top N findings by suspiciousness (default: no cap)
 * --min-reviews=N  only audit shows with at least N reviews (default: 5)
 */

const fs = require('fs');
const path = require('path');

const argv = process.argv.slice(2);
const SOFT = argv.includes('--soft') || argv.includes('--review-mode');
const REVIEW_MODE = argv.includes('--review-mode'); // even-more-relaxed thresholds for periodic manual review
const LIMIT = (() => {
  const a = argv.find(x => x.startsWith('--limit='));
  return a ? parseInt(a.split('=')[1], 10) : Infinity;
})();
const MIN_REVIEWS = (() => {
  const a = argv.find(x => x.startsWith('--min-reviews='));
  return a ? parseInt(a.split('=')[1], 10) : 8;
})();

// Mirror review-guards.js STAGE_DIRECTOR_ROLE_RE
const STAGE_DIRECTOR_ROLE_RE = /^(?:director(?:\s*&\s*choreographer)?|co-director|book,\s*director)$/i;

function normLastName(s) {
  const cleaned = String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
  if (!cleaned) return '';
  return cleaned.split(/\s+/).pop();
}

function isStageDirectorRole(role) {
  return STAGE_DIRECTOR_ROLE_RE.test(String(role || '').trim());
}

const SHOWS = require('../data/shows.json');
const showsArr = SHOWS.shows || SHOWS;
const ROOT = 'data/review-texts';

const findings = [];
let scannedShows = 0;

for (const show of showsArr) {
  const dir = path.join(ROOT, show.id);
  if (!fs.existsSync(dir)) continue;
  const directors = (show.creativeTeam || []).filter(c => isStageDirectorRole(c.role));
  if (directors.length !== 1) continue; // multi-director shows are ambiguous; skip
  const expected = directors[0].name;
  if (!expected) continue;
  const expectedLast = normLastName(expected);
  if (expectedLast.length < 4) continue; // 3-letter names too noisy

  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
  if (files.length < MIN_REVIEWS) continue;
  scannedShows++;

  let reviewsMentioningExpected = 0;
  let totalReviews = 0;
  const otherDirectorCounts = {};
  const otherDirectorFullNames = {};

  // Normalize text + name identically: lowercase + strip apostrophes/hyphens.
  // Without this, expected last name "obrien" (from "Jack O'Brien") won't match
  // "O'Brien" in fullText because the apostrophe creates word-boundary issues.
  const expectedRe = new RegExp(
    '\\b' + expectedLast.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b',
    'gi'
  );
  const normalizeForMatch = (s) => s.toLowerCase().replace(/['’\-]/g, '');

  for (const f of files) {
    let d;
    try { d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch (e) { continue; }
    if (d.wrongProduction || d.wrongShow) continue;
    const text = d.fullText || '';
    if (!text || text.length < 200) continue;
    totalReviews++;

    const normalizedText = normalizeForMatch(text);
    if (expectedRe.test(normalizedText)) reviewsMentioningExpected++;
    expectedRe.lastIndex = 0; // reset stateful regex

    // Extract "directed by [Name]" mentions. Pattern allows lowercase particles
    // (van, de, los, von, etc.) between capitalized name parts so directors like
    // "Ivo van Hove", "Robert van den Bos", "María de los Reyes" are captured —
    // not just "Ivo" alone (which would fail the >=2-word requirement).
    const seen = new Set();
    for (const m of text.matchAll(/\bdirected by ([A-Z][a-zA-ZÀ-ÿ'-]+(?:\s+(?:[A-Z][a-zA-ZÀ-ÿ'-]+|van|de|del|della|di|du|le|la|los|las|von|der|den|al|el|bin|ibn|ter)){1,4})/g)) {
      const fullName = m[1];
      const ln = normLastName(fullName);
      if (!ln || ln === expectedLast) continue;
      if (seen.has(ln)) continue;
      seen.add(ln);
      otherDirectorCounts[ln] = (otherDirectorCounts[ln] || 0) + 1;
      // Track first-seen full name for human-readable output
      if (!otherDirectorFullNames[ln]) otherDirectorFullNames[ln] = fullName;
    }
  }

  if (totalReviews < MIN_REVIEWS) continue;

  const otherEntries = Object.entries(otherDirectorCounts).sort((a, b) => b[1] - a[1]);
  const topOther = otherEntries[0];
  if (!topOther) continue;
  const ratio = reviewsMentioningExpected / totalReviews;

  // Second-pass: for the top "directed by"-named candidate, also count bare last-name
  // mentions across all reviews. Critics often mention the actual director via possessive
  // ("Fein's production") or surname ("Fein uses sparse staging") far more than via the
  // explicit "directed by" phrasing. A high bare-name count is much stronger evidence.
  let topOtherBareMentions = 0;
  if (topOther) {
    const topLast = topOther[0]; // already normalized lowercase last name
    const bareRe = new RegExp(
      '\\b' + topLast.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b',
      'gi'
    );
    for (const f of files) {
      let d;
      try { d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch (e) { continue; }
      if (d.wrongProduction || d.wrongShow) continue;
      const text = d.fullText || '';
      if (text.length < 200) continue;
      if (bareRe.test(normalizeForMatch(text))) topOtherBareMentions++;
      bareRe.lastIndex = 0;
    }
  }
  const topOtherBareRatio = topOtherBareMentions / totalReviews;

  // STRICT (highest precision, uses bare-last-name signal):
  //   - 0 mentions of expected director's last name in any review fullText AND
  //   - top other-named director's last name appears in ≥30% of reviews (bare match)
  //   This catches the 6 cases found in 2026-05-09 audit (Jordan Fein 18/21,
  //   Patrick Marber 12/17, Monique Touko 9/10, etc.) where critics use surname
  //   often via possessives but use explicit "directed by [Name]" only once.
  //
  // STRICT_DIRECTED_BY (legacy precision, weaker signal):
  //   - 0 mentions of expected AND ≥3 reviews use "directed by [SameName]"
  //   Original heuristic — kept as fallback for shows where critics don't use
  //   surnames a lot but do use "directed by" phrasing.
  //
  // ZERO (review-needed signal, lower precision):
  //   - 0 mentions of expected AND ≥10 reviews exist
  //   Surfaces shows where the recorded director simply isn't named anywhere.
  //   Often a misattribution but sometimes legit (devised theatre, ensemble work).
  //
  // SOFT (--soft): ≤20% mentions + alternative ≥5 + beats expected by 2x
  // REVIEW (--review-mode): ≤50% mentions + alternative ≥3 + beats expected
  const isStrict =
    reviewsMentioningExpected === 0 &&
    (topOtherBareRatio >= 0.3 || topOther[1] >= 3);
  const isZero =
    !isStrict &&
    reviewsMentioningExpected === 0 &&
    totalReviews >= 10;
  const isSoft =
    !isStrict && !isZero && SOFT &&
    ratio <= 0.2 && topOther[1] >= 5 && topOther[1] >= reviewsMentioningExpected * 2;
  const isReview =
    !isStrict && !isZero && !isSoft && REVIEW_MODE &&
    ratio < 0.5 && topOther[1] >= 3 && topOther[1] > reviewsMentioningExpected;

  if (!isStrict && !isZero && !isSoft && !isReview) continue;

  findings.push({
    showId: show.id,
    title: show.title,
    status: show.status,
    openingDate: show.openingDate,
    severity: isStrict ? 'STRICT' : (isZero ? 'ZERO' : (isSoft ? 'SOFT' : 'REVIEW')),
    recorded: expected,
    recordedMentions: reviewsMentioningExpected,
    totalReviews,
    proposedDirector: otherDirectorFullNames[topOther[0]],
    proposedDirectorMentions: topOther[1],
    proposedDirectorBareMentions: topOtherBareMentions,
    otherCandidates: otherEntries.slice(1, 4).map(([ln, n]) => ({
      name: otherDirectorFullNames[ln],
      mentions: n,
    })),
  });
}

const SEVERITY_ORDER = { STRICT: 0, ZERO: 1, SOFT: 2, REVIEW: 3 };
findings.sort((a, b) => {
  if (a.severity !== b.severity) return SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
  return (b.proposedDirectorMentions - b.recordedMentions) - (a.proposedDirectorMentions - a.recordedMentions);
});

const limited = findings.slice(0, LIMIT);
const strictCount = findings.filter(f => f.severity === 'STRICT').length;
const zeroCount = findings.filter(f => f.severity === 'ZERO').length;
const softCount = findings.filter(f => f.severity === 'SOFT').length;
const reviewCount = findings.filter(f => f.severity === 'REVIEW').length;

const out = {
  scannedShows,
  findingsCount: findings.length,
  strictCount,
  zeroCount,
  softCount,
  reviewCount,
  findings: limited,
};

console.log(JSON.stringify(out, null, 2));
// Exit non-zero on STRICT findings (high-confidence misattributions). ZERO findings
// are surfaced for review but not blocking — large sample with 0 mentions is
// suggestive but not always conclusive (e.g. devised theatre with no named director).
process.exit(strictCount > 0 ? 1 : 0);
