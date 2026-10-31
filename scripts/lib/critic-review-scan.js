/**
 * Read-only scan of data/review-texts into per-critic outlet/row tallies.
 * Shared by audit-critic-outlets.js (which writes the registry) and
 * audit-critic-tenure.js (read-only tenure-flag count, BRO-5222).
 */
'use strict';

const { isReviewTextFile } = require('./review-text-sidecars');
const fs = require('fs');
const path = require('path');
const { normalizeOutlet } = require('./review-normalization');
const { listShowDirs } = require('./list-show-dirs');
const { isVerifiedRow, reviewYear, bylineContradicted } = require('./critic-tenure');
const { foldDiacritics } = require('./title-match');

const DEFAULT_REVIEW_TEXTS_DIR = path.join(__dirname, '..', '..', 'data', 'review-texts');

function slugifyCritic(name) {
  // Fold first so an accented name keeps its letters ("Hélène" -> "helene").
  return foldDiacritics(name)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function scanReviewTexts(REVIEW_TEXTS_DIR = DEFAULT_REVIEW_TEXTS_DIR) {
  const critics = {};
  let totalFiles = 0;
  let skippedFiles = 0;

  if (!fs.existsSync(REVIEW_TEXTS_DIR)) {
    console.error('No review-texts directory found');
    process.exit(1);
  }

  // listShowDirs (not raw readdirSync+statSync) — a dangling symlink in the
  // review-texts checkout throws ENOENT on statSync and would otherwise crash
  // the whole gate instead of skipping that one entry (task #1668 ship-check,
  // same hardening audit-outlet-registry.js already has).
  const showDirs = listShowDirs(REVIEW_TEXTS_DIR);

  for (const showId of showDirs) {
    const showDir = path.join(REVIEW_TEXTS_DIR, showId);
    const files = fs.readdirSync(showDir).filter(f =>
      isReviewTextFile(f)
    );

    for (const file of files) {
      totalFiles++;
      try {
        const data = JSON.parse(fs.readFileSync(path.join(showDir, file), 'utf8'));

        // Skip flagged reviews. duplicateOf is included alongside the
        // content-wrongness flags (task #1776): a file that points at
        // another file as its canonical copy (e.g. a never-scraped stub
        // superseded by a full-text twin under a different outletId) is not
        // independent attribution evidence — counting it inflates a critic's
        // outlet spread with noise from the SAME underlying review, the same
        // reasoning review-normalization.js already applies when picking
        // merge targets.
        //
        // fabricatedEntry joins them for the same reason (BRO-3092), though by a
        // narrower argument than the flags above. Of the 205 fabricatedEntry
        // files, exactly ONE is a misattribution outright — marie-and-rosetta-
        // west-end-2026/thestage--london-theatre-direct-limited.json, stamped
        // `fabricatedReason: 'Collection script misidentified london-theatre-
        // direct as the-stage'`, i.e. wrongAttribution by another name, with
        // url:null and a criticName of "London Theatre Direct Limited". The
        // other 204 name a plausible, usually CORRECT affiliation (178 "URL
        // returns 404, no fullText, generic fallback", 24 web-search-era
        // fabrications, 2 user-verified non-existent reviews) — Hilton Als
        // really did write for the New Yorker.
        //
        // They are skipped anyway because the record never ESTABLISHED that
        // affiliation: its URL 404s or was invented, so it is not independent
        // evidence of where a critic publishes, only a restatement of what the
        // fabricating step already assumed. Counting it lets a manufactured row
        // vouch for itself.
        //
        // Measured delta of this skip against the live corpus (bare write mode,
        // HEAD vs this change): 632 -> 629 critics, 4 flags removed, 2 critics
        // lose a knownOutlet, 0 primaryOutlet changes, 0 isFreelancer flips.
        // The 3 departures (miriam-gillinson, jonas-schwartz, paul-raven) each
        // fall to 2 real reviews, under MIN_REVIEWS_FOR_REGISTRY — Guard G in
        // review-file-writer.js gates on `entry &&`, so it fails OPEN for them
        // rather than flagging. jesse-green loses `newyorker` but is
        // isFreelancer, which Guard G skips anyway; london-theatre-direct-
        // limited loses `thestage`, which is the guard tightening correctly.
        if (data.wrongAttribution || data.wrongProduction || data.wrongShow
          || data.duplicateOf || data.fabricatedEntry === true) {
          skippedFiles++;
          continue;
        }

        const outletId = data.outletId || data.outlet || 'unknown';
        const criticName = data.criticName || 'unknown';

        if (outletId === 'unknown' || criticName === 'unknown') {
          continue;
        }

        const criticSlug = slugifyCritic(criticName);
        if (!criticSlug) continue;

        if (!critics[criticSlug]) {
          critics[criticSlug] = {
            displayName: criticName,
            outletCounts: {},
            totalReviews: 0,
            reviews: [], // For audit report
          };
        }

        // Keep the most "proper" display name (longest, most capitalized)
        if (criticName.length > critics[criticSlug].displayName.length) {
          critics[criticSlug].displayName = criticName;
        }

        const normalizedOutlet = normalizeOutlet(outletId);
        critics[criticSlug].outletCounts[normalizedOutlet] = (critics[criticSlug].outletCounts[normalizedOutlet] || 0) + 1;
        critics[criticSlug].totalReviews++;
        critics[criticSlug].reviews.push({
          showId,
          outlet: normalizedOutlet,
          file,
          year: reviewYear(showId, data),
          verified: isVerifiedRow(data),
          // Dropped after the scan: only for the byline cross-check below.
          _text: isVerifiedRow(data) ? data.fullText : null,
          _critic: criticName,
          // Kept in the registry counts (a news story still shows where a
          // critic writes), but the tenure check neither flags nor trusts it.
          nonReview: data.isNonReview === true,
        });
      } catch (e) {
        // Skip unparseable files
      }
    }
  }

  // A verified row whose stored page credits another of the outlet's critics,
  // and never names its own, is not tenure evidence (BRO-5232).
  const outletCritics = {};
  for (const c of Object.values(critics)) {
    for (const r of c.reviews) (outletCritics[r.outlet] || (outletCritics[r.outlet] = new Set())).add(c.displayName);
  }
  for (const c of Object.values(critics)) {
    for (const r of c.reviews) {
      if (r.verified && bylineContradicted(r._text, r._critic, [...outletCritics[r.outlet]])) {
        r.verified = false;
        r.bylineContradicted = true;
      }
      delete r._text;
      delete r._critic;
    }
  }

  return { critics, totalFiles, skippedFiles };
}

module.exports = { scanReviewTexts, slugifyCritic, DEFAULT_REVIEW_TEXTS_DIR };
