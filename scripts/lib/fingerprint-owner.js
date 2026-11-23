'use strict';
const { isForumThreadUrl } = require('./talkinbroadway-forum-link');
/**
 * Pick which file "owns" each content fingerprint within one show, for the
 * duplicateTextOf flag written by scripts/backfill-review-flags.js (1C).
 *
 * BRO-4188: the old rule was "first file in readdir order wins". When a
 * same-URL byline pair (scripts/dedupe-same-url-bylines.js) had the loser
 * sorting first, the weekly backfill pointed the canonical at its own loser
 * (duplicateTextOf), the daily dedupe cleared it again, and the same-url gate
 * spiked to 205 groups every Sunday.
 *
 * Rule: prefer a file that is not already a duplicate of something
 * (no duplicateOf), then one whose url is not a forum repost, then one
 * without duplicateTextOf, then readdir order.
 *
 * BRO-8206: a Talkin' Broadway All That Chat forum thread
 * (allthatchat_new/d.php) carried the same text as Alix Cohen's Theater
 * Pizzazz review. "talkinbroadway--" sorts before "theater-pizzazz--", so the
 * forum repost owned the text and the real article was hidden as its
 * duplicate (reader submission #1200 could not go live). A forum repost
 * never owns text a real outlet page also carries. The forum rank outweighs
 * duplicateTextOf so a stale pointer written under the old rule heals on
 * the next weekly run.
 *
 * @param {Array<{file:string, fingerprint:string, url?:string, duplicateOf?:string, duplicateTextOf?:string}>} entries
 * @returns {Map<string,string>} fingerprint -> owner file
 */
function pickFingerprintOwners(entries) {
  const rank = e => (e.duplicateOf ? 4 : 0) + (isForumThreadUrl(e.url) ? 2 : 0) + (e.duplicateTextOf ? 1 : 0);
  const best = new Map();
  for (const e of entries) {
    if (!e || !e.fingerprint) continue;
    const cur = best.get(e.fingerprint);
    if (!cur || rank(e) < rank(cur)) best.set(e.fingerprint, e);
  }
  const owners = new Map();
  for (const [fp, e] of best) owners.set(fp, e.file);
  return owners;
}

/**
 * The duplicateTextOf target for `file`, or null when it should carry none.
 * Never points a file at itself, and never at a file that already declares
 * itself a duplicate of `file` (that would make a two-file cycle).
 *
 * @param {string} file
 * @param {string|undefined} owner  owner file for this file's fingerprint
 * @param {{duplicateOf?:string, duplicateTextOf?:string}|undefined} ownerData
 */
function duplicateTextTarget(file, owner, ownerData) {
  if (!owner || owner === file) return null;
  if (ownerData && (ownerData.duplicateOf === file || ownerData.duplicateTextOf === file)) return null;
  return owner;
}

module.exports = { pickFingerprintOwners, duplicateTextTarget };
