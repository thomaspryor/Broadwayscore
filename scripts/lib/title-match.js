/**
 * Shared title-normalization for matching external audience-source titles
 * (Mezzanine, Theatr, etc.) to our shows.json entries.
 *
 * Why a shared lib: each scraper used to have its own normalize() with subtly
 * different regexes. When Mezzanine's "What Happened Was…" failed to match our
 * "What Happened Was" in 2026-04, the bug was a missing U+2026 in one scraper.
 * Drift across scrapers = recurring class of bugs. One implementation, tested.
 *
 * Design choices:
 *   - Joiners (apostrophes, hyphens) → empty so "Grown-Ups" stays distinct from
 *     "Grown Ups" (different plays).
 *   - Separators (slash, ellipsis, period, comma) → space so "foo/bar" matches
 *     "foo / bar" and "Master Harold...and the Boys" matches the U+2026 form.
 *   - Type designators in TRAILING parens "(Play)" / "(Musical)" preserved as
 *     plain text so Redwood (Play) ≠ Redwood (Musical). Mid-string parens and
 *     bracket content are stripped (codex review caught: bracketed year tags
 *     like "[2024] Show" used to bleed into title tokens).
 *   - Trailing " (the )?musical" stripped so Burlesque ≡ Burlesque the Musical.
 *
 * See scripts/scrape-mezzanine-audience.js for the matching strategies that
 * consume normalize(): exact match, prefix match, sibling year-proximity.
 */

// Type designators that disambiguate revivals/adaptations and MUST be
// preserved. Only matched at end-of-string — mid-string `(Musical)` is venue
// noise (codex caught: "Foo (Musical) Bar" used to bleed "musical" mid-token).
const TYPE_DESIGNATOR_RE = /\s*\((play|musical|comedy|drama|dance|opera|new musical|new play)\)\s*$/i;

// Common abbreviation expansions normalized to their full forms. Source
// scrapers (especially Wikipedia tables) often abbreviate ("Sunset Blvd."
// for "Sunset Boulevard"); without this, the matcher misses an entire DD
// ceremony's worth of categories on every collision. Word-boundary anchored
// so we don't munge unrelated tokens (e.g. "St." in "St. James" expands but
// "BLVD" inside a longer word wouldn't). Period optional — some sources skip
// it. Applied BEFORE the rest of normalization so the expanded word flows
// through the standard punctuation/joiner pipeline.
const ABBREV_EXPANSIONS = [
  [/\bblvd\.?\b/gi, 'boulevard'],
];

/**
 * Canonical diacritic fold: NFD-decompose, then drop combining marks.
 * "Les Misérables" → "Les Miserables", "Último" → "Ultimo", "Dvořák" → "Dvorak".
 *
 * Why this is a shared export rather than a one-liner each caller re-types:
 * every title-matcher in scripts/lib/ compares our (largely ASCII) shows.json
 * titles and showId slugs against source text that spells shows correctly with
 * accents. A matcher that lacks the fold silently drops those shows — confirmed
 * live on 2026-08-01 when NY Sun's "Les Misérables" review (12 body mentions)
 * was suppressed as url_content_mismatch because content-quality.js was the one
 * matcher not folding. Eight siblings had the same latent hole (task #648).
 *
 * NOTE: NFD only handles composable diacritics. Non-decomposing letters (ø, ł,
 * æ, ß, đ) pass through unchanged — no show title in the corpus uses one, and
 * transliterating them would be a real behavior change rather than a fold.
 *
 * @param {string} s
 * @returns {string}
 */
function foldDiacritics(s) {
  return String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function normalizeTitle(s) {
  if (!s) return '';
  let pre = s;
  for (const [re, sub] of ABBREV_EXPANSIONS) pre = pre.replace(re, sub);
  // Strip diacritics: "Les Misérables" → "Les Miserables" so source titles
  // using accented characters match shows.json titles that drop them. Hit
  // when extending precursor scrape back to 1987 (DD 1987 Best Musical was
  // "Les Misérables"; our shows.json has "Les Miserables" without accent).
  pre = foldDiacritics(pre);
  return pre.toLowerCase()
    // & → "and" so "Bonnie & Clyde" === "Bonnie and Clyde"
    .replace(/&/g, ' and ')
    // Trailing type designator: keep as plain text so it survives parens-strip
    // and the trailing-musical strip can normalize it consistently.
    .replace(TYPE_DESIGNATOR_RE, ' $1 ')
    // Strip remaining parenthesized content (venues, composers, season tags).
    // "Cable Street (59e59)" → "Cable Street", "Cinderella (Andrew Lloyd Webber)"
    // → "Cinderella". "Foo (Musical) Bar" — already handled above if trailing,
    // otherwise mid-string parens are noise and get dropped here.
    .replace(/\([^)]*\)/g, ' ')
    // Strip bracketed content the same way: "[2024] Show" → " Show"
    .replace(/\[[^\]]*\]/g, ' ')
    // Joiners → empty (apostrophes, quotes, hyphens, em/en dash). Words don't
    // split: "Grown-Ups" → "grownups" stays distinct from "Grown Ups".
    .replace(/['‘’"“”\-–—]/g, '')
    // Separators/terminators → space. Includes period, comma, slash, ellipsis,
    // brackets etc. Different than joiners — these create token boundaries.
    .replace(/[!?:,.;+*…/]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^the\s+/g, '')
    // Trailing " (the )?musical" so "Urinetown" ≡ "Urinetown The Musical" and
    // "Redwood" ≡ "Redwood (Musical)" (the kept type designator just got
    // stripped to plain "musical" by the parens-text-keep above).
    .replace(/\s+(the\s+)?musical$/, '');
}

// Token set for jaccard-style similarity. Stop words exclude language fillers
// but KEEP 'play' and 'musical' — those are type discriminators and dropping
// them collapses "Redwood (Play)" ≡ "Redwood (Musical)" ≡ "Redwood" to the
// same {redwood} bag (claude review caught: defeats type disambiguation).
const STOP_WORDS = new Set(['the','and','for','with','from','your','our','a','an','of','to','at','in','on']);

function titleTokens(s) {
  return new Set(
    normalizeTitle(s)
      .split(' ')
      .filter(t => t.length >= 3 && !STOP_WORDS.has(t))
  );
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  const inter = [...a].filter(x => b.has(x)).length;
  return inter / new Set([...a, ...b]).size;
}

// ─────────────────────────────────────────────────────────────────────────
// canonicalVenue — collapses venue strings that refer to the same physical
// theater so cross-venue dedupe works.
//
// Why: a producing company (The New Group, Ars Nova) often rents space at
// another venue (Pershing Square Signature Center). Their season pages
// emit `venue: "The New Group"`; the host's season page emits
// `venue: "Signature Theatre"`. Without canonicalization, dedupe sees two
// different keys for the same show.
//
// Approach: alias table → canonical key. Match by lowercased full string OR
// any prefix/substring in the aliases. Unknown venues fall back to the
// first word (legacy behavior).
//
// Add new aliases here (NOT in promote scripts) — single source of truth.
// ─────────────────────────────────────────────────────────────────────────

const VENUE_ALIASES = [
  // The Signature Center on 42nd St — multiple stages, multiple companies rent
  {
    canonical: 'signature center',
    matches: [
      /signature\s*(theatre|theater|center)/i,
      /pershing\s*square/i,
      /irene\s*diamond\s*stage/i,
      /romulus\s*linney/i,
      /alice\s*griffin/i,
      /ford\s*foundation/i,
      // Companies that frequently rent the Signature Center
      /^the\s*new\s*group$/i,
    ],
  },
  // Second Stage operates two stages — the Hayes is Broadway, Uptown is OB
  {
    canonical: 'second stage uptown',
    matches: [/second\s*stage\s*uptown/i, /mcginn[\s\/]*cazale/i],
  },
  // Roundabout's OB stage at the Steinberg Center. shows.json says "The Laura
  // Pels Theatre at the Harold and Miriam Steinberg Center for Theatre";
  // Playbill says "Roundabout Theatre Company - Laura Pels Theatre". Keyed on
  // "laura pels" only — the Steinberg Center also houses the Black Box, so a
  // bare /steinberg/ match would falsely merge those stages.
  {
    canonical: 'laura pels',
    matches: [/laura\s*pels/i],
  },
  // Lincoln Center's OB stage. shows.json says "Lincoln Center Theater -
  // Mitzi E. Newhouse Theater"; Playbill says "Mitzi E. Newhouse Theatre".
  {
    canonical: 'mitzi newhouse',
    matches: [/mitzi\s*(e\.?\s*)?newhouse/i],
  },
  {
    canonical: 'second stage hayes',
    matches: [/hayes\s*theater/i, /second\s*stage.*hayes/i],
  },
  // Atlantic Theater Company — two stages. The lookahead must tolerate words
  // between "Theater" and "Stage 2" ("Atlantic Theater Company Stage 2")
  // or company-form Stage 2 listings collapse onto the mainstage alias.
  {
    canonical: 'atlantic theater',
    matches: [/atlantic\s*theater(?!.*stage\s*2)/i, /linda\s*gross/i],
  },
  {
    canonical: 'atlantic stage 2',
    matches: [/atlantic.*stage\s*2/i],
  },
  // MCC at 511 W 52nd St — multiple sub-stages
  {
    canonical: 'mcc theater',
    matches: [/mcc\s*theater/i, /newman\s*mills/i, /susan.*frankel/i, /robert\s*w\.?\s*wilson\s*mcc/i],
  },
  // Other major OB venues — canonical alias = lowercase venue name
  {
    canonical: 'vineyard theatre',
    matches: [/vineyard\s*theatre/i],
  },
  {
    canonical: 'soho rep',
    matches: [/^soho\s*rep/i],
  },
  {
    canonical: 'tfana',
    matches: [/theatre?\s*for\s*a\s*new\s*audience/i, /polonsky\s*shakespeare/i, /^tfana/i],
  },
  {
    canonical: 'irish rep',
    matches: [/irish\s*repertory/i, /^irish\s*rep/i],
  },
  // Roundabout's Steinberg Center houses TWO stages: the Laura Pels and the
  // Black Box. Black Box must be checked FIRST (aliases scan in order) or the
  // bare /steinberg center/ fallback collapses it onto the Pels key.
  {
    canonical: 'roundabout black box',
    matches: [/black\s*box.*steinberg/i, /steinberg.*black\s*box/i, /roundabout.*black\s*box/i],
  },
  // Roundabout's OB mainstage — listed with/without the company prefix and
  // with the full Steinberg Center name
  {
    canonical: 'laura pels',
    matches: [/laura\s*pels/i, /steinberg\s*center/i],
  },
  // Lincoln Center Theater's OB stage — Playbill omits the LCT prefix
  {
    canonical: 'mitzi newhouse',
    matches: [/mitzi\s*e?\.?\s*newhouse/i],
  },
  // PAC NYC — listed both bare and with the "(PAC NYC)" suffix. Must not
  // match Carnegie Hall's "Perelman Stage".
  {
    canonical: 'pac nyc',
    matches: [/perelman\s*performing\s*arts/i, /\bpac\s*nyc\b/i],
  },
  // 245 W 52nd St — the Virginia Theatre was renamed August Wilson in 2005.
  // shows.json uses the era-accurate name (King Hedley II 2001 = Virginia);
  // Playbill vault pages retro-name it August Wilson. Same building.
  {
    canonical: 'august wilson',
    matches: [/august\s*wilson\s*theat/i, /virginia\s*theat/i],
  },
  // Lincoln Center's opera house. Show Score listing titles carry the bare
  // "(The Metropolitan Opera)" parenthetical; shows.json has the full
  // "Metropolitan Opera House" (BRO-2592 parity check on live listing data —
  // shows.json has exactly one venue matching this pattern, so a shared alias
  // is safe here, unlike BAM below).
  {
    canonical: 'metropolitan opera',
    matches: [/metropolitan\s*opera/i],
  },
  // spit&vigor's own venue — Show Score listing titles carry the bare
  // company name; shows.json has the full "...Tiny Baby Blackbox Theatre"
  // (BRO-2592, same parity check).
  {
    canonical: 'spit and vigor',
    matches: [/spit\s*&\s*vigor/i, /spit\s*and\s*vigor/i],
  },
  // Deliberately NOT aliased: bare "BAM" (Brooklyn Academy of Music) from
  // Show Score listing titles. shows.json has THREE distinct BAM stages
  // (BAM Harvey Theater, BAM Fisher (Fishman Space), BAM Howard Gilman Opera
  // House) that can run different productions concurrently — aliasing bare
  // "BAM" to one canonical would collapse them, the exact failure class
  // BRO-243/venuesMatch exists to prevent. A listing venue of just "BAM"
  // with no stage name is genuinely ambiguous and should NOT auto-match.
];

/**
 * Canonicalize a venue string for cross-source dedupe.
 *
 * @param {string} venue
 * @returns {string} canonical key (lowercased) or first-word fallback
 */
function canonicalVenue(venue) {
  if (!venue || typeof venue !== 'string') return '';
  const trimmed = venue.trim();
  if (!trimmed) return '';
  for (const { canonical, matches } of VENUE_ALIASES) {
    for (const re of matches) {
      if (re.test(trimmed)) return canonical;
    }
  }
  // Fallback: first space/dash/comma-separated word lowercased (legacy)
  return trimmed.toLowerCase().split(/[\s\-,—]/)[0];
}

module.exports = {
  foldDiacritics,
  normalizeTitle,
  titleTokens,
  jaccard,
  canonicalVenue,
  VENUE_ALIASES,
  TYPE_DESIGNATOR_RE,
  STOP_WORDS,
};
