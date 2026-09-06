#!/usr/bin/env node
/**
 * validate-show-venue.js
 *
 * Cross-validate a show's venue + dates against Playbill's authoritative
 * production page. Catches stub entries where the venue or year are wrong
 * (e.g. a 2014 revival surfaced as a 2026 production by a venue-page scraper).
 *
 * Resolution chain per show:
 *   1. data/playbill-urls.json mapping (cached)
 *   2. SERP query "site:playbill.com production <title> <venue>"
 *      → filter results to /production/ paths
 *      → score by market match (off-broadway vs broadway slug)
 *
 * Comparison:
 *   - venue: canonicalVenue() from scripts/lib/title-match.js
 *   - openingDate: > 30-day delta = mismatch
 *   - opening-year: shows.json year vs Playbill URL year (last 4 digits of slug)
 *
 * Output: data/audit/venue-date-mismatches.json (full report each run).
 *
 * Modes:
 *   --show=ID              one show only
 *   --all-provisional      every entry with provisional:true OR
 *                          discoverySource matching ^manual|^venue-page
 *   --fail-on-mismatch     exit 1 + emit ::error:: lines per mismatch
 *   --dry-run              do not write audit file
 *   --limit=N              cap shows processed (debug aid)
 *   --data-dir=PATH        validate PATH/shows.json instead of the live
 *                          checkout's data/shows.json (autonomous loop
 *                          Tier-2 verification against a candidate branch)
 *   --time-budget-min=N    (--all-provisional only, BRO-2627) stop starting
 *                          new shows once N minutes have elapsed; writes
 *                          whatever was completed so far (never mid-show —
 *                          checked between shows, not via a process-level
 *                          kill, so the audit file always reflects a clean
 *                          boundary). Targets are ordered by how much evidence
 *                          checking them can produce (orderProvisionalTargets
 *                          in lib/venue-date-compare.js): new first, then a
 *                          known mismatch, then a transient error, then
 *                          previously-clean, and last the shows that have no
 *                          Playbill page at all. Only the first two can fail
 *                          the gate when deferred, so a tight budget never
 *                          starves the incident-relevant class this audit
 *                          exists to catch, regardless of total provisional
 *                          count. Within a tier the least-recently-checked
 *                          show goes first, so the deferred tail rotates
 *                          instead of being starved forever (BRO-2701).
 *
 * Usage:
 *   node scripts/validate-show-venue.js --show=sunset-baby-off-broadway-2026
 *   node scripts/validate-show-venue.js --all-provisional
 *   node scripts/validate-show-venue.js --all-provisional --fail-on-mismatch
 *
 * Exit codes (BRO-2821). A run that explicitly names ONE show with --show is
 * held to a stricter contract than a sweep, because a sweep averages rows and
 * a named run has exactly one question to answer:
 *   0  nothing to report — for a --show run, that means it MATCHED Playbill
 *   1  a mismatch — or, under --fail-on-mismatch, a strict sweep that could
 *      not certify clean coverage because the time budget cut off before
 *      reaching a new-or-previously-broken show (deferredHighPriority, the
 *      second arm of that gate). For a --show run a mismatch exits 1 with or
 *      without the flag, since bare --show is the command CLAUDE.md rule 3
 *      documents and it used to exit 0 here
 *   2  the run could not START or could not FINISH: no such show, no mode flag
 *      given, or main() threw (see the catch at the bottom of this file).
 *      Never a statement about the show's data — 0, 1 and 3 are the verdicts
 *   3  --show only: the question was NOT answered. No Playbill page was found,
 *      or the lookup/fetch failed, or the environment could not reach Playbill,
 *      or the run ended before reaching the show. Deliberately distinct from 1:
 *      "I could not check your show" is not "your show is wrong". A sweep never
 *      exits 3 — its equivalent is the ::warning:: degraded-coverage lines.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const { fetchPage, getScraperStats, cleanup } = require('./lib/scraper');
const { serpQuery } = require('./lib/url-discovery');
const { canonicalVenue } = require('./lib/title-match');
// normalizeTitle is no longer imported here: the title comparison it backed
// moved wholesale into playbill-title-match.js (BRO-2821), which calls it.
const { playbillUrlTitleMatch, venueSlug } = require('./lib/playbill-title-match');
const { venuesMatch } = require('./lib/deduplication');
const { parsePlaybillTagLine } = require('./lib/playbill-tagline');
const { decodeEntities } = require('./lib/reverse-discovery');
const {
  DATE_DELTA_DAYS, daysBetween, urlYear, findCorroboratingPriorRun, compareShow,
  orderProvisionalTargets, deferredHighPriorityShows, buildAuditResults, buildPriorTierMap,
  missingUrlOutcome, serpQueryCompleted,
} = require('./lib/venue-date-compare');
const { parseTimeBudgetMin, createRunBudget } = require('./lib/run-budget');
const { venueSearchToken } = require('./lib/venue-search-token');
const { isCrossMarketPlaybillUrl } = require('./lib/playbill-url-market');
const { classifyNamedShowRun } = require('./lib/named-show-verdict');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
// --data-dir overrides ONLY the shows.json this run validates (Sprint 4,
// autonomous nightly loop): SHOWS_PATH is __dirname-relative, so without this
// flag a check invoked from ANY cwd — including a Tier-2 verification
// scratch dir wired to a candidate branch's worktree — would silently
// validate the live checkout's shows.json instead of the candidate diff.
// playbill-urls.json (read cache) and the audit report (output) are NOT part
// of what a card mutates, so they intentionally keep resolving to the real
// repo regardless of this flag.
const dataDirOverride = args.find(a => a.startsWith('--data-dir='))?.split('=').slice(1).join('=');
const SHOWS_PATH = dataDirOverride ? path.join(path.resolve(dataDirOverride), 'shows.json') : path.join(ROOT, 'data', 'shows.json');
const PLAYBILL_URLS_PATH = path.join(ROOT, 'data', 'playbill-urls.json');
// VENUE_AUDIT_PATH redirects the shared report for tests only — the report is
// a repo-wide ledger, so an automated test of the write path must not be able
// to touch the real one (that is the BRO-2696 failure itself). Production and
// CI never set it.
const AUDIT_PATH = process.env.VENUE_AUDIT_PATH
  ? path.resolve(process.env.VENUE_AUDIT_PATH)
  : path.join(ROOT, 'data', 'audit', 'venue-date-mismatches.json');
if (process.env.VENUE_AUDIT_PATH) {
  // Never silent: if this were ever set in CI, the gate would read and update a
  // ledger nobody is looking at while every run still reported success.
  console.log(`::warning::validate-show-venue: VENUE_AUDIT_PATH is set — reading and writing ${AUDIT_PATH} instead of the repo ledger. This override exists for tests only.`);
}

const showFilter = args.find(a => a.startsWith('--show='))?.split('=')[1];
const allProvisional = args.includes('--all-provisional');
const candidatesFile = args.find(a => a.startsWith('--candidates-file='))?.split('=')[1];
const failOnMismatch = args.includes('--fail-on-mismatch');
const dryRun = args.includes('--dry-run');
const limit = parseInt(args.find(a => a.startsWith('--limit='))?.split('=')[1] || '0', 10);
const verbose = args.includes('--verbose');
const timeBudget = createRunBudget(parseTimeBudgetMin(args));

const MONTH_MAP = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
                    jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' };

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function loadShows() {
  const data = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf8'));
  return Array.isArray(data) ? data : (data.shows || []);
}

function loadPlaybillUrlCache() {
  try { return JSON.parse(fs.readFileSync(PLAYBILL_URLS_PATH, 'utf8')); }
  catch { return { shows: {} }; }
}

// BRO-2627: id -> full last-known result row, read from the audit file THIS
// run is about to overwrite. Missing/unparsable is treated as "no prior
// data" (every show sorts as new) rather than an error. Used two ways: (1)
// just the `.result` field feeds orderProvisionalTargets' prioritization,
// (2) a budget-cut run merges these rows forward for any show it didn't
// reach this time, so a deferred show's last-known state survives instead
// of silently vanishing from the file and looking "new" again next run
// (adversarial review finding, BRO-2627) — a best-effort prioritization
// hint either way, never a correctness dependency for the checks themselves.
function loadPreviousResultById() {
  try {
    const prev = JSON.parse(fs.readFileSync(AUDIT_PATH, 'utf8'));
    const out = {};
    for (const r of prev.results || []) out[r.id] = r;
    return out;
  } catch { return {}; }
}

function isProvisional(show) {
  const src = show.discoverySource || '';
  // Roundup-promoted REGIONAL shows are exempt: "the roundup IS the validation"
  // (user rule 2026-07-08, CLAUDE.md §3). Playbill validation false-positives on
  // them because Playbill's /production/ page for a same-title show is often the
  // Broadway transfer, not the regional run (little-bear-ridge-road-regional-2024:
  // Steppenwolf 2024 record vs Playbill's Booth 2025 transfer — main red 2026-07-10).
  if (show.category === 'regional' && src.startsWith('aggregator-roundup')) return false;
  // Free outdoor/park productions with no Playbill /production/ page at all
  // (not tracked by Playbill's commercial-production database) are exempt.
  // Without this, the SERP query in findPlaybillUrl() falls back to a
  // same-titled but unrelated production (e.g. two different "Othello"s in
  // the same year — a commercial Broadway revival WITH a Playbill page, and
  // a free Classical Theatre of Harlem outdoor run WITHOUT one) and reports
  // a false-positive venue/date mismatch. Requires a substantive
  // statusBackfillSource recording the independent cross-validation actually
  // done — the flag alone is not honored, so it can't become a silent
  // stub-from-memory bypass of CLAUDE.md §3 (second-opinion review, task
  // #814).
  if (show.noPlaybillProductionPage === true
      && typeof show.statusBackfillSource === 'string'
      && show.statusBackfillSource.length > 50) return false;
  if (show.provisional === true) return true;
  return src.startsWith('manual-user-request') || src.startsWith('venue-page');
}

// The set of venue slugs the legacy (vault / "-YYYY-YYYY" season) branch
// decomposes URL bodies against. Built once from the corpus and memoised;
// playbill-title-match.js takes it as a parameter rather than reading
// shows.json itself, so the module stays pure and testable. If the corpus
// cannot be read the set is empty, and the legacy branch then REFUSES rather
// than falling back to a bare prefix test — an unreadable corpus must not
// silently become a more permissive matcher.
let _knownVenueSlugs = null;
let _venueMarkets = null;
function buildVenueIndex() {
  const slugs = new Set();
  // venue slug -> the set of markets the corpus has ever staged there. Used to
  // stop a legacy URL crossing markets, which the segment-based guards cannot
  // see because a legacy URL carries no market keyword at all.
  const markets = new Map();
  for (const s of loadShows()) {
    const v = venueSlug(s && s.venue);
    if (!v) continue;
    slugs.add(v);
    if (!markets.has(v)) markets.set(v, new Set());
    markets.get(v).add(marketOf(s && s.category));
  }
  return { slugs, markets };
}
function knownVenueSlugsForCorpus() {
  // `!== null`, not truthiness, and only memoise a NON-EMPTY result. An empty
  // Set is truthy, so the old guard cached a successful-but-empty read (a fixture
  // corpus, a half-written shows.json) and disabled the legacy branch for the
  // rest of the process with no signal — the same failure the catch below goes
  // out of its way to avoid, arriving through the success path instead.
  if (_knownVenueSlugs !== null && _knownVenueSlugs.size > 0) return _knownVenueSlugs;
  try {
    const { slugs, markets } = buildVenueIndex();
    if (slugs.size > 0) { _knownVenueSlugs = slugs; _venueMarkets = markets; }
    return slugs;
  } catch {
    // Do NOT memoise a failure either. Return empty for this call and retry on
    // the next; the legacy branch declines meanwhile rather than loosening.
    return new Set();
  }
}

/**
 * The market granularity the legacy cross-market reject needs. Broadway and
 * off-Broadway are kept DISTINCT, not folded into one "NYC" bucket: an earlier
 * version folded them and an off-Broadway stub titled "Chicago" still scored 8
 * against Broadway's chicago-richard-rodgers-theatre vault page, because both
 * counted as NYC. They are different houses — the corpus has never staged
 * off-Broadway at the Richard Rodgers — so the venue index separates them and
 * the reject fires. A missing category means Broadway, which is this corpus's
 * convention (see the targetShows filter in discover-playbill-urls.js).
 */
function marketOf(category) {
  if (category === 'west-end' || category === 'off-west-end') return 'london';
  if (!category) return 'broadway';
  return String(category);
}

function shortTitleSlug(title) {
  return String(title || '').toLowerCase()
    .replace(/[''""‘’“”]/g, '')
    .replace(/[&]/g, 'and')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Score a Playbill production URL against a show. Returns null when the URL
 * is not a plausible match for THIS title (prevents picking a different show
 * just because the SERP returned it).
 *
 * Hard filter: the slug between /production/ and the first market keyword
 * must equal the show's title slug. "des-moines-off-broadway-..." cannot
 * match "Ms. Blakk for President" no matter how high the other signals score.
 */
function scorePlaybillUrl(url, show) {
  const u = url.toLowerCase();
  // Playbill's West End production URLs use "london" as the market segment
  // (e.g. "bronco-billy-the-musical-london-charing-cross-theatre-2024"), NOT
  // "west-end" — without this alternative the regex never matches a single
  // real West End/Off-West-End Playbill URL, so findPlaybillUrl() silently
  // fails "no-playbill-url" for the entire London market (card #590).
  // BRO-2821. The title gate used to be a single equality: the slug between
  // /production/ and the first market keyword had to normalize EXACTLY to the
  // show's title. Measured against all 107 entries of data/playbill-urls.json —
  // which findPlaybillUrl reads BEFORE this scorer, so they are correct URLs
  // this function has never had to judge — 92 pass and 15 do not, and all 15
  // are right. A show in one of those shapes with no cache entry is stamped
  // 'no-playbill-url' forever, which is the permanently-deferred tier.
  //
  // playbillUrlTitleMatch recovers 14 of the 15 (the miss is Moulin Rouge,
  // whose vault URL says "hirschfeld-theatre" where the corpus says "Al
  // Hirschfeld Theatre") without relaxing to token containment, which the
  // corpus rules out: 392 strict containment pairs across 2,416 titles, with
  // "& Juliet" ⊂ "Romeo and Juliet" both the case the fix must recover and the
  // one it must not collide. See that module's docblock for the branch rules.
  // Guard on the title itself, not on shortTitleSlug's output: that helper is
  // a DIFFERENT normalizer from the one now deciding the match, so testing its
  // truthiness here would read as if it were still part of the decision.
  if (!show || !show.title) return null;
  const titleMatch = playbillUrlTitleMatch(url, show, {
    knownVenueSlugs: knownVenueSlugsForCorpus(),
  });
  if (!titleMatch.match) return null;

  // A relaxed branch is worth strictly less than an exact one, so a same-titled
  // exact URL always outranks a subtitle- or prefix-recovered candidate when
  // both come back in the same SERP page.
  let s = titleMatch.branch === 'exact' ? 10 : 8; // title match earned
  const isOB = show.category === 'off-broadway';
  const isLondon = show.category === 'west-end' || show.category === 'off-west-end';
  // Regional/tour URLs are never a fit for an entry from another market — they
  // describe a different production (different venue, different cast).
  //
  // This used to read `(isOB || !show.category)` while its own comment said
  // "NYC OB/Broadway". The comment was the correct rule and the condition was
  // narrower, so a BROADWAY show was never checked: CI run 34000023372 went red
  // with much-ado-about-nothing-2026 (Winter Garden, opening 2026-11-19)
  // matched at a full score of 10 to
  // /production/much-ado-about-nothing-regional-playmakers-repertory-company-2023,
  // a different production three years earlier. An upcoming Broadway show
  // often has no Playbill page yet, so the scorer reached for the nearest
  // same-titled one. Only a `regional` SHOW may hold a regional/tour URL.
  //
  // And test the segment AFTER the matched title form, never the whole URL.
  // The title is part of the URL, so a whole-URL test lets a show condemn
  // ITSELF on its own name — the same shape as BRO-2821's defect 5, where a
  // venue gate searched the whole URL and a show corroborated itself.
  // "September L. Davis: The Apology Tour" scored null on its own correct
  // off-Broadway page for exactly this reason, a false negative that predates
  // this fix.
  //
  // Take the tail FROM THE MATCHER, do not re-derive it here. This used to read
  // `pathTail.startsWith(titleMatch.form) ? pathTail.slice(form.length) :
  // pathTail`, which looks right and is wrong: `form` is a NORMALIZED title,
  // not a slice of the path, and normalizeTitle strips a leading "the-" that
  // Playbill keeps. So the startsWith failed for every "The …" title and the
  // fallback silently restored whole-url behaviour — on 16 of the 97
  // title-matching live cache entries ("The Great Gatsby", "The Outsiders",
  // "The Wiz", …), with nothing in the output saying so. The matcher already
  // computes the exact tail for the split it chose; it just was not returning
  // it (adversarial review, Codex, 2026-09-06).
  const marketTail = titleMatch.marketTail;
  if ((marketTail.includes('-regional-') || marketTail.includes('-tour-')) && show.category !== 'regional') return null;
  // Cross-market hard reject: a same-titled show can have entirely separate
  // Broadway and West End productions (different venue, cast, often
  // different score) — the +10 title-match alone must never carry a
  // cross-market URL past findPlaybillUrl's `score > 0` filter. A soft
  // penalty isn't enough here: -5 off a +10 title match still nets positive
  // (adversarial review, card #590 — this was a real false-positive path
  // introduced by adding "london" as a recognized market segment above).
  // Read the market off `marketTail`, never off the whole URL, for exactly the
  // reason the regional/tour line above does: the TITLE is part of the URL, so
  // a whole-URL test lets a show decide its own market from its own name.
  //
  // What is MEASURED, 2026-09-06, and what is not. Testing each corpus title's
  // slug for a market word delimited by "-" or a boundary, 16 of 2,942 hit (13
  // broadway, 2 off-broadway, 1 off-west-end; a looser delimiter rule counts
  // 17, so treat this as an order of magnitude, not a census). NONE of them
  // changes score under the MARKET half of this edit, and 0 of the 107 live
  // playbill-urls.json entries differ old-vs-new on it — so the market half is
  // a no-op on everything currently observable, NOT a fix with a live victim.
  // (The VENUE half below does move exactly one live entry; its own comment
  // names it.) It is hardening: the whole-URL read only bites when the title's
  // market word CONTRADICTS the URL's real market segment, which needs a slug
  // whose market word sits INSIDE the title — "the-london-season-off-broadway-…"
  // or "dion-boucicaults-london-assurance-broadway-…", where the whole-URL test
  // sees "-london-" and hard-rejects a non-London show's own page. Pinned by
  // the tests below; not in the corpus today.
  //
  // A vault/legacy URL is NOT a second shape here, though an earlier draft of
  // this comment claimed it was: any path containing a market keyword makes
  // marketTitleSegments() non-empty, so the legacy branch is unreachable for
  // one, and a "…-of-broadway-vault-…" URL simply misses the title match
  // instead (verified: branch null, match false, score null).
  const isLondonUrl = marketTail.includes('-london-');
  if (isLondonUrl && !isLondon) return null;
  // A legacy URL (vault page / "-YYYY-YYYY" season page) carries NO market
  // segment at all, so neither the London check above nor the Broadway check
  // below can see it, and isCrossMarketPlaybillUrl is a no-op on it too. On
  // main that was harmless because such URLs scored null and never got here.
  // Now that they can match, the card #590 cross-market hole reopens through
  // them: all six of these were live, real accepts before this line existed —
  // "Hadestown" (West End) took Broadway's hadestownwalter-kerr-theatre URL,
  // and likewise MJ, SIX, The Lion King, The Book of Mormon and Cursed Child.
  // An earlier version of this rejected only `legacy && isLondon`, which was
  // one-directional and left two shapes open, both reproduced: an OFF-BROADWAY
  // stub titled "Chicago" scored 8 against Broadway's
  // chicago-richard-rodgers-theatre-vault-... , and a BROADWAY show scored 8
  // against a London season page (hamiltonvictoria-palace-theatre-2017-2018),
  // because the venue set is built from the WHOLE corpus and so contains West
  // End and regional slugs too. Both cleared findPlaybillUrl's `score > 0`.
  //
  // The decomposed venue is the market signal a legacy URL does have, so use it:
  // reject unless the corpus has ever staged this show's market at that venue.
  if (titleMatch.branch === 'legacy') {
    const slug = titleMatch.corroboration && titleMatch.corroboration.venueSlugInUrl;
    const staged = slug && _venueMarkets ? _venueMarkets.get(slug) : null;
    if (!staged || !staged.has(marketOf(show.category))) return null;
  }
  if (!isLondonUrl && isLondon && (marketTail.includes('-broadway-') || marketTail.includes('-off-broadway-'))) return null;
  if (marketTail.includes('-off-broadway-')) s += isOB ? 5 : -5;
  else if (marketTail.includes('-broadway-')) s += isOB ? -5 : 5;
  else if (isLondonUrl) s += 5;
  const cv = canonicalVenue(show.venue || '');
  if (cv) {
    const cvSlug = cv.replace(/\s+/g, '-');
    // Same rule as the market words: read the venue off the tail, not the whole
    // url. 18 of 2,942 titles contain their own venue slug (stub titles shaped
    // "Show — Venue": "The Cherry Orchard Park Avenue Armory", "Dear England
    // New Wimbledon Theatre", …), so a whole-url read lets those shows
    // corroborate themselves.
    //
    // An earlier draft of this comment argued the bonus was harmless because
    // the title appears in every title-matching candidate, so +2 would land on
    // all of them equally and could not reorder them. That argument is FALSE
    // and adversarial review caught it: competing candidates do not have to
    // consume the SAME title text. exact, lossless and lossy branches each
    // consume a different form, so an exact candidate whose title embeds the
    // venue takes +2 while a lossy candidate naming the real venue in its tail
    // may not — and findPlaybillUrl ranks strictly on this score.
    //
    // Legacy URLs have no market keyword and therefore no tail, but the matcher
    // has already decomposed a KNOWN venue slug out of the path to accept them
    // at all, so use that verified slug rather than the raw path.
    const venueHaystack = titleMatch.branch === 'legacy'
      ? `-${(titleMatch.corroboration && titleMatch.corroboration.venueSlugInUrl) || ''}-`
      : marketTail;
    if (venueHaystack.includes(cvSlug)) s += 2;
  }
  // The year lives in the tail alongside the venue, and a title can contain a
  // four-digit number ("1776", "Spring Dances 2026"), so read it off the tail
  // for the same reason. Legacy shapes are the exception on purpose: they are
  // ANCHORED on their trailing "-vault-N" / "-YYYY-YYYY", which is where their
  // year is, and they have no tail — so they keep reading the whole url, and
  // the matcher has already required the rest of the path to decompose exactly
  // into our title plus a known venue, leaving no room for a stray title year.
  const idYear = (show.id || '').match(/\d{4}/)?.[0];
  const yearHaystack = titleMatch.branch === 'legacy' ? u : marketTail;
  if (idYear && yearHaystack.includes(idYear)) s += 1;
  return s;
}

async function findPlaybillUrl(show, log) {
  const cache = loadPlaybillUrlCache();
  if (cache.shows && cache.shows[show.id]) {
    const cached = cache.shows[show.id];
    // SELF-HEAL. This cache is durable and keyed by show id, and it is read
    // BEFORE any query is built — so a wrong URL written once is returned
    // forever, and no later fix to the query, the venue token or the scorer can
    // dislodge it. 6 of 113 live entries were a London show pointing at a New
    // York production; scorePlaybillUrl's cross-market reject (card #590)
    // already refuses that shape, but those entries predate it and the cache
    // short-circuits ahead of the scorer, so they were never re-judged. Treat a
    // cross-market hit as a MISS and fall through to a fresh resolve.
    // Deliberately narrow — see the docblock in scripts/lib/playbill-url-market.js
    // for why "anything the scorer dislikes" would evict 15 CORRECT entries.
    if (isCrossMarketPlaybillUrl(cached, show)) {
      log(`    ⚠ ignoring cross-market cached Playbill URL (${cached}) — re-resolving`);
    } else {
      return { url: cached, source: 'cache' };
    }
  }
  const market = show.category === 'off-broadway' ? 'Off-Broadway'
    : (show.category === 'west-end' || show.category === 'off-west-end') ? 'London'
    : 'Broadway';
  // BRO-2821: this used to be the venue's FIRST whitespace token, which is a
  // stopword for 202 of the 2,943 shows carrying a venue (6.9%) — "New World
  // Stages" -> "New", "St. James Theatre" -> "St.", "The Theater Center" ->
  // "The" — so the query carried no venue signal at all. venueSearchToken picks
  // the first distinctive token instead, and returns '' when a venue has none.
  const venueWord = venueSearchToken(show.venue);
  // An empty venueWord must not leave a dangling separator: `"Title" Broadway `
  // and `"Title" ` are the same queries as their trimmed forms to a search
  // engine, but serp-cache.js keys on the query STRING, so the untrimmed
  // variants would cut a second, permanently-missing cache entry for the 5
  // shows whose venue has no distinctive word. Trim, then drop duplicates —
  // without a venue term the first two variants collapse into one.
  const queries = [...new Set([
    `site:playbill.com/production "${show.title}" ${market} ${venueWord}`.trim(),
    `site:playbill.com/production "${show.title}" ${venueWord}`.trim(),
    `site:playbill.com production "${show.title}" ${market}`.trim(),
  ])];
  // BRO-2701 review finding 1: this loop used to fall through to the same
  // `source: 'none'` whether we LOOKED and found no Playbill page, or never
  // managed to look at all. Both were then stamped 'no-playbill-url', which is
  // a permanently-deferred, never-blocking tier — so a provider outage during
  // one push could demote a brand-new stub with a wrong venue out of the gate
  // for good. Track whether any query actually completed.
  let anyQueryCompleted = false;
  for (const q of queries) {
    let results = null;
    try { results = await serpQuery(q, { nbResults: 10 }); }
    catch (e) { log(`    serp error: ${e.message}`); continue; }
    // null (not []) is how serpQuery reports "no provider answered" — a thrown
    // error is NOT the outage path. See serpQueryCompleted's docblock.
    if (!serpQueryCompleted(results)) { log(`    serp unavailable (no provider answered)`); continue; }
    anyQueryCompleted = true;
    if (!results.length) continue;
    const candidates = results
      .filter(r => r.url && r.url.includes('playbill.com/production/'))
      .map(r => {
        const cleanUrl = r.url.replace(/[?#].*$/, '');
        return { url: cleanUrl, score: scorePlaybillUrl(cleanUrl, show) };
      })
      .filter(c => c.score !== null && c.score > 0)
      .sort((a, b) => b.score - a.score);
    if (candidates.length) {
      return { url: candidates[0].url, source: 'serp', score: candidates[0].score };
    }
    await sleep(800); // rate limit between SERP fallbacks
  }
  // Every query threw: we have no evidence about this show either way, and
  // saying so is what keeps it in the retry-worthy tier instead of the
  // "this show has no Playbill page" one.
  // Return the WHOLE outcome, not just `.source` (BRO-2701 review 3, finding 3).
  // validateOne used to rebuild the decision with `source !== 'serp-error'`, so
  // any third failure source added here later would silently default to
  // 'no-playbill-url' — the permanently-parked tier this refactor exists to
  // keep shows out of.
  return { url: null, ...missingUrlOutcome({ anyQueryCompleted }) };
}

function parseTitleVenueYear(html) {
  // Page title pattern: "Title (Off-Broadway, Venue, YYYY) | Playbill"
  const tm = html.match(/<title>([^<]+)<\/title>/);
  if (!tm) return null;
  // Playbill's raw <title> text carries HTML entities (e.g. "St. Ann&#039;s
  // Warehouse") — decode before parsing/comparing or venuesMatch() never
  // matches an apostrophe-bearing venue against shows.json's plain text.
  const t = decodeEntities(tm[1]).trim();
  const m = t.match(/^(.*?)\s*\(\s*(Broadway|Off-Broadway|Off-Off-Broadway|West End|Tour)\s*,\s*([^,]+?)\s*,\s*(\d{4})\s*\)/i);
  if (!m) return { rawTitle: t, market: null, venue: null, year: null };
  return { rawTitle: m[1].trim(), market: m[2], venue: m[3].trim(), year: parseInt(m[4], 10) };
}

function parseFactDates(html) {
  // Each fact block:
  //   <div class="bsp-list-promo-title">First Preview|Opening Date|Closing Date</div>
  //   ...
  //   <span class="info-circular-pre-text">Jan</span>
  //   <span class="info-circular-text">30</span>
  //   <span class="info-circular-post-text">2024</span>
  const out = { firstPreview: null, openingDate: null, closingDate: null };
  const re = /<div class="bsp-list-promo-title">([^<]+)<\/div>[\s\S]{0,1200}?<span class="info-circular-pre-text">\s*([A-Za-z]{3})\s*<\/span>\s*<span class="info-circular-text">\s*(\d{1,2})\s*<\/span>\s*<span class="info-circular-post-text">\s*(\d{4})\s*<\/span>/g;
  let m;
  while ((m = re.exec(html))) {
    const label = m[1].toLowerCase().trim();
    const mon = MONTH_MAP[m[2].toLowerCase().slice(0, 3)];
    const day = m[3].padStart(2, '0');
    const yr = m[4];
    if (!mon) continue;
    const iso = `${yr}-${mon}-${day}`;
    if (label.includes('first preview')) out.firstPreview = iso;
    else if (label.includes('opening')) out.openingDate = iso;
    else if (label.includes('closing')) out.closingDate = iso;
  }
  return out;
}

async function validateOne(show, log) {
  log(`\n${show.id}  "${show.title}"  (${show.venue})`);
  const urlResult = await findPlaybillUrl(show, log);
  if (!urlResult.url) {
    const outcome = { source: urlResult.source, result: urlResult.result };
    log(outcome.result === 'serp-error'
      ? `  ⚠ Playbill lookup FAILED (every SERP query errored) — not evidence of a missing page`
      : `  ⚠ no Playbill URL found`);
    return {
      id: show.id, title: show.title, venue: show.venue,
      result: outcome.result, urlSource: urlResult.source,
      mismatches: [], playbillUrl: null, parsed: null,
    };
  }
  log(`  url (${urlResult.source}): ${urlResult.url}`);

  let html = '';
  const pwMissingBefore = getScraperStats().pwBrowserMissingCount;
  try {
    const r = await fetchPage(urlResult.url, { timeout: 30000 });
    html = r.html || r.content || '';
  } catch (e) {
    // fetchPage() only throws once EVERY transport it tried has failed. If
    // Playwright was one of those transports for THIS fetch and it failed
    // because no browser is installed in this environment (not because the
    // page itself rejected the request), this show could not actually be
    // checked — it is an infrastructure gap, not evidence of a venue/date
    // mismatch. Reporting it as a generic 'fetch-error' let a missing-browser
    // CI job read exactly like a pile of real scrape failures (BRO-2560).
    //
    // Compares the counter before/after THIS call rather than reading a
    // sticky "ever happened" flag — a global flag would misattribute a
    // LATER, unrelated total-fetch-failure (a real 404, a real block, both
    // paid providers exhausted) to "missing browser" just because some
    // earlier show in the same process happened to hit that error.
    const infra = getScraperStats().pwBrowserMissingCount > pwMissingBefore;
    log(`  ⚠ ${infra ? 'infra-unavailable (Playwright browser missing)' : 'fetch error'}: ${e.message}`);
    return {
      id: show.id, title: show.title, venue: show.venue,
      result: infra ? 'infra-unavailable' : 'fetch-error', error: e.message,
      mismatches: [], playbillUrl: urlResult.url, parsed: null,
    };
  }
  if (!html || html.length < 5000) {
    log(`  ⚠ short response (${html.length} bytes)`);
    return {
      id: show.id, title: show.title, venue: show.venue,
      result: 'short-response', htmlBytes: html.length,
      mismatches: [], playbillUrl: urlResult.url, parsed: null,
    };
  }

  const titleParse = parseTitleVenueYear(html);
  const dates = parseFactDates(html);
  const tagLine = parsePlaybillTagLine(html);
  const parsed = { titleParse, dates, tagLine };
  log(`  parsed venue: ${titleParse?.venue || '(none)'} | year ${titleParse?.year || '(none)'} | opening ${dates.openingDate || '(none)'} | revival ${tagLine.revivalStatus}`);

  const { mismatches, explainedByPriorRun } = compareShow(show, parsed, urlResult.url);
  if (explainedByPriorRun.length) {
    log(`  ℹ ${explainedByPriorRun.length} field(s) explained by priorRuns (Playbill page describes an earlier run):`);
    explainedByPriorRun.forEach(m => log(`    - ${m.field}: shows=${m.shows ?? m.showsCanonical} playbill=${m.playbill ?? m.playbillCanonical}${m.deltaDays ? ` (Δ${m.deltaDays}d)` : ''}`));
  }
  if (mismatches.length === 0) {
    log(`  ✓ match`);
    return {
      id: show.id, title: show.title, venue: show.venue,
      result: 'match', playbillUrl: urlResult.url, parsed, mismatches: [], explainedByPriorRun,
    };
  }
  log(`  ✗ ${mismatches.length} mismatch(es):`);
  mismatches.forEach(m => log(`    - ${m.field}: shows=${m.shows ?? m.showsCanonical} playbill=${m.playbill ?? m.playbillCanonical}${m.deltaDays ? ` (Δ${m.deltaDays}d)` : ''}`));
  return {
    id: show.id, title: show.title, venue: show.venue,
    result: 'mismatch', playbillUrl: urlResult.url, parsed, mismatches, explainedByPriorRun,
  };
}

async function main() {
  let targets;
  // Populated only in the --all-provisional branch; used after the loop to
  // (a) merge a budget-deferred show's last-known state forward into this
  // run's output instead of losing it, and (b) escalate rather than exit
  // clean when the deferred tail included a new/still-broken show (BRO-2627
  // adversarial review — a --fail-on-mismatch gate that silently drops
  // coverage of the exact class it exists to catch is not actually strict).
  // Computed ONCE, above the mode branches, so no mode can run without it
  // (BRO-2696). These used to be populated only inside the --all-provisional
  // branch, which meant a `--show=<id>` run wrote a one-row audit report over
  // the shared, tracked one and destroyed CI's prioritization state. Hoisting
  // makes "a filtered run truncates the report" structurally impossible rather
  // than a branch someone has to remember to keep in sync.
  const allShows = loadShows();
  const provisionalShows = allShows.filter(isProvisional);
  const previousResultsById = loadPreviousResultById();
  // --data-dir points shows.json at a CANDIDATE branch's copy while the ledger
  // still resolves to the real repo (documented above), so the two describe
  // different universes. Retiring rows on that basis would let a candidate
  // branch delete real coverage, so in that combination the write set is the
  // union — nothing already in the ledger is dropped — and fingerprint
  // staleness is not evaluated against a shows.json the ledger is not about.
  // VENUE_AUDIT_PATH means the ledger was redirected alongside shows.json, so
  // the two DO describe the same universe and normal semantics apply.
  const mismatchedUniverse = Boolean(dataDirOverride) && !process.env.VENUE_AUDIT_PATH;
  const currentProvisionalIds = new Set([
    ...provisionalShows.map(s => s.id),
    ...(mismatchedUniverse ? Object.keys(previousResultsById) : []),
  ]);
  const showsById = mismatchedUniverse
    ? null
    : Object.fromEntries(provisionalShows.map(s => [s.id, s]));
  // BRO-2701 review finding 3: this used to map EVERY prior row to its
  // `.result` unconditionally, while buildAuditResults drops fingerprint-stale
  // rows at write time. A show whose venue/dates were edited since its last
  // check therefore kept its old non-blocking tier, got deferred, did not block
  // the gate, and was only caught a run later — in exactly the "a bad venue
  // edit landed" case. buildPriorTierMap applies the same staleness rule, so
  // such a show tiers as new: checked first, and blocking if deferred.
  const previousResultOnlyById = buildPriorTierMap({ previousResultsById, showsById });
  if (candidatesFile) {
    // Validate candidates from an external JSON file (no shows.json entry
    // required). Used by discover-ob-historical.js to surface authoritative
    // Playbill dates before promotion.
    const data = JSON.parse(fs.readFileSync(candidatesFile, 'utf8'));
    const list = Array.isArray(data) ? data : (data.candidates || []);
    targets = list.map(c => ({
      id: c.id || (c.title || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') + '-off-broadway-pending',
      title: c.title,
      venue: c.venue,
      category: 'off-broadway',
      openingDate: c.openingDate || c.firstDateSeen || null,
      closingDate: c.closingDate || c.lastDateSeen || null,
    }));
  } else if (showFilter) {
    targets = allShows.filter(s => s.id === showFilter || s.slug === showFilter);
    if (!targets.length) {
      console.error(`Show not found: ${showFilter}`);
      process.exit(2);
    }
  } else if (allProvisional) {
    targets = orderProvisionalTargets(provisionalShows, previousResultOnlyById);
  } else {
    console.error('Pass --show=ID, --all-provisional, or --candidates-file=PATH');
    process.exit(2);
  }
  if (limit > 0) targets = targets.slice(0, limit);

  console.log(`validate-show-venue: ${targets.length} target(s)`);
  if (dryRun) console.log('[DRY RUN — audit file not written]');

  const log = verbose || targets.length <= 5 ? console.log : () => {};
  const results = [];
  for (const show of targets) {
    if (timeBudget.exceeded()) break;
    const r = await validateOne(show, log);
    results.push(r);
    await sleep(400);
  }
  const deferredShows = targets.slice(results.length);
  const deferred = deferredShows.length;
  // orderProvisionalTargets puts new shows and known mismatches first, so
  // under normal load a budget cut only defers shows whose outcome could not
  // fail this step anyway (previously-clean, transient errors, and shows with
  // no Playbill page — see BRO-2701) — but if new/mismatch volume itself
  // exceeds the budget in one run, some of THOSE land in the deferred tail
  // too. That's the exact incident class this audit exists to catch, so it
  // must not exit clean.
  const deferredHighPriority = deferredHighPriorityShows(deferredShows, previousResultOnlyById);
  if (deferred > 0) {
    // Loud, not silent — a partial run must not look identical to full
    // coverage (same rationale as the infra-unavailable warning below).
    console.log(`::warning::validate-show-venue: time budget (${timeBudget.minutes} min) reached — ${deferred} show(s) deferred to the next run, ${results.length}/${targets.length} checked this run.`);
    if (deferredHighPriority.length) {
      console.log(`::warning::validate-show-venue: ${deferredHighPriority.length} of the deferred show(s) are new or previously-broken — NOT a clean pass: ${deferredHighPriority.map(s => s.id).join(', ')}`);
    }
  }

  const mismatches = results.filter(r => r.result === 'mismatch');
  const infraUnavailable = results.filter(r => r.result === 'infra-unavailable');
  const errors = results.filter(r => ['fetch-error', 'short-response', 'no-playbill-url', 'serp-error'].includes(r.result));
  const matches = results.filter(r => r.result === 'match');
  const explainedCount = results.reduce((n, r) => n + (r.explainedByPriorRun?.length || 0), 0);

  console.log('');
  console.log(`Summary: ${matches.length} match / ${mismatches.length} mismatch / ${errors.length} unresolved / ${infraUnavailable.length} infra-unavailable${explainedCount ? ` (${explainedCount} field(s) explained by priorRuns across ${results.filter(r => r.explainedByPriorRun?.length).length} show(s))` : ''}`);
  if (infraUnavailable.length) {
    // A distinct, non-failing category: these shows were NOT checked at all,
    // so their absence from `mismatches` is not a clean bill of health — it
    // means the environment couldn't reach Playbill for them (e.g. `npx
    // playwright install` was never run in this job). Surfaced as a
    // ::warning:: (not ::error::) so it shows up in the CI annotations
    // without failing the step on an infra basis alone (BRO-2560).
    console.log(`::warning::validate-show-venue: ${infraUnavailable.length} show(s) could not be checked — Playwright browser missing in this environment (infra gap, NOT a venue/date mismatch): ${infraUnavailable.map(r => r.id).join(', ')}`);
    // Not failing the step is correct (BRO-2560 acceptance criteria), but a
    // run that validated NOTHING must not look identical to a clean pass —
    // that silently hides any real mismatch among the unchecked shows. Loud,
    // still non-failing.
    if (infraUnavailable.length === results.length) {
      console.log(`::warning::validate-show-venue: ALL ${results.length} target(s) were infra-unavailable this run — ZERO real venue/date validation coverage, not a clean pass`);
    }
  }
  // Same rule, the other way a run can validate nothing (BRO-2701 second
  // review, finding 2). Since tiers 2-4 no longer populate deferredHighPriority,
  // a run where EVERY show came back unresolved — a SERP outage, or a local run
  // with no SERP keys — exits 0 with nothing to say, which is indistinguishable
  // from a clean pass and is exactly the state that then gets committed as the
  // rotation ledger. Loud, still non-failing (unresolved is not a mismatch).
  // Gate on what was actually LEARNED, not on one bucket filling up (BRO-2701
  // review 3, finding 2). The first cut required errors.length === results.length,
  // but infra-unavailable rows are deliberately excluded from `errors`, so a run
  // of 30 serp-error + 35 infra-unavailable tripped neither guard despite
  // validating nothing — and 60 serp-error + 5 match was silent too. Since
  // tiers 2-4 no longer block on deferral, this is the ONLY signal a degraded
  // run leaves behind, so it must fire on degradation, not just on totality.
  // The denominator is only the shows that COULD produce a verdict (BRO-2701
  // review 4, finding 4). A 'no-playbill-url' show has no Playbill page, so it
  // can never yield one by design, and roughly half the committed ledger is
  // exactly that (32 match / 33 no-playbill-url today). Counting them made a
  // perfectly healthy full sweep report 32/65 and warn "DEGRADED" on every run
  // — and since tiers 2-4 no longer block on deferral, this warning is the only
  // signal a genuinely degraded run leaves behind, so a permanent false
  // positive on it would be worse than not having it.
  const definitive = matches.length + mismatches.length;
  // 'no-playbill-url' shows are genuinely unanswerable, so they are the only
  // ones excluded from the denominator.
  const noPage = results.filter(r => r.result === 'no-playbill-url').length;
  const answerable = results.length - noPage;
  if (answerable > 0 && definitive === 0) {
    console.log(`::warning::validate-show-venue: NONE of the ${answerable} answerable target(s) produced a venue/date verdict this run — ZERO real validation coverage, not a clean pass`);
  } else if (answerable > 0 && definitive < answerable / 2) {
    console.log(`::warning::validate-show-venue: only ${definitive}/${answerable} answerable target(s) produced a venue/date verdict this run — DEGRADED coverage, treat a green result with suspicion`);
  }
  if (mismatches.length) {
    console.log('Mismatches:');
    for (const r of mismatches) {
      console.log(`  ${r.id}`);
      for (const m of r.mismatches) {
        console.log(`    - ${m.field}: shows=${JSON.stringify(m.shows ?? m.showsCanonical)} playbill=${JSON.stringify(m.playbill ?? m.playbillCanonical)}${m.deltaDays ? ` (Δ${m.deltaDays}d)` : ''}`);
      }
      console.log(`    pb: ${r.playbillUrl}`);
    }
  }

  // Merge this run's fresh results over the prior report's rows for any
  // currently-provisional show this run didn't reach (deferred, or simply
  // outside a --limit slice) — otherwise a deferred show's last-known state
  // vanishes from the file entirely and every future run sees it as "new"
  // again instead of retaining its real priority tier (BRO-2627 adversarial
  // review). Applies to EVERY mode: a --show/--candidates-file run used to
  // write exactly what it checked, which truncated the shared report to one
  // row and put main red with zero real mismatches (BRO-2696).
  const outputResults = buildAuditResults({
    freshResults: results,
    previousResultsById,
    currentProvisionalIds,
    showsById,
  });
  const carriedForwardCount = outputResults.length - results.length;

  if (!dryRun) {
    fs.mkdirSync(path.dirname(AUDIT_PATH), { recursive: true });
    let filterMeta;
    if (showFilter) filterMeta = { show: showFilter };
    else if (candidatesFile) filterMeta = { candidatesFile, limit: limit || null };
    else filterMeta = { allProvisional: true, limit: limit || null };
    const out = {
      generatedAt: new Date().toISOString(),
      filter: filterMeta,
      timeBudgetMin: timeBudget.enabled ? timeBudget.minutes : null,
      // `counts` describes what THIS run checked; `total` in the output
      // file (outputResults.length) can exceed it when prior rows were
      // carried forward — see carriedForward above.
      counts: { total: results.length, match: matches.length, mismatch: mismatches.length, unresolved: errors.length, infraUnavailable: infraUnavailable.length, deferred, carriedForward: carriedForwardCount },
      results: outputResults,
    };
    // Atomic: CI and several local sessions rewrite this tracked ledger, and a
    // half-written file reads as a truncated one — the exact BRO-2696 failure.
    const tmpPath = `${AUDIT_PATH}.${process.pid}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(out, null, 2));
    fs.renameSync(tmpPath, AUDIT_PATH);
    console.log(`Wrote audit: ${AUDIT_PATH}`);
  }

  // Gated on `mismatches` only — infra-unavailable and other unresolved
  // shows never fail this step on their own (BRO-2560: a CI job with no
  // Playwright browser installed must not read as a wall of venue/date
  // mismatches). deferredHighPriority is a second, independent gate: the
  // budget cut off before reaching a new-or-still-broken show, so this run
  // cannot claim clean coverage of the exact class the STRICT gate exists
  // to catch (BRO-2627).
  if (failOnMismatch && (mismatches.length || deferredHighPriority.length)) {
    for (const r of mismatches) {
      for (const m of r.mismatches) {
        console.log(`::error::${r.id}: ${m.field} shows=${m.shows ?? m.showsCanonical} playbill=${m.playbill ?? m.playbillCanonical}`);
      }
    }
    if (deferredHighPriority.length) {
      console.log(`::error::validate-show-venue: time budget exhausted before checking ${deferredHighPriority.length} new/previously-broken show(s) — cannot certify a clean pass: ${deferredHighPriority.map(s => s.id).join(', ')}`);
    }
    // Wrapped for the same reason the success path below is (adversarial
    // review, Codex): an unwrapped throw here would reject main(), fall into
    // the catch, and exit 2 — silently converting an intended "this entry
    // mismatches Playbill" into "the script crashed". cleanup() swallows its
    // own errors internally so this should never fire; the asymmetry with
    // every other exit path was the defect.
    // NOT behaviour-pinned by a test, and deliberately so: cleanup() lives in
    // lib/scraper.js and swallows its own errors, so forcing it to throw would
    // mean adding an injection seam to shared scraping infrastructure to guard
    // a one-line wrapper. Reverting this try/catch leaves every test green —
    // known, recorded here rather than left for the next reader to discover.
    try { await cleanup(); } catch (_) { /* best-effort */ }
    process.exit(1);
  }

  // BRO-2821 suggestion 1: for a caller that named ONE show, neither an
  // UNRESOLVED result nor a confirmed MISMATCH is benign. Runs AFTER the audit
  // ledger is written above (this run did happen and its row must be recorded)
  // and AFTER the --fail-on-mismatch gate, which already exited 1 with its
  // ::error:: lines whenever that flag was passed. Unconditional — NOT gated
  // on --fail-on-mismatch — because the command CLAUDE.md rule 3 tells an
  // operator to run before committing a stub is the BARE `--show=<id>` form,
  // which is exactly where the silence was: it printed "Mismatches:" and then
  // exited 0. `targets.length` is passed so a run that ended before reaching
  // the named show (the time-budget `break` in the loop above is not gated on
  // --all-provisional) fails closed instead of reading as a clean pass. The
  // decision itself lives in scripts/lib/named-show-verdict.js so it is
  // testable without a network run; see that module's docblock for why the
  // aggregate degraded-coverage warnings above do not cover this case.
  const named = classifyNamedShowRun({ showFilter, results, targetCount: targets.length });
  if (!named.validated) {
    console.log(`::error::${named.message}`);
    // Also on stderr, deliberately duplicating the line above. The autonomous
    // Tier-2 verifier (scripts/autonomous-merge.js) turns a non-zero exit into
    // a human-readable block reason via
    // `String(err.stderr || err.stdout || err.message).slice(0, 400)` — the
    // FIRST 400 characters. This script's stdout by then holds a full run log,
    // so an stdout-only reason would be reported as the log's opening lines and
    // the actual cause would never appear on the card. On stderr it is the
    // whole reason string.
    console.error(named.message);
    try { await cleanup(); } catch (_) { /* best-effort */ }
    process.exit(named.exitCode);
  }

  // BRO-2701: this script never released the scraper, and until now it never
  // had to — every CI run ended at the process.exit(1) above, which force-exits
  // regardless of open handles. Making the gate PASSABLE made the success path
  // reachable for the first time, and it hung: run 33471909555 wrote its audit
  // at 05:20:28 and was still alive at 05:35:03 when the job's cancellation
  // SIGTERMed it (exit 143), turning a clean pass into a red step ~15 minutes
  // later. Playwright's Chromium keeps its stdio pipes open, so node's event
  // loop never drains on its own — the identical shape as task #438, which
  // cleanup() in lib/scraper.js was written to solve (10s close race, then
  // SIGKILL the subprocess). discover-new-shows.js already calls it; this
  // script simply never did.
  //
  // Wrapped, exactly like the catch path below (second-opinion warning): an
  // unwrapped throw here would reject main(), fall into the catch, and exit 2 —
  // converting a PASSING run into a red step, which is the precise failure this
  // commit exists to remove. cleanup() swallows its own errors internally so
  // this should never fire, but the asymmetry was indefensible.
  try { await cleanup(); } catch (_) { /* best-effort */ }
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch(async (e) => {
      console.error('Fatal:', e.stack || e.message);
      // Release the browser on the error path too, or a thrown error leaves the
      // same hung Chromium behind that the success path just learned about.
      try { await cleanup(); } catch (_) { /* best-effort */ }
      process.exit(2);
    });
}

module.exports = {
  isProvisional, shortTitleSlug, scorePlaybillUrl,
  parseTitleVenueYear, parseFactDates, urlYear, daysBetween, compareShow,
  findCorroboratingPriorRun, findPlaybillUrl, validateOne,
};
