/**
 * doubled-market-ids.js — does a shows.json id carry its market segment twice?
 *
 * WHY THIS EXISTS. shows.json ids follow <title-slug>-<market>-<YYYY>. When a
 * show's TITLE has absorbed its market ("1536 West End" for a production
 * actually called "1536"), the title slug already ends in a market word and the
 * id comes out as "1536-west-end-off-west-end-2026" — the market twice, from a
 * title that was built from something other than the work's name. That is the
 * visible symptom of a bad title, and the title is what readers see (BRO-2886).
 *
 * WHAT THIS IS NOT. A doubled market is NOT proof of a defect. A show can be
 * genuinely named after a market: "Lauder: Scotland's Kilted King of Broadway"
 * really is called that, so "lauder-...-of-broadway-off-broadway-2026" is
 * correct and must keep its id. NO SYNTACTIC RULE SEPARATES THE TWO CASES —
 * both are a title slug ending in a market word followed by a market segment.
 * The difference is a fact about the world, not about the string. So this is a
 * detector with an ALLOWLIST of confirmed-correct titles, not a rule.
 *
 * VOCABULARY IS BORROWED, NEVER COPIED. MARKET_KEYWORDS lives in
 * playbill-title-match.js and is the one list the Playbill scorer, the
 * cross-market cache guard and this detector all read. A second copy here is
 * exactly the drift BRO-2894 is about.
 *
 * WHAT A LOOSER TEST CAUGHT THAT THIS ONE DOES NOT, enumerated, because
 * replacing a broad test with a narrow one is where the sibling modules lost
 * guards three times in one cycle (crown v40):
 *   - a market word anywhere in the middle of the slug
 *     ("shreks-adventure-london-standard-entry-off-west-end-2026") — DROPPED on
 *     purpose. The doubling defect is about the SEAM between the title slug and
 *     the market segment, so only a market word at the END of the prefix can be
 *     the market leaking in. A market word mid-title is just a title.
 *   - markets beyond broadway/west-end — KEPT and WIDENED. The card's original
 *     regex covered only those two; london, regional and tour are equally able
 *     to double, and "tour" in particular collides with real show titles, which
 *     is why the allowlist exists rather than a narrower keyword set.
 */

const { MARKET_KEYWORDS } = require('./playbill-title-match');

// Confirmed-correct titles whose own name ends in a market word. Adding a row
// here is a claim that the TITLE was checked against a source, not a way to
// silence the detector — the reason string is the record of that check.
const ALLOWLIST = new Map([
  ['lauder-scotlands-kilted-king-of-broadway-off-broadway-2026',
    'Title is "Lauder: Scotland\'s Kilted King of Broadway" — "of Broadway" is the work\'s name.'],
  ['september-l-davis-the-apology-tour-off-broadway-2026',
    'Title is "September L. Davis: The Apology Tour" — "Tour" is the work\'s name, not a touring market.'],
  ['paranormal-activity-national-tour-regional-2025',
    'Title is "Paranormal Activity"; "national-tour" is the id\'s RUN DESCRIPTOR, matching its five '
    + 'siblings paranormal-activity-{chicago,los-angeles,dc,sf,boston}-regional-*. The descriptor '
    + 'happens to end in a market word; the title never absorbed one.'],
]);

/**
 * HOW THE ONE REAL DEFECT WAS TOLD APART FROM THESE THREE, since no rule does
 * it: the SAME production appeared twice in shows.json under two different
 * titles. "1536" at the Ambassadors and "1536 West End" at the Almeida are one
 * play by Ava Pickett, and the transfer entry carried the correct name. A show
 * contradicting itself is the evidence; a title merely ending in a market word
 * is not. Look for that contradiction before deciding a flagged row is broken.
 */

// <title-slug>-<market>-<YYYY>, market optionally prefixed "off-".
//
// The prefix is LAZY, and that is load-bearing. A greedy prefix splits
// "...-of-broadway-off-broadway-2026" as prefix "...-of-broadway-off" plus
// market "broadway", because `(?:off-)?` is optional and the longer prefix wins
// — leaving a prefix ending in "off", which is not a market word, so the row is
// silently missed. Lazy takes the SHORTEST prefix, which pins the market to the
// last market segment INCLUDING its "off-", the way the id convention means it.
// What greedy caught that lazy drops: the split that treats a trailing "-off"
// as part of the title ("noises-off-broadway-2016" -> "noises-off" + "broadway",
// which is the correct reading of NOISES OFF). Lazy reads that id as "noises" +
// "off-broadway" instead — a wrong market, but "noises" ends in no market word
// so the row is a non-match either way and no verdict changes.
const TRAILING_MARKET_RE = new RegExp(
  `^(.*?)-((?:off-)?(?:${MARKET_KEYWORDS.join('|')}))-(\\d{4})$`,
);

/**
 * @param {string} id a shows.json id
 * @returns {{prefix:string, market:string, year:string, doubledWord:string}|null}
 *   null when the id does not end in <market>-<YYYY>, or when its title slug
 *   does not itself end in a market word.
 */
function doubledMarketParts(id) {
  const m = TRAILING_MARKET_RE.exec(String(id || ''));
  if (!m) return null;
  const [, prefix, market, year] = m;
  // Only a market word at the END of the title slug can be the market leaking
  // across the seam. Longest first so "west-end" wins over a shorter keyword
  // that is also a suffix.
  const word = [...MARKET_KEYWORDS]
    .sort((a, b) => b.length - a.length)
    .find((k) => prefix === k || prefix.endsWith(`-${k}`));
  if (!word) return null;
  return { prefix, market, year, doubledWord: word };
}

/** @returns {boolean} true when the id doubles its market AND is not allowlisted. */
function isUnallowlistedDoubledMarketId(id) {
  return doubledMarketParts(id) !== null && !ALLOWLIST.has(String(id));
}

/**
 * @param {Array<{id:string,title:string}>} shows
 * @returns {{flagged:Array, allowlisted:Array}}
 */
function sweepShows(shows) {
  const flagged = [];
  const allowlisted = [];
  for (const show of shows || []) {
    const parts = doubledMarketParts(show && show.id);
    if (!parts) continue;
    const row = { id: show.id, title: show.title, ...parts };
    if (ALLOWLIST.has(show.id)) allowlisted.push({ ...row, reason: ALLOWLIST.get(show.id) });
    else flagged.push(row);
  }
  return { flagged, allowlisted };
}

module.exports = {
  ALLOWLIST,
  TRAILING_MARKET_RE,
  doubledMarketParts,
  isUnallowlistedDoubledMarketId,
  sweepShows,
};
