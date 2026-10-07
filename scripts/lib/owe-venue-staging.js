'use strict';

/**
 * Off-West-End venue-page discovery staging (BRO-182).
 *
 * Mirrors the Off-Broadway staging pattern in venue-listing-discover.js —
 * candidates discovered from VENUE_LISTING_PAGES venue pages
 * (discover-new-shows.js's fetchShowsFromVenueListings) are written HERE,
 * not directly to shows.json. Before BRO-182 all 10 Off-West-End venue-page
 * sources (Almeida, Menier, Southwark, The Other Palace, ...) pushed
 * discovered shows straight into shows.json, unlike the Off-Broadway path
 * which stages to data/audit/ob-venue-candidates.json and requires
 * scripts/promote-ob-venue-candidates.js cross-validation before landing.
 * Venue pages list one-night events (talks, tribute concerts, short kids
 * shows) alongside real productions, so the same staging discipline applies
 * here: a separate promotion step (scripts/promote-owe-venue-candidates.js)
 * reviews staged candidates before they become real shows.json entries.
 *
 * Kept as its own small module (not a refactor of venue-listing-discover.js's
 * OB-specific functions) — same reasoning as we-listing-discover.js having
 * its own file: each market's staging is independently testable and neither
 * risks breaking the other's callers.
 */

const fs = require('fs');
const path = require('path');
const { withFileLock } = require('./file-lock');

const STAGING_PATH = path.join(__dirname, '..', '..', 'data', 'audit', 'owe-venue-candidates.json');

// The key function lives in owe-candidate-hash.js (write-free) so the push-
// time merger can import it without dragging this file's fs writes onto the
// safe-form allowlisted audits' require graph (BRO-4268); re-exported here
// so every existing caller keeps its import.
const { candidateHash } = require('./owe-candidate-hash');

// `stagingPath` on every function below defaults to the real STAGING_PATH;
// it exists so tests (and only tests) can exercise the real locked
// read-modify-write against a scratch file instead of the committed
// data/audit/owe-venue-candidates.json — same seam venue-listing-discover.js
// gives the OB staging file.
function loadStaging(stagingPath = STAGING_PATH) {
  try {
    const text = fs.readFileSync(stagingPath, 'utf8');
    const data = JSON.parse(text);
    return Array.isArray(data) ? data : [];
  } catch { return []; }
}

/**
 * BRO-4484: the read half of updateStaging. Unlike loadStaging (lenient, for
 * readers), an existing file that does not parse as an array returns null so
 * updateStaging refuses to rewrite it: writing a mutation of "[]" over a
 * corrupt or conflict-marked file reads, at push time, as a prune of every
 * row (the staging merge is three-way and honours prunes). A missing file is
 * a genuine empty staging list.
 */
function loadStagingForUpdate(stagingPath = STAGING_PATH) {
  let text;
  try {
    text = fs.readFileSync(stagingPath, 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') return [];
    return null;
  }
  try {
    const data = JSON.parse(text);
    return Array.isArray(data) ? data : null;
  } catch {
    return null;
  }
}

/**
 * Atomic write — tmp file + rename. Prevents half-written staging on crash.
 * tmp name is PID-scoped so two concurrent writers can't clobber each
 * other's in-flight tmp file.
 */
function writeStaging(entries, stagingPath = STAGING_PATH) {
  fs.mkdirSync(path.dirname(stagingPath), { recursive: true });
  const tmp = stagingPath + '.tmp.' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(entries, null, 2));
  fs.renameSync(tmp, stagingPath);
}

/**
 * Locked read-modify-write for the staging file (BRO-4204 S4-T11 — the
 * same shape as venue-listing-discover.js's updateStaging, BRO-158).
 *
 * Two producers now touch this file: discover-new-shows.js's OWE venue-page
 * fan-out (writeStagingCandidates, upsert) and scripts/promote-owe-venue-
 * candidates.js's post-promotion prune. `mutateFn` is called with the
 * CURRENT on-disk entries, read fresh AFTER the lock is acquired — never a
 * snapshot a caller read before its venue fetches — so the promoter
 * expresses its outcome as a removal predicate over candidateHash rather
 * than writing back a pre-computed array, and anything staged concurrently
 * on the same host survives. writeStaging only runs if mutateFn returns
 * without throwing, so a mutateFn error leaves the on-disk file untouched.
 *
 * Same-host protection only: the two CI producers run in separate checkouts
 * and are serialized by sharing the `shows-json-writer` concurrency group
 * instead (update-show-status.yml + promote-owe-venue-candidates.yml — see
 * scripts/lib/core-data-merge-registry.js's entry for this file).
 *
 * Fails open (same as withFileLock generally): if the lock can't be
 * acquired within the timeout, the read-modify-write still runs, just
 * unprotected — a warning is logged rather than blocking the caller forever.
 *
 * @param {(current: object[]) => object[]} mutateFn
 * @param {string} [stagingPath]
 * @returns {object[]} the entries actually written
 */
function updateStaging(mutateFn, stagingPath = STAGING_PATH) {
  const lockPath = `${stagingPath}.lock`;
  let lockHeld = false;
  const next = withFileLock(lockPath, (held) => {
    lockHeld = held;
    const current = loadStagingForUpdate(stagingPath);
    if (current === null) {
      console.error(`::error::owe-venue-candidates staging file ${stagingPath} exists but is not a JSON array — refusing to rewrite it (BRO-4484: a rewrite would prune every row at push time). Fix or restore the file.`);
      return [];
    }
    const updated = mutateFn(current);
    if (!Array.isArray(updated)) {
      throw new Error(`updateStaging: mutateFn must return an array, got ${updated === null ? 'null' : typeof updated}`);
    }
    writeStaging(updated, stagingPath);
    return updated;
  });
  if (!lockHeld) {
    console.warn('::warning::owe-venue-candidates staging lock could not be acquired (assumed stale/unwritable) — the read-modify-write ran unprotected. A concurrent producer could have lost data.');
  }
  return next;
}

/**
 * Pure upsert-by-hash (BRO-4204 S8-T3 extraction, CLAUDE.md §15): the merge
 * writeStagingCandidates has always applied, split out so the promoter's
 * `--stage-file --dry-run` can merge hand-prepared candidates into the
 * CURRENT staging entries in memory — evaluating exactly the union a real
 * run would write — without touching the file. Existing entries with the
 * same candidateHash are replaced (refreshes discoveredAt + evidence); new
 * ones are appended; `existing` is never mutated.
 *
 * @param {object[]} existing entries as loadStaging returns them
 * @param {object[]} newCandidates rows with at least {title, venue}
 * @param {{now?: Date}} [opts]
 * @returns {object[]} the merged entries
 */
function mergeCandidates(existing, newCandidates, opts = {}) {
  const now = opts.now instanceof Date ? opts.now : new Date();
  const byHash = new Map((Array.isArray(existing) ? existing : []).map(e => [e.candidateHash, e]));
  for (const c of newCandidates) {
    const h = candidateHash(c);
    byHash.set(h, {
      ...c,
      // fetchSingleVenuePage's candidate shape uses `discoverySource`, not
      // `source` — normalize here so the promoter (scripts/promote-owe-
      // venue-candidates.js, mirroring promote-ob-venue-candidates.js,
      // which reads c.source throughout) sees the same field name the OB
      // staging shape already uses, instead of silently getting
      // `undefined` for every OWE candidate.
      source: c.source || c.discoverySource || null,
      discoveredAt: c.discoveredAt || now.toISOString(),
      candidateHash: h,
    });
  }
  return [...byHash.values()];
}

/**
 * Insert-or-update candidates by hash (mergeCandidates above), routed
 * through updateStaging so a concurrent same-host prune (the promoter) and
 * this upsert (discovery, or the promoter's --stage-file merge) can't lose
 * each other's writes.
 */
function writeStagingCandidates(newCandidates, stagingPath = STAGING_PATH) {
  return updateStaging((existing) => mergeCandidates(existing, newCandidates), stagingPath);
}

module.exports = {
  STAGING_PATH,
  candidateHash,
  loadStaging,
  writeStaging,
  updateStaging,
  mergeCandidates,
  writeStagingCandidates,
};
