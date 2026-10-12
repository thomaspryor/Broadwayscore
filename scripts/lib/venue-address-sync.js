'use strict';
// scripts/lib/venue-address-sync.js — keep theaterAddress in step with venue
// on every shows.json write (BRO-5136).
//
// WHY: many writers change `venue` (execute-approved-fix, update-show-status,
// enrich-*, normalize-venues) and none of them touch theaterAddress. On
// 2026-10-12 an approved fix moved 28 Roundabout Broadway runs from "Harold and
// Miriam Steinberg Center for Theatre" to "Studio 54" and left the Steinberg
// address behind; validate-data.js then refused to autofix (> 5 mismatches) and
// main test.yml went red. Fixing it once in the write guard covers every writer.
//
// Deliberately narrow: an address is rewritten only when it is EXACTLY the
// canonical address of a different known venue, i.e. provably the old venue's
// address. A hand-entered or unknown address is never touched, so a wrong
// registry entry cannot silently rewrite correct data (the risk validate-data's
// autofix cap guards against).
const { VENUE_ADDRESSES, getTheaterAddress } = require('./venue-addresses.js');

const KNOWN_ADDRESSES = new Set(Object.values(VENUE_ADDRESSES));

/**
 * Rewrite stale theaterAddress values in place.
 *
 * @param {Array<object>} shows
 * @returns {Array<{id: string, venue: string, from: string, to: string}>} what changed
 */
function syncStaleTheaterAddresses(shows) {
  const changed = [];
  for (const show of shows || []) {
    // Same scope as validate-data.js's registry cross-check (Broadway only).
    if (!show || !show.theaterAddress || (show.category || 'broadway') !== 'broadway') continue;
    const canonical = getTheaterAddress(show.venue);
    if (!canonical || show.theaterAddress === canonical) continue;
    if (!KNOWN_ADDRESSES.has(show.theaterAddress)) continue;
    // venue-write-guard-ok: change report echoes the existing venue; only theaterAddress is written.
    changed.push({ id: show.id, venue: show.venue, from: show.theaterAddress, to: canonical });
    show.theaterAddress = canonical;
  }
  return changed;
}

module.exports = { syncStaleTheaterAddresses };
