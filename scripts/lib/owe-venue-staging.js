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
const crypto = require('crypto');

const STAGING_PATH = path.join(__dirname, '..', '..', 'data', 'audit', 'owe-venue-candidates.json');

function candidateHash({ title, venue }) {
  const norm = `${(title || '').toLowerCase().trim()}|${(venue || '').toLowerCase().trim()}`;
  return crypto.createHash('sha256').update(norm).digest('hex').slice(0, 16);
}

function loadStaging() {
  try {
    const text = fs.readFileSync(STAGING_PATH, 'utf8');
    const data = JSON.parse(text);
    return Array.isArray(data) ? data : [];
  } catch { return []; }
}

/**
 * Atomic write — tmp file + rename. Prevents half-written staging on crash.
 */
function writeStaging(entries) {
  fs.mkdirSync(path.dirname(STAGING_PATH), { recursive: true });
  const tmp = STAGING_PATH + '.tmp.' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(entries, null, 2));
  fs.renameSync(tmp, STAGING_PATH);
}

/**
 * Insert-or-update candidates by hash. Existing entries with the same hash
 * are replaced (refreshes discoveredAt + evidence); new ones are appended.
 */
function writeStagingCandidates(newCandidates) {
  const existing = loadStaging();
  const byHash = new Map(existing.map(e => [e.candidateHash, e]));
  for (const c of newCandidates) {
    const h = candidateHash(c);
    byHash.set(h, {
      ...c,
      // fetchSingleVenuePage's candidate shape uses `discoverySource`, not
      // `source` — normalize here so a future promoter (mirroring
      // promote-ob-venue-candidates.js, which reads c.source throughout) sees
      // the same field name the OB staging shape already uses, instead of
      // silently getting `undefined` for every OWE candidate.
      source: c.source || c.discoverySource || null,
      discoveredAt: c.discoveredAt || new Date().toISOString(),
      candidateHash: h,
    });
  }
  writeStaging([...byHash.values()]);
}

module.exports = {
  STAGING_PATH,
  candidateHash,
  loadStaging,
  writeStaging,
  writeStagingCandidates,
};
