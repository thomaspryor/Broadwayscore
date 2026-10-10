/**
 * playbill-url-market.js — is a cached Playbill URL for the WRONG MARKET?
 *
 * WHY THIS EXISTS. `data/playbill-urls.json` is a DURABLE cache keyed by show
 * id, and validate-show-venue.js reads it BEFORE it builds any query — so a
 * wrong URL written once is returned forever and no later fix to the query, the
 * venue token or the scorer can dislodge it. Measured on the live cache
 * 2026-09-05: 6 of 113 entries point at an entirely unrelated production, and
 * every one of the 6 is the same shape, a London show cached to a New York URL:
 *
 *   ish-off-west-end-2026          "Ish"          -> circle-jerk-off-broadway-...
 *   kings-2-off-west-end-2026      "Kings 2"      -> richard-ii-henry-iv-off-broadway-...
 *   keith-off-west-end-2026        "Keith"        -> lewberger-the-wizard-of-friendship-off-broadway-...
 *   amplify-off-west-end-2026      "Amplify"      -> paranormal-activity-broadway-...
 *   meet-me-here-off-west-end-2026 "Meet Me Here" -> two-strangers-carry-a-cake-across-new-york-broadway-...
 *   babylon-off-west-end-2026      "Babylon"      -> the-green-pastures-broadway-theatre-vault-...
 *
 * They are all still `announced`, so without this they would be validated with
 * the wrong Playbill page at go-live.
 *
 * Today's scorePlaybillUrl ALREADY rejects every one of these — its cross-market
 * hard reject (card #590) returns null for exactly this shape. That is the
 * point: these entries predate the guard, and because the cache short-circuits
 * ahead of the scorer they never get re-judged. So the check has to run at cache
 * READ time, not only at selection time.
 *
 * WHY *ONLY* THE CROSS-MARKET TEST, and not "re-resolve anything the scorer
 * dislikes". 21 of the 113 cached URLs score null under scorePlaybillUrl, but
 * 15 of those are CORRECT and merely unverifiable:
 *   - 10 are legacy Playbill URLs with no market segment at all, so the scorer's
 *     regex cannot match ("...-eugene-oneill-theatre-vault-0000013715")
 *   - 5 are title-shape mismatches where the URL is right ("Doubt: A Parable"
 *     vs slug "doubt", "& Juliet" vs slug "juliet")
 * Treating score<=0 as a cache miss would evict those 15 correct entries, spend
 * SERP calls re-resolving them, and land them right back on the same hard filter
 * that could not verify them in the first place. The cross-market test flags 6
 * of 113 and all 6 are independently confirmed wrong — zero false positives on
 * the live cache.
 *
 * Pure and separate so both the CLI and the test require() the same predicate
 * (CLAUDE.md rule 15).
 */

'use strict';

const { titleForms, MARKET_KEYWORDS } = require('./playbill-title-match');

/**
 * Does a TITLE slug carry a market word that can be misread as a market
 * segment? Anchored at both ends on a hyphen or the string edge, because the
 * damage happens at the SEAM: "prince-of-broadway" ends in "broadway", and the
 * hyphen Playbill puts between title and venue completes a "-broadway-" the
 * whole-url test then reads as a market segment. The market word does not have
 * to sit INSIDE the title with hyphens on both sides; it only has to straddle
 * the join (the shape that charged NOISES OFF an off-Broadway penalty in the
 * scorer, one module over).
 */
const OWN_TITLE_MARKET_RE = new RegExp(`(?:^|-)(?:off-)?(?:${MARKET_KEYWORDS.join('|')})(?:-|$)`);

/**
 * Remove the SHOW'S OWN title from the front of the URL path, so the market
 * test reads only the part of the URL that can carry market evidence.
 *
 * Returns null — meaning "change nothing" — unless the show's own title both
 * prefixes the path AND contains a market word. That restriction is the whole
 * safety argument: when the title carries no market word, stripping it cannot
 * change any verdict, so not stripping keeps the blast radius to the one case
 * this exists for.
 *
 * WHAT THE UNSTRIPPED TEST WAS SILENTLY CATCHING, enumerated, because replacing
 * a broad test with a narrow one is where the sibling module lost a guard three
 * times in one cycle:
 *   - a market word in a VENUE name ("the-green-pastures-broadway-theatre-vault-
 *     0000012335", a real poisoned entry) — KEPT: the venue lives after the
 *     title, so it survives the strip.
 *   - a market word in ANOTHER show's title, which is the shape of every
 *     poisoned entry — KEPT: a URL naming a different production does not start
 *     with OUR title, so nothing is stripped at all.
 *   - a real market segment following our own title ("the-great-gatsby-broadway-
 *     broadway-theatre-2024") — KEPT: only the title is removed, and the segment
 *     after it still reads as "-broadway-".
 *   - a market word inside our own title, with no market segment anywhere
 *     ("prince-of-broadway-adelphi-theatre-vault-0000123") — DROPPED, which is
 *     the defect: that URL is the show's own page and evicting it throws away a
 *     correct cache entry (BRO-2899).
 *
 * The remainder deliberately keeps its leading "-", so a market word sitting
 * immediately after the title still has the hyphen boundary the caller's
 * substring tests require.
 */
function stripOwnTitlePrefix(pathText, show) {
  const forms = titleForms(show && show.title);
  const candidates = [forms.exact, ...forms.lossless, ...forms.legacyPrefixes]
    .filter((f) => f && OWN_TITLE_MARKET_RE.test(f))
    // Longest first: "prince-of-broadway" must win over a shorter form that is
    // also a prefix, or the strip leaves the title's own market word behind.
    .sort((a, b) => b.length - a.length);
  if (!candidates.length) return null;
  // normalizeTitle strips a leading "the-" that Playbill KEEPS, so the path may
  // carry one our forms never do — the same asymmetry the legacy branch handles.
  const bodies = pathText.startsWith('the-') ? [pathText, pathText.slice(4)] : [pathText];
  for (const body of bodies) {
    for (const f of candidates) {
      if (body === f) return '';
      if (body.startsWith(`${f}-`)) return body.slice(f.length);
    }
  }
  return null;
}

// shows.json carries FIVE categories, measured 2026-09-05: broadway (2027),
// off-broadway (420), west-end (132), off-west-end (335), regional (28).
// Only the London pair is bucketed here, so `regional` falls on the non-London
// side and a regional show cached to a Broadway URL is NOT flagged. That is
// deliberate and still matches scorePlaybillUrl in the direction that matters:
// it never rejects a regional SHOW on a Broadway URL either. Do NOT read the
// other direction off this comment — it used to say scorePlaybillUrl "only
// rejects a regional/tour URL for an off-broadway or category-less show", and
// that stopped being true when CI run 34000023372 went red: the reject now
// covers EVERY non-regional category. A comment describing another module's
// rule is the shape that put main red in the first place, so it is narrowed
// here to the one claim this file's own bucketing depends on.
//
// There are zero such entries in
// the live cache (all 113 resolve to -broadway-, -off-broadway-, -london- or
// no market segment at all, and only the 6 London ones were wrong), and
// widening the buckets means changing the scorer in the same breath — a
// separate change, not a silent one smuggled in here. If a SIXTH category ever
// appears it lands on the non-London side by default, which under-flags rather
// than over-flags: it can leave a wrong URL cached, never evict a correct one.
const LONDON_CATEGORIES = new Set(['west-end', 'off-west-end']);

/**
 * @param {string} url   a playbill.com/production/... URL
 * @param {object} show  a shows.json entry (needs `category`)
 * @returns {boolean} true when the URL's market contradicts the show's market
 */
function isCrossMarketPlaybillUrl(url, show) {
  if (!url || !show) return false;
  const u = String(url).toLowerCase();
  // Read the market off the URL MINUS the show's own title. The title is part
  // of the URL, so a show whose title contains a market word ("Prince of
  // Broadway", a West End production) otherwise decides its own market from its
  // own name and gets its CORRECT page evicted (BRO-2899). Falls back to the
  // whole URL whenever no strip applies, which is every case but that one.
  const at = u.indexOf('/production/');
  const stripped = at === -1
    ? null
    : stripOwnTitlePrefix(u.slice(at + '/production/'.length).replace(/[?#].*$/, '').replace(/\/+$/, ''), show);
  const haystack = stripped === null ? u : stripped;
  // Playbill's West End productions use "london" as the market segment, NOT
  // "west-end" — the same alternative scorePlaybillUrl had to learn (card #590).
  // Substring tests, deliberately: "-broadway-" must keep matching inside
  // "-off-broadway-", and "-london-" inside "-off-london-". Exact-equality
  // classification is what silently disarmed the sibling module's regional
  // reject and turned CI run 34000023372 red.
  const isLondonUrl = haystack.includes('-london-');
  const isNycUrl = haystack.includes('-broadway-') || haystack.includes('-off-broadway-');
  const isLondonShow = LONDON_CATEGORIES.has(show.category);

  // A URL carrying BOTH markers is not evidence of anything — "two-strangers-
  // carry-a-cake-across-new-york-broadway-..." contains "-broadway-" inside a
  // TITLE, and a London title could equally contain "-london-". Only decide
  // when exactly one market marker is present.
  if (isLondonUrl && isNycUrl) return false;

  if (isLondonShow && isNycUrl) return true;
  if (!isLondonShow && isLondonUrl) return true;
  return false;
}

module.exports = {
  isCrossMarketPlaybillUrl,
  LONDON_CATEGORIES,
  // Exported so the test can assert the STRIP itself, not only the verdict it
  // produces: a fixture that only checks the verdict passes unchanged when the
  // strip is deleted and the both-markers guard happens to return false anyway.
  stripOwnTitlePrefix,
  OWN_TITLE_MARKET_RE,
};
