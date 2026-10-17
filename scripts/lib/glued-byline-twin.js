/**
 * Glued-byline twin detector (BRO-5104).
 *
 * A BroadwayWorld roundup excerpt sometimes gets a criticName with the
 * preceding token(s) of the roundup line glued on front ("Brenner Helen Shaw"
 * for Helen Shaw) and no url, so the url-keyed duplicate checks never link it
 * to the full review and the outlet counts twice (NYT on RSC As You Like It,
 * Broadwayworld on Slave Play: "Murray Alexander Cohen" vs "Alexander Cohen").
 *
 * Rule: same show + same outlet, the loser has NO url and its folded name is
 * the winner's folded name with 1-2 extra leading words; the winner is an
 * unflagged row with a real name of 2+ words (so "Shaw" never absorbs
 * "Helen Shaw" and one-word bylines are left alone). Pure.
 */

'use strict';

const MAX_EXTRA_LEADING_WORDS = 2;

function words(name) {
  return String(name || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z\s'-]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

function isGluedVariantOf(loserName, winnerName) {
  const l = words(loserName);
  const w = words(winnerName);
  if (w.length < 2) return false;
  const extra = l.length - w.length;
  if (extra < 1 || extra > MAX_EXTRA_LEADING_WORDS) return false;
  return w.every((tok, i) => l[extra + i] === tok);
}

/**
 * @param {{file:string, outletId:string, criticName?:string, url?:string, flagged?:boolean}[]} records
 *   one show's rows. outletId must already be canonical.
 * @returns {Map<string,string>} loser file -> winner file
 */
function findGluedBylineTwins(records) {
  const byOutlet = new Map();
  for (const r of records || []) {
    if (!r || !r.outletId || !r.criticName) continue;
    if (!byOutlet.has(r.outletId)) byOutlet.set(r.outletId, []);
    byOutlet.get(r.outletId).push(r);
  }
  const losers = new Map();
  for (const rows of byOutlet.values()) {
    for (const loser of rows) {
      if (loser.url) continue;
      const winner = rows.find(w => w !== loser && !w.flagged && isGluedVariantOf(loser.criticName, w.criticName));
      if (winner) losers.set(loser.file, winner.file);
    }
  }
  return losers;
}

module.exports = { findGluedBylineTwins, isGluedVariantOf };
