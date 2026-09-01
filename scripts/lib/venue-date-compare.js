/**
 * Pure comparison logic for validate-show-venue.js — extracted per CLAUDE.md
 * §15 (test extraction pattern: pure decision functions live in scripts/lib/
 * so tests require() the real function instead of re-implementing it).
 *
 * Compares a shows.json entry against a parsed Playbill production page and
 * reports mismatches on venue / opening-year / openingDate / closingDate /
 * isRevival.
 */

'use strict';

const { canonicalVenue } = require('./title-match');
const { venuesMatch } = require('./deduplication');

const DATE_DELTA_DAYS = 30;

function daysBetween(a, b) {
  if (!a || !b) return null;
  const da = new Date(a);
  const db = new Date(b);
  if (isNaN(da.getTime()) || isNaN(db.getTime())) return null;
  return Math.round(Math.abs((db - da) / 86400000));
}

function urlYear(url) {
  const m = url.match(/-(\d{4})(?:[\/?#]|$)/);
  return m ? parseInt(m[1], 10) : null;
}

/**
 * Does show.priorRuns contain an entry whose venue AND at least one date
 * corroborate what Playbill's page describes? When yes, Playbill's indexed
 * production page is validating a PRIOR run of this same recurring/remounted
 * production, not shows.json's CURRENT dates — so a venue/opening-year/
 * openingDate/closingDate "mismatch" against that page is explained, not a
 * data error (BRO-2544: The Dead, 1904's 2026 remount vs Playbill's
 * still-indexed 2024 page; Bedlam's Othello Nov 2026 encore vs Playbill's
 * page for the May 2026 original run — Playbill hadn't indexed a
 * remount-specific page for either as of 2026-08-30).
 *
 * Reuses the same `priorRuns` field gather-reviews.js/rebuild-all-reviews.js
 * already read to re-include a prior run's reviews (CLAUDE.md "Returning
 * production → priorRuns") instead of inventing a second recurring-show
 * marker or a bare bypass flag.
 *
 * Deliberately requires an ACTUAL corroborating match — venue equality via
 * venuesMatch() AND at least one date within DATE_DELTA_DAYS — not just
 * "priorRuns is non-empty". An unrelated or wrong priorRuns entry (or one
 * that doesn't actually match what Playbill says) must not blanket-suppress
 * a real mismatch; this is a self-verifying corroboration, not a bypass.
 *
 * @returns {object|null} the matching priorRuns entry, or null
 */
function findCorroboratingPriorRun(show, parsed) {
  const priorRuns = Array.isArray(show?.priorRuns) ? show.priorRuns : [];
  const pbVenue = parsed?.titleParse?.venue;
  if (!priorRuns.length || !pbVenue) return null;
  return priorRuns.find(run => {
    if (!run || !run.venue || !venuesMatch(run.venue, pbVenue)) return false;
    const openDelta = daysBetween(run.openingDate, parsed.dates?.openingDate);
    const closeDelta = daysBetween(run.closingDate, parsed.dates?.closingDate);
    return (openDelta !== null && openDelta <= DATE_DELTA_DAYS)
        || (closeDelta !== null && closeDelta <= DATE_DELTA_DAYS);
  }) || null;
}

const PRIOR_RUN_EXPLAINABLE_FIELDS = new Set(['venue', 'opening-year', 'openingDate', 'closingDate']);

/**
 * @param {object} show shows.json entry
 * @param {object} parsed { titleParse, dates, tagLine } from validate-show-venue.js
 * @param {string} playbillUrl the Playbill production URL that was fetched
 * @returns {{ mismatches: object[], explainedByPriorRun: object[] }}
 */
function compareShow(show, parsed, playbillUrl) {
  const mismatches = [];
  const explainedByPriorRun = [];
  const corroboratingPriorRun = findCorroboratingPriorRun(show, parsed);
  const record = (m) => {
    if (corroboratingPriorRun && PRIOR_RUN_EXPLAINABLE_FIELDS.has(m.field)) {
      explainedByPriorRun.push({ ...m, priorRun: corroboratingPriorRun });
    } else {
      mismatches.push(m);
    }
  };
  const showVenueCanon = canonicalVenue(show.venue || '');
  const pageVenueCanon = canonicalVenue(parsed.titleParse?.venue || '');
  // The actual mismatch decision uses venuesMatch(), not the showVenueCanon/
  // pageVenueCanon equality above (those two stay as display-only fields in
  // the audit record below) — canonicalVenue()'s fallback for a venue
  // outside VENUE_ALIASES is just the lowercased FIRST WORD, so two
  // genuinely different venues sharing a leading word ("The X") would
  // silently PASS this check as "not a mismatch" (BRO-243). That's the wrong
  // direction of error for a venue-mismatch DETECTOR — false negatives are
  // exactly what this script exists to catch.
  if (show.venue && parsed.titleParse?.venue && !venuesMatch(show.venue, parsed.titleParse.venue)) {
    record({
      field: 'venue',
      shows: show.venue,
      showsCanonical: showVenueCanon,
      playbill: parsed.titleParse?.venue,
      playbillCanonical: pageVenueCanon,
    });
  }

  // Year: prefer URL year (always present); cross-check with title year.
  const pbYear = urlYear(playbillUrl) || parsed.titleParse?.year || null;
  const showYear = (() => {
    if (show.openingDate) return parseInt(show.openingDate.slice(0, 4), 10);
    const idy = (show.id || '').match(/\d{4}/);
    return idy ? parseInt(idy[0], 10) : null;
  })();
  if (pbYear && showYear && pbYear !== showYear) {
    record({ field: 'opening-year', shows: showYear, playbill: pbYear });
  }

  // Date deltas (only when both ends are known).
  if (show.openingDate && parsed.dates?.openingDate) {
    const delta = daysBetween(show.openingDate, parsed.dates.openingDate);
    if (delta !== null && delta > DATE_DELTA_DAYS) {
      record({
        field: 'openingDate',
        shows: show.openingDate,
        playbill: parsed.dates.openingDate,
        deltaDays: delta,
      });
    }
  }
  if (show.closingDate && parsed.dates?.closingDate) {
    const delta = daysBetween(show.closingDate, parsed.dates.closingDate);
    if (delta !== null && delta > DATE_DELTA_DAYS) {
      record({
        field: 'closingDate',
        shows: show.closingDate,
        playbill: parsed.dates.closingDate,
        deltaDays: delta,
      });
    }
  }

  // Revival status: Playbill prints "Revival" or "Original" on every
  // production page it has classified — authoritative, not a title
  // heuristic. Catches both directions of BRO-2023: a prior production this
  // corpus never recorded (Playbill says Revival, shows.json says false) and
  // a same-title transfer misread as a revival (Playbill says Original,
  // shows.json says true). Not priorRun-explainable — isRevival is a
  // structural fact about the production, not a run-specific date/venue.
  if (parsed.tagLine && parsed.tagLine.revivalStatus !== 'unknown') {
    const playbillIsRevival = parsed.tagLine.revivalStatus === 'revival';
    if (!!show.isRevival !== playbillIsRevival) {
      mismatches.push({
        field: 'isRevival',
        shows: !!show.isRevival,
        playbill: playbillIsRevival,
      });
    }
  }
  return { mismatches, explainedByPriorRun };
}

/**
 * Order provisional shows for a time-budgeted --all-provisional run (BRO-2627).
 *
 * A fixed --time-budget-min caps how many shows get network-checked per run,
 * so which shows are checked first matters. Shows are ordered by how much
 * evidence checking them can produce about the incident class this audit
 * exists to catch (a bad venue/date stub landing in shows.json):
 *
 *   0  new / never-checked  — could BE the bad new stub. Always first.
 *   1  previously 'mismatch' — a known data defect; recheck so a fix is seen.
 *   2  previously a TRANSIENT error (fetch-error / short-response /
 *      infra-unavailable) — no evidence last time, but a retry plausibly
 *      yields some.
 *   3  previously 'match' — clean; a re-sweep can still catch a regression,
 *      and these are the CHEAPEST targets (a findable Playbill URL
 *      resolves in ~11s, vs ~24s for a show with no Playbill page at all).
 *   4  previously 'no-playbill-url' — the show has no Playbill production
 *      page, so a recheck yields no evidence in either direction, and each
 *      one burns the full SERP fallback chain (BD SERP API 20s timeout ->
 *      BD Web Unlocker 30s timeout -> ScrapingBee) looking for a page that
 *      is not there. Lowest value per budget-second: last.
 *
 * BRO-2701: tiers 3 and 4 used to be a single tier 1 ("anything that is not
 * 'match' needs a recheck"), which put all 33 no-playbill-url shows AHEAD of
 * the 32 clean ones. At ~24s each those 33 cannot fit a 9-minute budget
 * (~13.2 min), so the deferred tail ALWAYS contained tier-<=1 shows and
 * deferredHighPriorityShows() always refused to certify — main red on every
 * push with zero real mismatches, permanently and independently of the data.
 *
 * `previousResultById` maps show id -> the `result` field from the last
 * written venue-date-mismatches.json. Absent entries (id not a key) are
 * treated as new. Stable within each bucket — does not reorder shows that
 * land in the same priority tier.
 */
/**
 * Prior results that produced no evidence because the environment, not the
 * data, was at fault. 'serp-error' is the important one: findPlaybillUrl()
 * used to collapse "every SERP query threw" into the same 'no-playbill-url'
 * it returns for "we looked and this show genuinely has no Playbill page",
 * so a provider outage during one push could permanently demote a brand-new
 * stub to the deferred, non-blocking tail (BRO-2701 review finding 1).
 */
const TRANSIENT_PRIOR_RESULTS = new Set([
  'fetch-error', 'short-response', 'infra-unavailable', 'serp-error',
  // Not strictly transient, but it belongs in the same bucket: it yields no
  // verdict and a later run plausibly resolves it (BRO-2701 review 5, finding
  // 3). SERP DID return playbill.com/production/ URLs and scorePlaybillUrl
  // rejected every one — title-slug mismatch, cross-market reject, tour/regional
  // reject. Lumping that in with 'no-playbill-url' meant a brand-new stub with
  // a wrong or typo'd title, which is one of the defects this audit exists to
  // catch, marked itself definitively "has no Playbill page" and exempted
  // itself from the gate after a single run.
  'playbill-url-rejected',
]);

/**
 * Results that answer the question this audit asks. Everything else — a fetch
 * timeout, a SERP outage, a missing browser — is the environment failing to
 * deliver an answer, not an answer.
 *
 * 'no-playbill-url' IS definitive: we reached the providers, they answered, and
 * the show has no Playbill production page. That is a real, stable fact about
 * the show, and it is why such a show can never be validated and must not hold
 * the gate red forever.
 */
const DEFINITIVE_RESULTS = new Set(['match', 'mismatch', 'no-playbill-url']);

/**
 * What this run leaves as the last thing we actually KNOW about a show.
 *
 * BRO-2701 review 4. Across four review rounds every finding traced back to one
 * error: `result` was made to answer two different questions at once. Ordering
 * asks "what should I spend the next 24 seconds on"; the deferral gate asks "is
 * there an open question about this show". A transient outcome changes the
 * first and must not change the second, and squeezing both out of one field is
 * why a fetch timeout could erase a mismatch, and why a brand-new stub checked
 * during an outage could slip out of the blocking set. So they are two fields
 * now: `result` drives ordering, `lastDefinitiveResult` drives blocking.
 *
 * Two rules:
 *  - A transient outcome never displaces what we knew. It cannot manufacture
 *    certainty, and it cannot destroy it.
 *  - 'no-playbill-url' cannot clear a recorded 'mismatch'. Losing track of the
 *    Playbill page is not evidence the venue/date defect was fixed; it just
 *    means we can no longer see it. Only a fresh 'match' or 'mismatch' — an
 *    actual look at an actual page — may supersede a mismatch.
 */
function resolveLastDefinitive(freshResult, priorRow) {
  const prior = priorRow ? priorRow.lastDefinitiveResult : undefined;
  if (!DEFINITIVE_RESULTS.has(freshResult)) return prior;
  if (freshResult === 'no-playbill-url' && prior === 'mismatch') return 'mismatch';
  return freshResult;
}

/**
 * Did a serpQuery() call actually reach a provider?
 *
 * BRO-2701 second review, finding 1: the first attempt at this guarded only
 * against a THROWN error, which made the whole 'serp-error' path dead code.
 * serpQuery() (scripts/lib/url-discovery.js) does not throw on an outage — it
 * returns null when there are no SERP keys, and _serpWithChain returns
 * `{results: null}` when every provider fails, because each provider helper
 * catches its own error and returns null. `null` and `[]` are a deliberate,
 * load-bearing distinction in that chain: null means "we never got an answer",
 * `[]` means "the provider answered, and the answer was nothing".
 *
 * Getting this wrong is not cosmetic. If Bright Data and ScrapingBee both 429
 * during one CI push, every provisional show gets stamped 'no-playbill-url',
 * the rotation step commits that ledger, and from then on all 65 shows sit in
 * tier 4 — sorted last and structurally unable to block the gate — including
 * any brand-new bad stub. That is the entire audit switched off by one outage.
 */
function serpQueryCompleted(results) {
  return results !== null && results !== undefined;
}

/**
 * What a failed Playbill-URL lookup MEANS — the single decision behind both
 * findPlaybillUrl()'s `source` and validateOne()'s `result`, so the two can
 * never drift apart (CLAUDE.md rule 15).
 *
 * BRO-2701 review finding 1: "we looked and this show has no Playbill page"
 * and "every SERP query threw, so we never looked" are completely different
 * claims, and they used to be stamped identically as 'no-playbill-url'. That
 * matters because 'no-playbill-url' is the lowest-priority, never-blocking
 * tier: a brand-new stub with a wrong venue that happened to be checked during
 * a provider outage would be demoted out of the gate permanently. A lookup
 * failure is transient (tier 2) and gets rechecked early instead.
 */
function missingUrlOutcome({ anyQueryCompleted, sawRejectedCandidates }) {
  if (!anyQueryCompleted) return { source: 'serp-error', result: 'serp-error' };
  // Playbill pages WERE returned and every one was rejected. Not evidence the
  // show has no page; usually evidence its title is wrong. Non-definitive, so a
  // show that has never had a real verdict keeps blocking the gate — while a
  // show with a prior definitive answer keeps that answer and does NOT start
  // failing the build, which is what stops this from reintroducing a permanent
  // red across the 33 legacy no-page rows (BRO-2701 review 5, finding 3).
  if (sawRejectedCandidates) return { source: 'candidates-rejected', result: 'playbill-url-rejected' };
  return { source: 'none', result: 'no-playbill-url' };
}

/**
 * Read a prior ledger entry. Accepts either shape: a bare result string (the
 * historical `id -> 'match'` map) or a `{ result, checkedAt }` row, so callers
 * that only have result strings keep working while the ones that pass full
 * rows also get intra-tier rotation.
 */
function priorRowOf(previousResultById, showId) {
  const prev = previousResultById ? previousResultById[showId] : undefined;
  if (prev === undefined || prev === null) return undefined;
  const row = typeof prev === 'string' ? { result: prev } : prev;
  return {
    result: row.result,
    checkedAt: row.checkedAt,
    // Rows written before this field existed (and the bare-string form used by
    // callers that only have results) derive it, so the whole committed ledger
    // migrates with no backfill.
    lastDefinitiveResult: row.lastDefinitiveResult !== undefined
      ? row.lastDefinitiveResult
      : (DEFINITIVE_RESULTS.has(row.result) ? row.result : undefined),
  };
}

function provisionalPriorityTier(showId, previousResultById) {
  const row = priorRowOf(previousResultById, showId);
  if (row === undefined || row.result === undefined) return 0;
  // THE INVARIANT (BRO-2701 review 5, finding 1): anything that blocks the gate
  // must be checked first. Ordering read `result` while blocking read
  // `lastDefinitiveResult`, and those two deliberately diverge — so a show
  // whose last real verdict was 'mismatch' but whose latest run returned
  // 'no-playbill-url' sorted DEAD LAST (tier 4) while still failing the build,
  // with no path to ever clearing it because only a fresh look can supersede a
  // mismatch and it was never reached. That is this card's original
  // permanent-red failure mode, rebuilt out of the fix for it.
  // Asserted exhaustively by 'INVARIANT: anything that blocks is checked first'.
  if (blocksOnDeferral(showId, previousResultById)) {
    return row.lastDefinitiveResult === undefined && row.result === undefined ? 0 : 1;
  }
  if (row.result === 'no-playbill-url') return 4;
  if (row.result === 'match') return 3;
  if (TRANSIENT_PRIOR_RESULTS.has(row.result)) return 2;
  return 1;
}

/**
 * Within a tier, check the least-recently-checked show first.
 *
 * BRO-2701 review finding 2: tier alone is not enough. A tier-4 show that gets
 * checked is re-stamped with the SAME result, so its tier never changes; with a
 * stable index tiebreak the budget reached the same first few shows on every
 * push and the rest of the tail — precisely the shows that have never once been
 * validated — were deferred forever, and the "Persist venue/date audit rotation
 * state" step had no rotation to persist. Ordering by `checkedAt` makes the
 * persisted ledger actually rotate: a checked show goes to the back of its own
 * tier next run. Rows with no `checkedAt` (written before this existed) sort
 * first, so the existing backlog drains before anything is re-swept.
 */
const NEVER_CHECKED = '';

function orderProvisionalTargets(shows, previousResultById) {
  return shows
    .map((show, index) => {
      const row = priorRowOf(previousResultById, show.id);
      return {
        show,
        index,
        tier: provisionalPriorityTier(show.id, previousResultById),
        checkedAt: (row && row.checkedAt) || NEVER_CHECKED,
      };
    })
    .sort((a, b) => (a.tier - b.tier)
      || (a.checkedAt < b.checkedAt ? -1 : a.checkedAt > b.checkedAt ? 1 : 0)
      || (a.index - b.index))
    .map((entry) => entry.show);
}

/**
 * From a budget-deferred tail (shows a --time-budget-min run never reached),
 * which ones the run cannot afford to have skipped — tier 0 (new: could be
 * the bad stub this audit exists to catch) and tier 1 (a known 'mismatch'
 * whose fix or persistence is unverified). A non-empty result means the run
 * cannot certify clean coverage of that class, however small `mismatches`
 * looks this run (BRO-2627 adversarial review).
 *
 * BRO-2701: tiers 2-4 are deliberately NOT included. Every one of them is an
 * outcome that validate-show-venue.js has already decided cannot fail the
 * step when it IS observed — `--fail-on-mismatch` gates on `mismatches` only,
 * and 'no-playbill-url' / 'fetch-error' / 'short-response' /
 * 'infra-unavailable' are explicitly excluded there (BRO-2560). An outcome
 * that cannot fail the build when seen must not fail it when unseen; the
 * previous `!== 2` made exactly that contradiction the permanent state of
 * main.
 */
/**
 * Does deferring this show leave an OPEN QUESTION about it?
 *
 * Deliberately NOT expressed in tiers (BRO-2701 review 4): tiers rank what to
 * spend the budget on, which is a different question and answering both with
 * one number is what produced this card's whole review history. A show holds
 * the gate red when, and only when:
 *
 *   - nothing has ever been recorded for it (a brand-new stub — the incident
 *     class this audit exists to catch), or
 *   - every run so far hit a transient failure, so it has never once been
 *     definitively looked at, or
 *   - the last real look found a 'mismatch' that is still unresolved.
 *
 * A previously-clean show that hits a fetch error does NOT block: we still know
 * what we knew. That is what keeps a provider outage from turning main red
 * across the whole corpus while still failing closed on the shows an outage
 * genuinely leaves unvalidated.
 */
function blocksOnDeferral(showId, previousResultById) {
  const row = priorRowOf(previousResultById, showId);
  if (row === undefined) return true;
  if (row.lastDefinitiveResult === undefined) return true;
  return row.lastDefinitiveResult === 'mismatch';
}

function deferredHighPriorityShows(deferredShows, previousResultById) {
  return deferredShows.filter((s) => blocksOnDeferral(s.id, previousResultById));
}

/**
 * Merge this run's fresh results over the prior audit report's rows for any
 * currently-provisional show this run didn't reach (deferred by budget, or
 * simply outside a --limit slice). Without this, a deferred show's last-
 * known state is dropped from the file entirely and looks "new" again next
 * run instead of retaining its real priority tier.
 *
 * `previousResultsById` maps id -> the FULL prior result row (not just
 * `.result`). `currentProvisionalIds` is a Set of ids that are still
 * provisional as of THIS run's shows.json (a show that got promoted/fixed
 * and is no longer provisional is dropped, not carried forward forever).
 */
function mergeCarriedForwardResults(freshResults, previousResultsById, currentProvisionalIds, isStillValid) {
  const freshIds = new Set(freshResults.map((r) => r.id));
  const stillValid = typeof isStillValid === 'function' ? isStillValid : () => true;
  const carriedForward = Object.values(previousResultsById || {}).filter(
    (row) => currentProvisionalIds.has(row.id) && !freshIds.has(row.id) && stillValid(row),
  );
  return [...freshResults, ...carriedForward];
}

/**
 * The shows.json fields compareShow() actually validates against Playbill. A
 * carried-forward row is only evidence about the values it was computed from,
 * so this is what decides whether that evidence is still about today's entry.
 */
function showFingerprint(show) {
  if (!show) return undefined;
  // isRevival is included because compareShow() VALIDATES it (a Playbill
  // "Revival"/"Original" tagline mismatch is a real finding). Leaving it out
  // meant flipping isRevival left the fingerprint unchanged, so a prior
  // 'match' row stayed valid evidence and the show kept its low-priority tier
  // — CI could certify a clean pass over an isRevival value nobody checked
  // (BRO-2701 review 3, finding 4). Rows written before this have a 3-part
  // fingerprint that no longer equals the 4-part one, so they are treated as
  // stale and re-checked once, which is the correct conservative direction.
  // Every field below CHANGES THE VERDICT, which is the whole test for
  // membership (BRO-2701 review 5, finding 2):
  //   venue/openingDate/closingDate — compared directly by compareShow.
  //   isRevival — compareShow checks it against Playbill's Original/Revival tag.
  //   title — decides WHICH Playbill page the verdict was even about, via the
  //     SERP queries and scorePlaybillUrl's title-slug hard filter. A title
  //     correction leaves a stale row asserting a match against a different
  //     production's page.
  //   priorRuns — findCorroboratingPriorRun moves real venue/date mismatches
  //     into explainedByPriorRun, SUPPRESSING them. Editing or deleting an
  //     entry changes the verdict without touching any compared field, so a
  //     stale 'match' would certify a suppression nobody re-verified.
  const priorRuns = Array.isArray(show.priorRuns)
    ? show.priorRuns.map((r) => [r.venue || '', r.openingDate || '', r.closingDate || ''].join('~')).join(';')
    : '';
  return [
    show.venue || '', show.openingDate || '', show.closingDate || '',
    String(!!show.isRevival), show.title || '', priorRuns,
  ].join('|');
}

/**
 * Assemble the rows to WRITE to the shared audit report — for EVERY mode.
 *
 * BRO-2696: this used to be a ternary in validate-show-venue.js that only
 * merged in --all-provisional mode; a `--show=<id>` run wrote exactly the one
 * row it checked, truncating the shared, TRACKED report to a single entry.
 * CI then loaded that one-row file as its `previousResultById`, so 64 of 65
 * provisional shows tiered as "new", the budget-deferred tail was therefore
 * also "new", and deferredHighPriorityShows() correctly refused to certify a
 * clean pass — main red, with zero actual mismatches in the data. CLAUDE.md
 * rule 3 tells operators to run the per-show command, so the foot-gun fires
 * from the documented workflow.
 *
 * The report's contract is "last-known state per still-provisional show", not
 * "what this invocation happened to look at". `currentProvisionalIds` is
 * therefore REQUIRED and a missing one throws rather than silently reverting
 * to the truncating behaviour — the failure mode was invisible precisely
 * because writing fewer rows looks like a successful write.
 */
function buildAuditResults({ freshResults, previousResultsById, currentProvisionalIds, showsById }) {
  if (!currentProvisionalIds || typeof currentProvisionalIds.has !== 'function') {
    throw new Error(
      'buildAuditResults: currentProvisionalIds (a Set) is required — a filtered '
      + '--show/--candidates-file run must still carry prior rows forward, or it '
      + 'truncates the shared audit report and breaks CI tiering (BRO-2696)',
    );
  }
  const byId = showsById || {};
  // The ledger's domain is exactly "shows that are provisional right now".
  // --candidates-file synthesises ids for shows with no shows.json entry at all
  // (discover-ob-historical.js pre-promotion); those must not land in a tracked
  // file that CI reads as its provisional coverage state.
  // `checkedAt` is what makes the persisted ledger ROTATE: orderProvisionalTargets
  // sends a just-checked show to the back of its own tier next run, so a
  // budget-capped run works through its tail instead of re-checking the same
  // head forever (BRO-2701 review finding 2).
  const checkedAt = new Date().toISOString();
  const fresh = (freshResults || [])
    .filter((r) => currentProvisionalIds.has(r.id))
    .map((r) => {
      const fingerprint = showFingerprint(byId[r.id]);
      const base = fingerprint === undefined ? { ...r, checkedAt } : { ...r, fingerprint, checkedAt };
      // Only evidence that is still ABOUT this show may carry forward. Reading
      // the raw prior row here would resurrect a mismatch recorded against a
      // venue the owner has since corrected, and stamp today's fingerprint on
      // it so it looked freshly confirmed (BRO-2701 review 4, finding 3).
      const rawPrior = (previousResultsById || {})[r.id];
      const prior = rawPrior && rowIsStillAboutShow(rawPrior, byId, r.id) ? rawPrior : undefined;
      const lastDefinitiveResult = resolveLastDefinitive(r.result, priorRowOf({ [r.id]: prior }, r.id));
      return lastDefinitiveResult === undefined ? base : { ...base, lastDefinitiveResult };
    });
  // A carried-forward row asserts "this is what we found last time we looked".
  // If the entry has been edited since, that assertion is about values that no
  // longer exist, and letting it keep its non-blocking tier (3 for previously-
  // clean, 4 for previously-no-Playbill-page) would let CI certify a clean pass
  // over a venue/date nobody ever checked. Rows written before fingerprints
  // existed have none — carry those (a stale-but-real ledger still beats
  // treating every show as new, which is the BRO-2696 red itself).
  return mergeCarriedForwardResults(
    // `row.id` is safe HERE specifically because mergeCarriedForwardResults has
    // already filtered on `currentProvisionalIds.has(row.id)`, so any row that
    // reaches this predicate provably has one. buildPriorTierMap has no such
    // pre-filter, which is why it passes its map key instead (finding 5).
    fresh, previousResultsById, currentProvisionalIds, (row) => rowIsStillAboutShow(row, byId, row.id),
  );
}

/**
 * Build the map that drives TIERING (orderProvisionalTargets /
 * deferredHighPriorityShows) from the same prior rows buildAuditResults writes,
 * applying the SAME fingerprint-staleness rule.
 *
 * BRO-2701 review finding 3: the caller used to map every prior row to its
 * `.result` unconditionally, while buildAuditResults dropped fingerprint-stale
 * rows at write time. A show whose venue had just been rewritten therefore kept
 * its old non-blocking tier for the tiering decision, got deferred, did not
 * block the gate, and was only caught on the NEXT run — one run late, in the
 * exact "a bad venue edit landed" case this audit exists to catch. Dropping the
 * row here instead makes such a show tier 0 (new), so it sorts first and its
 * deferral still fails closed.
 */
function buildPriorTierMap({ previousResultsById, showsById }) {
  const byId = showsById || {};
  const out = {};
  for (const [id, row] of Object.entries(previousResultsById || {})) {
    if (!rowIsStillAboutShow(row, byId, id)) continue;
    const normalized = priorRowOf({ [id]: row }, id);
    out[id] = {
      result: row.result,
      checkedAt: row.checkedAt,
      lastDefinitiveResult: normalized.lastDefinitiveResult,
    };
  }
  return out;
}

/**
 * `showId` is passed explicitly rather than read from `row.id` (BRO-2701
 * second review, finding 3): buildPriorTierMap iterates by MAP KEY, and a row
 * whose body happens to lack an `id` would look up `byId[undefined]`, get
 * undefined, and be declared "still valid" — silently skipping the very
 * staleness check this function exists to enforce. The key is already in hand
 * at both call sites, so trust it instead of the row body.
 */
function rowIsStillAboutShow(row, byId, showId) {
  const now = showFingerprint(byId[showId !== undefined ? showId : row.id]);
  if (row.fingerprint === undefined || now === undefined) return true;
  return row.fingerprint === now;
}

module.exports = {
  DATE_DELTA_DAYS,
  daysBetween,
  urlYear,
  findCorroboratingPriorRun,
  compareShow,
  orderProvisionalTargets,
  provisionalPriorityTier,
  deferredHighPriorityShows,
  mergeCarriedForwardResults,
  buildAuditResults,
  buildPriorTierMap,
  missingUrlOutcome,
  serpQueryCompleted,
  resolveLastDefinitive,
  blocksOnDeferral,
  DEFINITIVE_RESULTS,
  TRANSIENT_PRIOR_RESULTS,
  showFingerprint,
};
