// scripts/lib/review-url-collision.js — one URL, one review (BRO-3092).
//
// validate-data.js ERRORS when two records of the same show carry the same
// URL ("One URL per outlet per show = one review"). Nothing stopped a WRITER
// from creating that state, so the gate could only ever report the damage
// after the fact — and by then the damage was worse than a red build:
//
//   the-addams-family-2010, 2026-09-08 08:41Z. gather-reviews' merge loop
//   matched an incoming BWW-roundup row to wsj--terry-teachout.json on
//   outlet+byline, then took the roundup's URL — which wsj--unknown.json had
//   already owned since March. mergeReviews saw a urlChanged and, correctly
//   for a genuine URL correction, ran applyUrlChangeInvariant: Teachout's
//   dtliExcerpt, bwwExcerpt, showScoreExcerpt, ensemble llmScore and
//   assignedScore 72 were all wiped as "old-URL-derived state". The record
//   that survived into reviews.json was the OTHER one — 6.6KB of WSJ
//   registration boilerplate under the byline "Unknown".
//
// A URL swap onto a URL a sibling record already holds is never a valid
// outcome: either the two records are the same review (they need MERGING, not
// a second copy of the URL) or the candidate URL is wrong. Refusing the swap
// is safe in both readings — the file keeps the URL and the content it has,
// and the existing duplicate/byline-cluster audits still get their shot.
//
// The identity function is the validator's own, exported here so the guard and
// the gate can never drift apart (CLAUDE.md §15).

const fs = require('fs');
const path = require('path');

/**
 * The same-URL duplicate identity used by validate-data.js's URL-uniqueness
 * check. Deliberately NOT outlet-scoped: an outlet id that drifts across a
 * subdomain (suntimes.com vs chicago.suntimes.com) mints a second outlet and
 * would hide the double-counted score from an outlet-scoped key.
 *
 * @param {string} url
 * @returns {string|null} canonical key, or null when there is no usable url
 */
function sameUrlKey(url) {
  if (!url || typeof url !== 'string') return null;
  return url.toLowerCase().replace(/#.*$/, '').replace(/\/$/, '');
}

/**
 * Full validator key: one show's records are compared against each other.
 *
 * @param {string} showId
 * @param {string} url
 * @returns {string|null}
 */
function sameUrlDuplicateKey(showId, url) {
  const key = sameUrlKey(url);
  return key === null ? null : `${showId}|${key}`;
}

/**
 * Does a DIFFERENT review file in this show already own `url`?
 *
 * Self-identity is (outletId, criticName) — review filenames are
 * `<outletId>--<criticSlug>.json`, so that pair addresses exactly one file.
 * Callers that know the filename can pass `selfFilename` instead/as well.
 *
 * Flagged files (wrongProduction/wrongShow/duplicateOf) are INCLUDED on
 * purpose: they still reach reviews.json and still trip the validator, and a
 * flagged sibling owning the URL is precisely the hole in
 * findExistingReviewFile's pass-0 dedup (which skips them) that let this
 * class through in review-file-writer.
 *
 * Fails open — an unreadable dir or file yields "no collision", never a throw.
 *
 * @param {object} args
 * @param {string} args.showDir     absolute path to data/review-texts/<showId>
 * @param {string} args.url         the candidate url about to be written
 * @param {string} [args.selfOutletId]
 * @param {string} [args.selfCriticName]
 * @param {string} [args.selfFilename]
 * @returns {{filename: string, url: string}|null}
 */
function findSiblingUrlOwner({ showDir, url, selfOutletId, selfCriticName, selfFilename } = {}) {
  const candidateKey = sameUrlKey(url);
  if (!candidateKey || !showDir) return null;

  let files;
  try {
    files = fs.readdirSync(showDir).filter(f => f.endsWith('.json') && f !== 'failed-fetches.json');
  } catch {
    return null; // no dir yet — nothing to collide with
  }

  for (const file of files) {
    if (selfFilename && file === selfFilename) continue;
    let data;
    try {
      data = JSON.parse(fs.readFileSync(path.join(showDir, file), 'utf8'));
    } catch {
      continue; // unreadable sibling — cannot prove a collision, so allow
    }
    if (!data || !data.url) continue;
    if (sameUrlKey(data.url) !== candidateKey) continue;
    // Self-identity. The FILENAME is authoritative and is checked above, so
    // when the caller supplied one, every other file on disk is a genuine
    // sibling — full stop.
    //
    // The (outletId, criticName) fallback exists only for callers that do not
    // know the filename, and it is deliberately NOT applied when selfFilename
    // is known: byline drift makes that pair non-unique in the real corpus.
    // 1536-west-end-2026 holds broadwayworld--cindy-marcolina.json whose
    // criticName field reads "Debbie Gilpin" — the same pair as its
    // broadwayworld--debbie-gilpin.json sibling. Applying the fallback there
    // made the guard skip the actual colliding file and let the swap through.
    if (!selfFilename) {
      const sameOutlet = selfOutletId != null
        && String(data.outletId || '') === String(selfOutletId);
      const sameCritic = selfCriticName != null
        && String(data.criticName || '') === String(selfCriticName);
      if (sameOutlet && sameCritic) continue;
    }
    return { filename: file, url: data.url };
  }
  return null;
}

module.exports = { sameUrlKey, sameUrlDuplicateKey, findSiblingUrlOwner };
