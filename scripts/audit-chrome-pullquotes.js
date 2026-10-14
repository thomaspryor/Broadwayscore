#!/usr/bin/env node
/**
 * audit-chrome-pullquotes.js
 *
 * CI guard for Session C / Lost Boys Issue #9 (Gap 5). Defense-in-depth check
 * that runs AFTER rebuild-all-reviews.js and counts pullQuote values that
 * still match the chrome-prefix regex. Even with stripLeadingChrome wired
 * into the fallback path, this catches:
 *   - new chrome patterns the heuristic doesn't yet recognize
 *   - upstream sources (llmPullQuote, aggregator excerpts) that were never
 *     run through the chrome strip
 *   - cases where the heuristic bailed (>70% skip) and the raw slice got used
 *
 * Behavior:
 *   - Reads data/reviews.json
 *   - Counts pullQuote entries matching /^(Review|By [A-Z]|Photo|Credit)/i
 *   - If any are found, writes data/audit/chrome-fallback-${date}.json with
 *     the offending shows + outlets so an operator can spot-check
 *   - Always exits 0 (warning, not failure) — operator visibility is the goal,
 *     not a hard CI fail. Pass --fail-on-hit to invert this behavior.
 *
 * Run:
 *   node scripts/audit-chrome-pullquotes.js
 *   node scripts/audit-chrome-pullquotes.js --fail-on-hit  # exit 1 if any
 */

'use strict';

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const REVIEWS_FILE = process.env.REVIEWS_FILE || path.join(DATA_DIR, 'reviews.json');
const AUDIT_DIR = process.env.AUDIT_DIR || path.join(DATA_DIR, 'audit');

// Chrome-prefix patterns. Spec from Session C task §2 was
// /^(Review|By [A-Z]|Photo|Credit)/i — but /i made [A-Z] match lowercase
// too, flagging legitimate narrative openers ("By the time...", "By
// stripping...").
//
// Aligned with scripts/lib/pull-quote-guards.js CHROME_LINE_PATTERNS so
// the audit catches the SAME chrome the heuristic claims to skip
// (Codex review, Session C). Coverage gap noted: heuristic recognized
// venue/Production/numeric-date/just-name lines but audit only flagged
// 4 prefixes — a chrome leak in any of those categories would slip past
// the audit. Now mirrored (modulo bound: the audit is anchored to
// pullQuote start, the heuristic operates on multi-line raw text).
const CHROME_PREFIX_PATTERNS = [
  /^Review[:\s]/i,                                 // "Review:" or "Review "
  /^By [A-Z][A-Za-z]+ [A-Z][A-Za-z]+/,             // "By Firstname Lastname" (also catches ALL-CAPS like "By JESSE GREEN")
  /^Photo:/i,                                      // colon-only — "Photo by John" can be narrative-ish
  /^Credit:/i,                                     // colon-only — "Credit belongs to..." is narrative
  /^Venue:/i,                                      // venue label
  /^Production:/i,                                 // production label
  /^\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4}\b/,            // bare date prefix (MM/DD/YYYY etc.)
  // Venue-prefix chrome — venue name followed by address-pattern, separator,
  // or chrome marker. Tighter than the heuristic's standalone-line check
  // because the audit operates on a pullQuote string (which may legitimately
  // start with "Manhattan Theatre Club", "Roundabout Theatre Company's...",
  // etc — those are narrative about production organizations, not chrome).
  // Requires: venue word + (street address | numeric date | ⋄ separator |
  // pipe). Catches "Gerald Schoenfeld Theatre, 236 W..." style leaks while
  // letting "Roundabout Theatre Company's Broadway revival..." through.
  /^(?:(?:[A-Z][\w'.-]*|St\.?|The)\s+){1,3}(?:Theatre|Theater|Hall|Auditorium|Playhouse)\b[,.\s]*(?:\d{2,4}\s+(?:W|E|N|S|West|East|North|South)\b|\d{1,2}[\/-]\d{1,2}|⋄|\|)/,
];

function isChromePrefix(s) {
  return CHROME_PREFIX_PATTERNS.some(re => re.test(s));
}

function main() {
  const failOnHit = process.argv.includes('--fail-on-hit');

  if (!fs.existsSync(REVIEWS_FILE)) {
    console.error(`✗ ${REVIEWS_FILE} not found — run rebuild first`);
    process.exit(1);
  }

  const blob = JSON.parse(fs.readFileSync(REVIEWS_FILE, 'utf8'));
  const reviews = Array.isArray(blob.reviews) ? blob.reviews : [];
  if (!reviews.length) {
    console.error('✗ reviews.json has no reviews');
    process.exit(1);
  }

  const hits = [];
  for (const r of reviews) {
    const pq = r.pullQuote;
    if (typeof pq !== 'string') continue;
    if (!isChromePrefix(pq)) continue;
    hits.push({
      showId: r.showId,
      outlet: r.outlet || r.outletId,
      criticName: r.criticName,
      url: r.url,
      pullQuoteHead: pq.slice(0, 120),
    });
  }

  console.log(`audit-chrome-pullquotes: scanned ${reviews.length} reviews, ${hits.length} chrome-prefixed pullQuote(s)`);

  if (hits.length === 0) {
    console.log('✓ no chrome-prefixed pullquotes — guard clean');
    return 0;
  }

  // Group by show for operator readability.
  const byShow = {};
  for (const h of hits) {
    (byShow[h.showId] = byShow[h.showId] || []).push(h);
  }

  // Write audit file. Date stamp YYYY-MM-DD so reruns same-day overwrite,
  // mirroring the convention in data/audit/.
  if (!fs.existsSync(AUDIT_DIR)) fs.mkdirSync(AUDIT_DIR, { recursive: true });
  const today = new Date().toISOString().slice(0, 10);
  const outFile = path.join(AUDIT_DIR, `chrome-fallback-${today}.json`);
  const payload = {
    generatedAt: new Date().toISOString(),
    totalReviews: reviews.length,
    chromeHits: hits.length,
    affectedShows: Object.keys(byShow).length,
    patterns: CHROME_PREFIX_PATTERNS.map(re => re.toString()),
    byShow,
  };
  fs.writeFileSync(outFile, JSON.stringify(payload, null, 2));

  console.warn(`⚠ ${hits.length} chrome-prefixed pullquote(s) across ${Object.keys(byShow).length} show(s)`);
  console.warn(`   → ${outFile}`);
  for (const showId of Object.keys(byShow).slice(0, 5)) {
    const sample = byShow[showId][0];
    console.warn(`   - ${showId} / ${sample.outlet}: "${sample.pullQuoteHead}"`);
  }
  if (Object.keys(byShow).length > 5) {
    console.warn(`   ... and ${Object.keys(byShow).length - 5} more`);
  }

  return failOnHit ? 1 : 0;
}

if (require.main === module) {
  process.exit(main());
}

module.exports = { CHROME_PREFIX_PATTERNS, isChromePrefix };
