#!/usr/bin/env node
/**
 * Opening-Night Coverage Audit
 *
 * Checks recently-opened shows for missing T1/T2 reviews and optionally
 * sends Discord alerts + dispatches targeted collection workflows.
 *
 * Usage:
 *   node scripts/audit-opening-night-coverage.js                    # check last 3 days
 *   node scripts/audit-opening-night-coverage.js --days=7           # check last 7 days
 *   node scripts/audit-opening-night-coverage.js --show=SHOW_ID     # check specific show
 *   node scripts/audit-opening-night-coverage.js --dispatch         # auto-dispatch collection for gaps
 *   node scripts/audit-opening-night-coverage.js --alert            # send Discord alerts for gaps
 */

const fs = require('fs');
const path = require('path');
const { isLondonMarket } = require('./lib/venue-classification');
const { buildCensusFromArchives, censusVerdict, CI_UNFETCHABLE_OUTLETS } = require('./lib/review-census');
const { classifyCell, mergeLedger, serializeLedger, isDispatchTierOutlet } = require('./lib/t1-ledger');
const { buildDigest } = require('./lib/t1-digest');
const { isNoReviewExpectedActive, detectReactivation } = require('./lib/coverage-expectation');
const { detectLateAdd, GRACE_DAYS: LATE_ADD_GRACE_DAYS } = require('./lib/late-add-detector');
const { routeAlert } = require('./lib/owner-alert-router');
const { capNewStandingCells, DEFAULT_MAX_NEW_PER_RUN } = require('./lib/standing-outlets');

const DATA_DIR = path.join(__dirname, '..', 'data');
const LEDGER_PATH = path.join(DATA_DIR, 'audit', 't1-coverage-ledger.json');
const DIGEST_STATE_PATH = path.join(DATA_DIR, 'audit', 't1-coverage-digest-state.json');
// S4-T3/S5-T1 signals (reactivations, late-adds): sendAlert() at 'warning'
// severity is log-only by design in this codebase (discord-notify.js — no
// Discord webhook, no email at non-critical severity), so without a durable
// file these findings existed only in a transient GitHub Actions run log
// (ship-check finding, 2026-07-23). Every hourly --write-ledger run
// overwrites this with the CURRENT findings — it's a snapshot, not a log.
const SIGNALS_PATH = path.join(DATA_DIR, 'audit', 't1-coverage-signals.json');

// Expected-outlet authority: the multi-source aggregator CENSUS (review-census.js),
// not a hardcoded list. Every market — Broadway, Off-Broadway, West End — now flows
// through buildCensusFromArchives + censusVerdict. The old per-market hardcoded
// expected-outlet arrays (and the census-vs-legacy precedence ladder) were retired
// in S2-T2: they went stale, under-counted the long tail the roundups actually
// list, and disagreed with the WE census. The roundups ARE the expected list.

// Census sources that scrape review-link URLs rather than a critic-listing roundup.
// They frequently point at a DIFFERENT production's article (a pre-Broadway tryout's
// local critics), so an outlet named ONLY by these is treated as soft-missing:
// visible + blocks `complete`, but alert-only, never dispatchable (no gather storm).
const SUPPLEMENTARY_CENSUS_SOURCES = new Set(['playbill-verdict', 'show-score']);

// Opening-night floor: silent-failure detection for Broadway shows.
// FA (2026-04-19) landed 14/17 reviews because the BWW extractor silently
// dropped 3 outlets. The outlet-gap check didn't flag it because the missing
// outlets weren't all in core T1. A total-count floor catches this class.
// Window: 36-72h post-open. 36h lower bound chosen because late-drop T1s
// (WSJ, Observer) routinely publish 24-36h after opening; a 24h floor
// would false-alarm while the opening-night-poller is still ingesting.
// OB shows are exempt (floor constants are null for that market).
const BROADWAY_FLOOR_REVIEWS = 10;   // critic files captured
const BROADWAY_FLOOR_SCORED = 5;     // scored reviews
const WE_FLOOR_REVIEWS = 6;
const WE_FLOOR_SCORED = 3;
const FLOOR_WINDOW_MIN_HOURS = 36;
const FLOOR_WINDOW_MAX_HOURS = 72;

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { days: 3, dispatch: false, alert: false, showId: null,
    writeLedger: false, ledgerPath: LEDGER_PATH, ledgerDays: 90 };
  for (const arg of args) {
    if (arg.startsWith('--days=')) opts.days = parseInt(arg.split('=')[1], 10);
    if (arg.startsWith('--show=')) opts.showId = arg.split('=')[1];
    if (arg === '--dispatch') opts.dispatch = true;
    if (arg === '--alert') opts.alert = true;
    // Ledger mode (S2-T3): rebuild data/audit/t1-coverage-ledger.json. Single
    // writer = audit-aggregator-gap.yml; commit-on-change (deterministic bytes).
    if (arg === '--write-ledger') opts.writeLedger = true;
    if (arg.startsWith('--ledger-path=')) opts.ledgerPath = arg.split('=')[1];
    if (arg.startsWith('--ledger-days=')) opts.ledgerDays = parseInt(arg.split('=')[1], 10);
    // B1 fan-out cap override (default lib/standing-outlets.js DEFAULT_MAX_NEW_PER_RUN).
    if (arg.startsWith('--standing-cap=')) opts.standingCap = parseInt(arg.split('=')[1], 10);
    // Digest mode (S2-T7): read the ledger, list GAP cells, ACTION-email only NEW
    // >24h gaps. Without --alert it is a pure dry-run (prints, emails nothing).
    if (arg === '--digest') opts.digest = true;
    if (arg.startsWith('--digest-state=')) opts.digestStatePath = arg.split('=')[1];
  }
  opts.digestStatePath = opts.digestStatePath || DIGEST_STATE_PATH;
  return opts;
}

// Census market key for a category (which roundup set to read).
// (kept adjacent to parseArgs so both entrypoints can use it)


function loadJSON(filename) {
  const filepath = path.join(DATA_DIR, filename);
  if (!fs.existsSync(filepath)) {
    console.error(`Missing data file: ${filepath}`);
    console.error('Run: npm run data:check');
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(filepath, 'utf8'));
}

// Map a show category to the census market key (which roundup set to read).
function censusMarket(category) {
  if (isLondonMarket(category)) return 'west-end';
  if (category === 'off-broadway') return 'off-broadway';
  return 'broadway';
}

// Registry evidence that an outlet does not review this market → NO_REVIEW_EXPECTED.
// S4-T3: decay-aware — delegates to coverage-expectation.js so a determination
// older than 14 days (or missing its coverageExpectationDecidedAt evidence
// timestamp) stops suppressing and the cell falls back to normal GAP evaluation.
function outletNoReviewExpected(outlets, outletId, nowMs) {
  return isNoReviewExpectedActive(outlets, outletId, nowMs);
}

// Compute the ledger cells (missing/suppressed T1 outlets) for one show. Reuses the
// exact census + verdict the console audit uses. Soft-missing (supplementary-source-
// only, e.g. tryout-city critics) are EXCLUDED — they are alert-only noise, not real
// T1 retrieval gaps, so they must not pollute the SLA burn-down.
//
// Also returns `reactivations` (S4-T3): outlets with a SCORED review this run whose
// registry entry statically claims they don't review theatre — always surfaced,
// decayed or not, since a real review directly contradicts the determination.
//
// `standingCtx` (B1, optional): { existingCellKeys: Set<"showId::outletId">, counter: {used,cap} }.
// When passed, buildCensusFromArchives also unions in the standingOutlets pseudo-source
// (outlets/market both flow through opts) and any resulting cell whose census source
// is standing-outlets-only is subject to the fan-out cap — see lib/standing-outlets.js.
// Omitted entirely (undefined) → identical behavior to before B1 (no pseudo-source,
// no cap), which is how the non-ledger console audit path still calls this indirectly
// via its own separate computation (unaffected — it doesn't call computeShowCells).
function computeShowCells(show, reviews, outlets, nowMs, standingCtx) {
  const showId = show.id || show.slug;
  const category = show.category || 'broadway';
  const scoredOutlets = new Set(
    reviews.filter(r => r.showId === showId && r.assignedScore != null).map(r => r.outletId).filter(Boolean)
  );
  const reactivations = detectReactivation(outlets, scoredOutlets);
  const market = censusMarket(category);
  let census = null;
  try {
    census = buildCensusFromArchives(showId, standingCtx ? { show, market, outlets } : { show, market });
  }
  catch (_) { return { cells: [], reactivations }; }
  if (!census || !census.hadAnySource) return { cells: [], reactivations };
  const cVerdict = censusVerdict(census, scoredOutlets, { suppressed: CI_UNFETCHABLE_OUTLETS });

  // Clock start: max(openingDate, showCreatedAt) is the S2-T6 refinement; here we
  // use openingDate/previewsStartDate. No date → null clock → IN_FLIGHT (never a GAP).
  const clockStr = show.openingDate || show.previewsStartDate || null;
  const clockMs = clockStr ? Date.parse(clockStr + 'T23:00:00-04:00') : NaN;
  const clockAgeHours = Number.isFinite(clockMs) ? (nowMs - clockMs) / 3600000 : null;

  const cells = [];
  for (const m of cVerdict.missing) {
    const srcs = m.sources || [];
    if (srcs.length > 0 && srcs.every((s) => SUPPLEMENTARY_CENSUS_SOURCES.has(s))) continue; // soft — skip
    // T1 ledger means T1/T2: a roundup-named T3 blog (or unregistered junk id)
    // is not a retrieval SLA cell — same scoping as the audit's dispatch triggers.
    if (!isDispatchTierOutlet(outlets, m.outletId)) continue;
    // B1 fan-out cap: a cell discovered ONLY via the standingOutlets pseudo-source
    // (no archive names it) is exactly the new-discovery class that can burst
    // across many shows in one registry edit — throttle new ones, never ones
    // already tracked in the prior ledger. See lib/standing-outlets.js.
    if (standingCtx && srcs.includes('standing-outlets')) {
      const allowed = capNewStandingCells(standingCtx.existingCellKeys, standingCtx.counter, showId, [m.outletId]);
      if (allowed.length === 0) continue; // deferred to a later cycle
    }
    const state = classifyCell({
      noReviewExpected: outletNoReviewExpected(outlets, m.outletId, nowMs),
      suppressed: false,
      clockAgeHours,
    });
    cells.push({ outletId: m.outletId, state, url: m.url || '' });
  }
  for (const m of cVerdict.suppressedMissing) {
    cells.push({ outletId: m.outletId, state: 'SUPPRESSED', url: m.url || '' });
  }
  return { cells, reactivations };
}

// Build + write the T1 coverage ledger. Scans shows that are open OR opened within
// the window; merges with the prior ledger (preserving each gap's firstSeenAt) and
// writes deterministic bytes so an unchanged corpus produces NO file diff.
function writeLedger(opts, shows, reviews, outlets, nowIso, nowMs) {
  const cutoff = new Date(nowMs - opts.ledgerDays * 86400000).toISOString().split('T')[0];
  // Evidence-anchored arm (v2 reconciler plan, Sprint A): a show with fresh
  // review-evidence — a roundup naming it published recently — belongs in the
  // ledger even when its status is stuck in previews/announced or its
  // openingDate is null (the Broad Strokes class: this audit shared the
  // selector's blind spot, so the safety net missed exactly what the primary
  // missed). Same canonical predicate the selector uses.
  const { loadReviewEvidence, hasFreshEvidence } = require('./lib/review-evidence.js');
  const evidence = loadReviewEvidence();
  const target = shows.filter(s => s.status === 'open'
    || (s.openingDate && s.openingDate >= cutoff)
    || (s.status !== 'closed' && hasFreshEvidence(evidence, s.id || s.slug, { now: new Date(nowMs), lookbackDays: opts.ledgerDays })));
  const freshShows = [];
  const reactivations = []; // S4-T3: { showId, title, outletId }
  const lateAdds = []; // S5-T1: { showId, title, ...detectLateAdd() }

  // B1 fan-out cap setup — loaded BEFORE the per-show loop (not after, like the
  // mergeLedger `prev` read below) so computeShowCells can tell "already tracked"
  // cells apart from genuinely new standing-outlet discovery this run.
  let prev = {};
  try { prev = JSON.parse(fs.readFileSync(opts.ledgerPath, 'utf8')); } catch (_) { prev = {}; }
  const existingCellKeys = new Set();
  for (const showId of Object.keys(prev.shows || {})) {
    for (const outletId of Object.keys((prev.shows[showId] || {}).cells || {})) {
      existingCellKeys.add(`${showId}::${outletId}`);
    }
  }
  const standingCtx = {
    existingCellKeys,
    counter: { used: 0, cap: opts.standingCap != null ? opts.standingCap : DEFAULT_MAX_NEW_PER_RUN },
  };

  for (const show of target) {
    const showId = show.id || show.slug;
    const { cells, reactivations: showReactivations } = computeShowCells(show, reviews, outlets, nowMs, standingCtx);
    for (const outletId of showReactivations) {
      reactivations.push({ showId, title: show.title, outletId });
    }

    // S5-T1: late-add defect — earliest scored review predates our own
    // previews/opening clock by more than a normal preview window (the
    // dad-dont-read-this class: we catalog a transfer's dates, but critics
    // reviewed the earlier run over a month before). Measured across ALL
    // reviews for the show (any outlet/tier), not just census-missing cells.
    //
    // NOTE the precedence is deliberately REVERSED from computeShowCells'
    // GAP-clock above (`openingDate || previewsStartDate`, S2-T6) — these are
    // two different clocks answering two different questions, not one clock
    // duplicated with a bug. The GAP clock asks "how long has retrieval had
    // to work" and defaults to the later, more conservative date so it never
    // starts the SLA before a T1 review could plausibly exist. This clock
    // asks "what's the earliest date a review would NOT be suspicious" and
    // needs the earlier, more generous date — previews start weeks before
    // opening and legitimately draw reviews, so anchoring on openingDate here
    // would flag every ordinary early-preview review as a false late-add.
    // (ship-check finding, 2026-07-23 — do not "fix" this into matching the
    // other clock without re-deriving both from first principles.)
    const showReviews = reviews.filter((r) => r.showId === showId);
    const catalogClock = show.previewsStartDate || show.openingDate || null;
    const lateAdd = detectLateAdd(showReviews, catalogClock);
    if (lateAdd.isLateAdd) lateAdds.push({ showId, title: show.title, ...lateAdd });

    if (cells.length === 0) continue;
    freshShows.push({
      showId,
      title: show.title,
      market: censusMarket(show.category || 'broadway'),
      openingDate: show.openingDate || null,
      cells,
    });
  }
  const ledger = mergeLedger(prev, freshShows, nowIso);
  const bytes = serializeLedger(ledger);
  const before = fs.existsSync(opts.ledgerPath) ? fs.readFileSync(opts.ledgerPath, 'utf8') : '';
  const changed = before !== bytes;
  if (changed) {
    fs.mkdirSync(path.dirname(opts.ledgerPath), { recursive: true });
    fs.writeFileSync(opts.ledgerPath, bytes);
  }
  const cellCount = freshShows.reduce((n, s) => n + s.cells.length, 0);
  const gapCount = freshShows.reduce((n, s) => n + s.cells.filter(c => c.state === 'GAP').length, 0);
  console.log(`T1 coverage ledger: ${freshShows.length} shows, ${cellCount} open cells (${gapCount} GAP) → ${opts.ledgerPath} ${changed ? '[written]' : '[unchanged — no commit]'}`);
  if (standingCtx.counter.used > 0) {
    console.log(`  standing-outlets: ${standingCtx.counter.used}/${standingCtx.counter.cap} new cell(s) this run (fan-out cap)`);
  }
  if (reactivations.length) {
    console.log(`\n⚠️  Reactivation: ${reactivations.length} scored review(s) from a registry "no review expected" outlet:`);
    for (const r of reactivations) console.log(`  ${r.showId} / ${r.outletId} — update outlet-registry.json coverageExpectation`);
  }
  if (lateAdds.length) {
    console.log(`\n⚠️  Late-add defect: ${lateAdds.length} show(s) whose earliest scored review predates our catalog clock by >${LATE_ADD_GRACE_DAYS}d:`);
    for (const r of lateAdds) {
      console.log(`  ${r.showId} — earliest ${r.earliestOutletId} review ${r.earliestReviewDate}, catalog clock ${r.catalogClock} (${r.gapDays}d early). Check for a missing priorRuns entry or wrong openingDate.`);
    }
  }
  // Persist reactivations + lateAdds as a snapshot (not a log) — sendAlert() at
  // 'warning' severity is log-only in this codebase (no Discord webhook, no
  // email below 'critical'), so without this file these findings only ever
  // existed in a transient GitHub Actions run log that nobody reads on a
  // healthy hourly cron (ship-check finding, 2026-07-23).
  try {
    fs.mkdirSync(path.dirname(SIGNALS_PATH), { recursive: true });
    fs.writeFileSync(SIGNALS_PATH, JSON.stringify({ generatedAt: nowIso, reactivations, lateAdds }, null, 2));
  } catch (e) { console.error('Failed to write t1-coverage-signals.json:', e.message); }
  return { changed, shows: freshShows.length, cells: cellCount, gaps: gapCount, reactivations, lateAdds };
}

// Run the daily digest over the ledger. Prints the full GAP burn-down; with --alert,
// fires ACTION emails ONLY for NEW (post-rollout) gaps that crossed 24h, deduped via
// the digest-state file. Pre-rollout backlog is digest-only forever (storm guard).
async function runDigest(opts) {
  let ledger = { shows: {} };
  try { ledger = JSON.parse(fs.readFileSync(opts.ledgerPath, 'utf8')); }
  catch (_) { console.log('No ledger yet — run --write-ledger first.'); return; }
  let state = {};
  try { state = JSON.parse(fs.readFileSync(opts.digestStatePath, 'utf8')); } catch (_) { state = {}; }

  const now = new Date();
  const { rolloutAt, digest, actions, preRolloutCount } = buildDigest(ledger, state, now.getTime());

  console.log(`\n=== T1 Coverage Digest (rollout ${rolloutAt}) ===`);
  console.log(`GAP cells: ${digest.length} (${preRolloutCount} pre-rollout burn-down, ${digest.length - preRolloutCount} post-rollout)`);
  console.log(`NEW gaps crossing 24h → ACTION: ${actions.length}${opts.alert ? '' : ' (dry-run — no email)'}`);
  for (const r of digest.slice(0, 60)) {
    console.log(`  ${r.preRollout ? '·' : (r.ageHours >= 24 ? '‼' : '⧗')} ${r.showId} / ${r.outletId}  (${r.ageHours}h)  ${r.preRollout ? '[pre-rollout]' : ''}`);
  }
  if (digest.length > 60) console.log(`  … ${digest.length - 60} more`);

  // At most 10 gaps per email; the rest stay un-alerted (NOT deduped) so they
  // surface on the next run instead of being silently marked-seen (S2 fixup).
  const emailed = actions.slice(0, 10);
  let delivered = false;
  if (opts.alert && actions.length) {
    try {
      // Routed through owner-alert-router (not raw sendAlert) with a STATIC
      // conditionKey + 24h cooldown — card #608 (2026-07-28): this alert fired
      // 4x in ~25h because the per-cell alertedCells dedup below only silences
      // a cell ONCE IT'S BEEN IN A DELIVERED EMAIL, but every hourly run that
      // finds even one freshly-24h-old cell fired a brand new "new gaps" email
      // immediately — there was no cooldown on the ALERT itself, only on
      // individual cells. Batching behavior is preserved: routeAlert's 'silent'
      // branch below still leaves `delivered=false`, so cells stay un-marked in
      // alertedCells and accumulate into one batch the next time the cooldown
      // clears (see the two-guard rationale in the block below this one).
      const routed = await routeAlert({
        conditionKey: 't1-coverage:new-gaps-24h',
        title: 'T1 Coverage — new gaps past 24h',
        description: `${actions.length} T1/T2 outlet(s) still missing >24h after they became measurable${actions.length > emailed.length ? ` (first ${emailed.length} below; the rest escalate next run)` : ''}.`,
        severity: 'error',
        disposition: 'human',
        cooldownHours: 24,
        fields: emailed.map(r => ({ name: `${r.title} — ${r.outletId} (${r.ageHours}h)`, value: r.fix })),
      });
      delivered = routed.action !== 'silent' && routed.delivered !== false;
      console.log(delivered
        ? `\nSent ACTION alert for ${emailed.length}/${actions.length} new gap(s).`
        : routed.action === 'silent'
          ? `\nACTION alert suppressed by 24h cooldown (condition still open) — gaps stay un-deduped and accumulate for the next real send.`
          : `\nACTION alert NOT delivered — gaps stay un-deduped and retry next run.`);
    } catch (e) { console.error('Digest alert failed:', e.message); }
  }
  // No resolveCondition() call when actions.length === 0: unlike a monotonic
  // health check, "zero NEW actionable gaps this hour" does NOT mean the
  // incident is over — audit-aggregator-gap.yml runs hourly, but a cell only
  // becomes "actionable" at the exact hour it crosses the 24h grace period, so
  // most hourly ticks see actions.length===0 between events even while older
  // gaps sit un-alerted (ship-check finding, 2026-07-28: an earlier version of
  // this fix called resolveCondition() here, which reset routeAlert's 24h
  // cooldown on every quiet hour — so a DIFFERENT gap crossing 24h just 1-2
  // hours after a real send would page immediately instead of waiting out the
  // cooldown, reproducing the exact "4 emails in 25h" bug this card fixes).
  // The cooldown already expires naturally 24h after lastNotifiedAt — no
  // early-resolve signal is needed or safe here.

  // Persist state ONLY on a real (non-dry-run) alert pass: stamp rolloutAt once and
  // record alerted cells so they dedupe next run. Two guards (review 2026-07-23):
  // only cells actually IN the delivered email are marked (delivery failure or the
  // 10-cap must not dedupe an alert nobody saw), and keys are pruned to cells still
  // present in the ledger so the state file can't grow unboundedly.
  if (opts.alert) {
    const liveKeys = new Set();
    for (const showId of Object.keys(ledger.shows || {})) {
      for (const outletId of Object.keys((ledger.shows[showId] || {}).cells || {})) {
        liveKeys.add(`${showId}::${outletId}`);
      }
    }
    const alertedCells = new Set((state.alertedCells || []).filter(k => liveKeys.has(k)));
    if (delivered) for (const r of emailed) alertedCells.add(`${r.showId}::${r.outletId}`);
    const next = { rolloutAt, alertedCells: [...alertedCells].sort() };
    fs.mkdirSync(path.dirname(opts.digestStatePath), { recursive: true });
    fs.writeFileSync(opts.digestStatePath, JSON.stringify(next, null, 2) + '\n');
  } else if (!state.rolloutAt) {
    // First-ever contact is usually a dry-run; seed rolloutAt so the current backlog
    // is correctly classified pre-rollout on the first REAL alert pass too.
    console.log(`(note: rolloutAt not yet persisted — the first --alert run stamps it to now, freezing the current backlog as pre-rollout)`);
  }
}

async function main() {
  const opts = parseArgs();

  if (opts.digest) { await runDigest(opts); return; }

  if (opts.writeLedger) {
    const showsData = loadJSON('shows.json');
    const shows = showsData.shows || showsData;
    const reviewsData = loadJSON('reviews.json');
    const reviews = reviewsData.reviews || reviewsData;
    const outletRegistry = loadJSON('outlet-registry.json');
    const outlets = outletRegistry.outlets || outletRegistry;
    const now = new Date();
    const result = writeLedger(opts, shows, reviews, outlets, now.toISOString(), now.getTime());
    if (opts.alert && result.reactivations.length) {
      try {
        const { sendAlert } = require('./lib/discord-notify');
        await sendAlert({
          title: 'T1 Coverage — outlet reactivation',
          description: `${result.reactivations.length} scored review(s) landed from an outlet the registry marks as not reviewing theatre.`,
          severity: 'warning',
          fields: result.reactivations.slice(0, 10).map(r => ({
            name: `${r.title} — ${r.outletId}`,
            value: 'Update outlet-registry.json coverageExpectation/reviewsTheater',
          })),
        });
        console.log(`\nSent reactivation alert for ${result.reactivations.length} outlet(s).`);
      } catch (e) { console.error('Reactivation alert failed:', e.message); }
    }
    return;
  }


  // Load data
  const showsData = loadJSON('shows.json');
  const shows = showsData.shows || showsData;
  const reviewsData = loadJSON('reviews.json');
  const reviews = reviewsData.reviews || reviewsData;
  const outletRegistry = loadJSON('outlet-registry.json');
  const outlets = outletRegistry.outlets || outletRegistry;

  // Find recently-opened shows
  const now = new Date();
  const cutoff = new Date(now);
  cutoff.setDate(cutoff.getDate() - opts.days);
  const cutoffStr = cutoff.toISOString().split('T')[0];

  let targetShows;
  if (opts.showId) {
    targetShows = shows.filter(s => s.id === opts.showId || s.slug === opts.showId);
    if (targetShows.length === 0) {
      console.error(`Show not found: ${opts.showId}`);
      process.exit(1);
    }
  } else {
    targetShows = shows.filter(s => {
      if (s.status !== 'open') return false;
      if (!s.openingDate) return false;
      return s.openingDate >= cutoffStr;
    });
  }

  if (targetShows.length === 0) {
    console.log(`No shows opened in the last ${opts.days} days.`);
    return;
  }

  console.log(`\n=== Opening-Night Coverage Audit ===`);
  console.log(`Checking ${targetShows.length} show(s) opened since ${cutoffStr}\n`);

  const gaps = [];
  const floorBreaches = [];

  for (const show of targetShows) {
    const showId = show.id || show.slug;
    const category = show.category || 'broadway';
    const showReviews = reviews.filter(r => r.showId === showId);
    const scoredReviews = showReviews.filter(r => r.assignedScore != null);

    // Get outlets that have reviews
    const coveredOutlets = new Set(showReviews.map(r => r.outletId).filter(Boolean));
    // Census completeness keys off SCORED outlets only — a discovered-but-unscored
    // review (assignedScore == null) is NOT live, so it must count as missing (the
    // MJ / All My Sons class). See cloud-memory postmortem 2026-06.
    const coveredScoredOutlets = new Set(scoredReviews.map(r => r.outletId).filter(Boolean));

    // Get outlet display names
    const getName = (id) => outlets[id]?.displayName || id;

    // Floor check — silent-failure detection (catches broken extractors when
    // no specific outlet gap stands out). Only runs in 36-72h post-open window.
    // `-04:00` is EDT (summer Broadway openings). hoursSinceOpen reported in
    // Discord may be off ±1h in winter; the 36h floor gives enough slack.
    const openingMs = show.openingDate ? Date.parse(show.openingDate + 'T23:00:00-04:00') : null;
    if (show.openingDate && !Number.isFinite(openingMs)) {
      console.warn(`  ⚠ Unparseable openingDate for ${showId}: "${show.openingDate}" — floor check skipped`);
    }
    const hoursSinceOpen = Number.isFinite(openingMs) ? (now - openingMs) / (1000 * 60 * 60) : null;
    const inFloorWindow = hoursSinceOpen != null
      && hoursSinceOpen >= FLOOR_WINDOW_MIN_HOURS
      && hoursSinceOpen <= FLOOR_WINDOW_MAX_HOURS;
    // Positive-match by market so regional/off-off/typos don't silently
    // inherit the Broadway floor (10 reviews) and false-breach.
    const isBroadway = category === 'broadway';
    const floorReviews = isBroadway ? BROADWAY_FLOOR_REVIEWS : (isLondonMarket(category) ? WE_FLOOR_REVIEWS : null);
    const floorScored = isBroadway ? BROADWAY_FLOOR_SCORED : (isLondonMarket(category) ? WE_FLOOR_SCORED : null);
    const belowReviewFloor = floorReviews != null && showReviews.length < floorReviews;
    const belowScoredFloor = floorScored != null && scoredReviews.length < floorScored;
    const floorBreached = inFloorWindow && (belowReviewFloor || belowScoredFloor);

    console.log(`${show.title} (${showId})`);
    console.log(`  Category: ${category} | Opened: ${show.openingDate}`);
    console.log(`  Reviews: ${showReviews.length} total, ${scoredReviews.length} scored`);
    console.log(`  Covered outlets: ${[...coveredOutlets].sort().join(', ')}`);

    if (floorBreached) {
      console.log(`  🚨 FLOOR BREACH: ${showReviews.length}/${floorReviews} reviews, ${scoredReviews.length}/${floorScored} scored at ${Math.round(hoursSinceOpen)}h post-open`);
    }

    // === Census-anchored completeness (multi-source roundup union) — SOLE authority ===
    // The roundups list EVERY critic; the census is the honest target. Every market
    // (Broadway / Off-Broadway / West End) flows through it. Three states:
    // complete / incomplete(list missing) / no-census-yet (no roundup published —
    // never falsely green). Census-missing outlets become real gaps.
    let census = null, cVerdict = null;
    const censusMissing = [];       // HARD: named by an authoritative roundup — dispatchable
    const censusMissingSoft = [];   // SOFT: only supplementary URL-sources — alert-only
    const censusSuppressed = [];
    let censusExtractorBroken = false;
    {
      try { census = buildCensusFromArchives(showId, { show, market: censusMarket(category) }); } catch (e) { console.warn(`  ⚠ census build failed for ${showId}: ${e.message}`); }
      if (census) {
        // Pass the CI-unfetchable block list so paywalled-from-CI outlets (WSJ /
        // New Yorker) stay visible + block `complete` but don't drive endless
        // re-dispatch of a gather that can never satisfy them.
        cVerdict = censusVerdict(census, coveredScoredOutlets, { suppressed: CI_UNFETCHABLE_OUTLETS });
        for (const m of cVerdict.missing) {
          // Soft-missing: the outlet is named ONLY by supplementary URL-scraped
          // sources (Playbill Verdict / Show Score), never by an authoritative
          // critic-listing roundup (BWW / DTLI / theatre.reviews / WET / The Stage).
          // These URL-sources routinely cite a DIFFERENT production's roundup — a
          // pre-Broadway tryout's local critics (Beaches → Chicago Tribune / Sun-Times).
          // Keeping them dispatchable would re-fire a FULL gather every run for a
          // gap a NYC gather can never close (dispatch storm). So: visible + blocks
          // `complete`, but alert-only, not dispatchable, not major-severity.
          const srcs = m.sources || [];
          const isSoft = srcs.length > 0 && srcs.every((s) => SUPPLEMENTARY_CENSUS_SOURCES.has(s));
          const bucket = isSoft ? censusMissingSoft : censusMissing;
          if (!bucket.includes(m.outletId)) bucket.push(m.outletId);
        }
        for (const m of cVerdict.suppressedMissing) {
          if (!censusSuppressed.includes(m.outletId)) censusSuppressed.push(m.outletId);
        }
        // An archive present but extracting 0 reviews = a silently-broken parser
        // masquerading as no-census-yet. Surface it — the monitor must catch its
        // own blindness, not go quiet exactly when coverage is unverifiable.
        if (census.zeroExtract && census.zeroExtract.length) {
          censusExtractorBroken = true;
          console.log(`  🚨 CENSUS EXTRACTOR BROKEN: archive present but 0 reviews extracted from [${census.zeroExtract.join(', ')}] — parser likely broke (DOM drift).`);
        }
        // Parser worked but every entry was a DIFFERENT show → the archived roundup is
        // the wrong show's (mis-saved combined roundup). Alert so it gets re-fetched;
        // reuse the same flag so it's surfaced + never silently no-census-yet.
        if (census.wrongRoundup && census.wrongRoundup.length) {
          censusExtractorBroken = true;
          console.log(`  🚨 WRONG-SHOW ROUNDUP: [${census.wrongRoundup.join(', ')}] archive is for a different show (combined roundup) — re-fetch this show's roundup.`);
        }
        if (census.hadAnySource) {
          console.log(`  Census (${census.sourcesPresent.join('+')}): ${census.count} outlets; verdict=${cVerdict.verdict}`);
          if (censusMissing.length) {
            const hard = cVerdict.missing.filter(m => censusMissing.includes(m.outletId));
            const hardT12 = hard.filter(m => isDispatchTierOutlet(outlets, m.outletId));
            const hardT3 = hard.filter(m => !isDispatchTierOutlet(outlets, m.outletId));
            if (hardT12.length) {
              console.log(`  CENSUS-MISSING T1/T2 (${hardT12.length}, dispatch-driving): ${hardT12.map(m => `${m.outletId}${m.url ? ' '+m.url : ''}`).join(' | ')}`);
            }
            if (hardT3.length) {
              console.log(`  CENSUS-MISSING T3+/unregistered (${hardT3.length}, informational only): ${hardT3.map(m => m.outletId).join(', ')}`);
            }
          }
          if (censusMissingSoft.length) {
            console.log(`  CENSUS-MISSING (soft, supplementary-source only, alert-only): ${censusMissingSoft.join(', ')}`);
          }
          if (cVerdict.suppressedMissing.length) {
            console.log(`  CENSUS-BLOCKED (unfetchable from CI, alert-only): ${censusSuppressed.join(', ')}`);
          }
        } else {
          console.log(`  Census: no roundup published yet → no-census-yet (holding at floor check)`);
        }
      }
    }

    // Status — census verdict is the sole authority. No census published yet means
    // the floor is met but the long tail is unverified (never falsely "complete").
    if (floorBreached) {
      console.log(`  Status: FLOOR BREACH (silent extractor failure likely)`);
    } else if (cVerdict && census.hadAnySource) {
      console.log(`  Status: ${cVerdict.verdict.toUpperCase().replace(/-/g, ' ')}`);
    } else {
      console.log(`  Status: NO CENSUS YET (no roundup published — long tail unverified)`);
    }
    console.log('');

    if (floorBreached) {
      floorBreaches.push({
        showId,
        title: show.title,
        category,
        openingDate: show.openingDate,
        hoursSinceOpen: Math.round(hoursSinceOpen),
        reviewCount: showReviews.length,
        scoredCount: scoredReviews.length,
        reviewFloor: floorReviews,
        scoredFloor: floorScored,
        belowReviewFloor,
        belowScoredFloor,
      });
    }

    // A census-incomplete show is a gap even if the review-count floor is met (the
    // whole point: the floor missed the long tail the census enumerates).
    const censusIncomplete = !!(cVerdict && census && census.hadAnySource && cVerdict.verdict === 'incomplete');
    // Tier scoping (mirrors the ledger's census∩T1/T2): only registered T1/T2
    // outlets drive dispatch and major severity. A roundup naming 3+ unscored
    // T3 blogs (or unregistered junk ids) is honest census data but a FULL
    // gather re-fired for it every run is the dispatch storm — the T3 long
    // tail stays visible in censusMissing, it just doesn't ACT.
    const censusMissingT12 = censusMissing.filter(id => isDispatchTierOutlet(outlets, id));
    // Dispatchable = there is something we can actually go fetch (NON-suppressed,
    // dispatch-tier census-missing). A show that's incomplete ONLY because of
    // suppressed/unfetchable outlets, T3+ blogs, or whose extractor broke, is
    // still alert-worthy but must NOT re-fire a gather that can't change the outcome.
    const dispatchable = censusMissingT12.length > 0;
    // Only surface a gap when there's a HARD (roundup-named) census-missing outlet
    // or a broken extractor. A show whose only census-missing outlets are soft
    // (supplementary-source tryout noise) is honestly "incomplete" but not a gap to
    // act on — recording it as a gap would storm-dispatch a gather that can't help.
    if (censusMissing.length > 0 || censusExtractorBroken) {
      gaps.push({
        showId,
        title: show.title,
        category,
        openingDate: show.openingDate,
        reviewCount: showReviews.length,
        scoredCount: scoredReviews.length,
        censusMissing,
        censusMissingT12,
        censusMissingSoft,
        censusSuppressed,
        censusExtractorBroken,
        censusVerdict: cVerdict ? cVerdict.verdict : null,
        dispatchable,
        severity: (censusMissingT12.length >= 3 || censusExtractorBroken) ? 'major' : 'minor',
      });
    }
  }

  // Summary
  console.log(`\n=== Summary ===`);
  console.log(`Shows checked: ${targetShows.length}`);
  console.log(`Shows with gaps: ${gaps.length}`);
  const majorGaps = gaps.filter(g => g.severity === 'major');
  if (majorGaps.length > 0) {
    console.log(`Major gaps (3+ T1/T2 census-missing outlets or broken extractor): ${majorGaps.length}`);
  }
  if (floorBreaches.length > 0) {
    console.log(`🚨 Floor breaches (silent extractor failure): ${floorBreaches.length}`);
  }

  // Discord alert
  if (opts.alert && (gaps.length > 0 || floorBreaches.length > 0)) {
    await sendDiscordAlert(gaps, floorBreaches);
  }

  // Auto-dispatch collection — ONLY for gaps with something fetchable. A show
  // that's incomplete only because of suppressed (unfetchable-from-CI) outlets,
  // or whose extractor broke, is alerted above but not re-gathered (a gather
  // can't satisfy a CI-blocked outlet — re-firing it every run is the storm).
  if (opts.dispatch && (gaps.length > 0 || floorBreaches.length > 0)) {
    const dispatchableGaps = gaps.filter(g => g.dispatchable);
    const toDispatch = [
      ...dispatchableGaps,
      ...floorBreaches.filter(b => !dispatchableGaps.some(g => g.showId === b.showId)),
    ];
    if (toDispatch.length) await dispatchCollection(toDispatch);
    const skipped = gaps.length - dispatchableGaps.length;
    if (skipped > 0) console.log(`\n⏭️  ${skipped} gap(s) alert-only (suppressed/unfetchable or broken extractor) — not dispatched.`);
  }

  // Machine-readable output
  const report = {
    timestamp: new Date().toISOString(),
    daysChecked: opts.days,
    showsChecked: targetShows.length,
    gaps,
    floorBreaches,
  };
  console.log('\n' + JSON.stringify(report, null, 2));

  // Exit with non-zero if major gaps or floor breaches found (useful for CI)
  if (majorGaps.length > 0 || floorBreaches.length > 0) {
    process.exit(1);
  }
}

async function sendDiscordAlert(gaps, floorBreaches = []) {
  try {
    const { sendAlert } = require('./lib/discord-notify');

    // Floor breaches take priority — they indicate a silent extractor failure.
    if (floorBreaches.length > 0) {
      const fields = floorBreaches.map(b => ({
        name: `🚨 ${b.title} (${b.openingDate})`,
        value: `**${b.reviewCount}/${b.reviewFloor} reviews, ${b.scoredCount}/${b.scoredFloor} scored** at ${b.hoursSinceOpen}h post-open\nLikely silent extractor failure (BWW RR sanitizer, DTLI, aggregator parse). Check latest gather-reviews logs.`,
      }));
      await sendAlert({
        title: '🚨 Opening-Night Review Floor Breach',
        description: `${floorBreaches.length} show(s) below minimum review count 24-72h post-open`,
        severity: 'error',
        fields: fields.slice(0, 10),
      });
      console.log('\nDiscord floor-breach alert sent.');
    }

    if (gaps.length > 0) {
      const fields = gaps.map(g => {
        const lines = [`${g.reviewCount} reviews, ${g.scoredCount} scored`];
        const t12 = g.censusMissingT12 || [];
        const t3 = (g.censusMissing || []).filter(id => !t12.includes(id));
        if (t12.length) lines.push(`Census-missing T1/T2 (roundup lists, we lack/unscored): ${t12.join(', ')}`);
        if (t3.length) lines.push(`Census-missing T3+/unregistered (informational, not dispatched): ${t3.join(', ')}`);
        if (!t12.length && !t3.length && g.censusVerdict === 'no-census-yet') lines.push(`Census: no roundup published yet`);
        if (g.censusSuppressed && g.censusSuppressed.length) lines.push(`⛔ Blocked (unfetchable from CI — needs manual grab): ${g.censusSuppressed.join(', ')}`);
        if (g.censusExtractorBroken) lines.push(`🚨 Census extractor broke (archive present, 0 extracted) — check roundup parser`);
        return { name: `${g.title} (${g.openingDate})`, value: lines.join('\n') };
      });
      const t12Gaps = gaps.filter(g => (g.censusMissingT12 || []).length > 0).length;
      await sendAlert({
        title: 'Opening-Night Coverage Gaps',
        description: `${gaps.length} show(s) with census gaps (${t12Gaps} missing T1/T2 reviews)`,
        severity: gaps.some(g => g.severity === 'major') ? 'error' : 'warning',
        fields: fields.slice(0, 10),
      });
      console.log('\nDiscord gap alert sent.');
    }
  } catch (e) {
    console.error('Failed to send Discord alert:', e.message);
  }
}

async function dispatchCollection(gaps) {
  const { execSync } = require('child_process');
  // Per-show in-flight dedup so a still-incomplete show (slow roundups keep it
  // incomplete for DAYS) doesn't re-fire FULL gather on every 2x-daily run — a
  // dispatch storm. Reuses the gather-idempotency run-name match (same as
  // opening-night-reviews.yml's dispatch step). Codex ship-check #2.
  let activeRuns = [];
  try {
    const out = execSync('gh run list --workflow=gather-reviews.yml --json status,displayTitle --limit 100', { encoding: 'utf8' });
    activeRuns = JSON.parse(out || '[]');
  } catch (_) { /* if we can't list, fall through and dispatch (fail-open) */ }
  let showsNeedingGather = null;
  try { ({ showsNeedingGather } = require('./lib/gather-idempotency')); } catch (_) {}
  const wanted = gaps.map((g) => g.showId);
  const needing = showsNeedingGather ? new Set(showsNeedingGather(activeRuns, wanted)) : new Set(wanted);

  for (const gap of gaps) {
    if (!needing.has(gap.showId)) {
      console.log(`\n⏭️  ${gap.showId}: gather already in-flight — skipping dispatch (no storm).`);
      continue;
    }
    try {
      // FULL gather (aggregators_only=false, max_tier=3) so the per-outlet SERP
      // pass searches the long tail the census flagged — not just aggregators.
      // collect-review-texts (chain=true, below) then triggers rebuild → score,
      // so the recovered reviews reach reviews.json and the broadcast re-fires.
      console.log(`\nDispatching FULL gather-reviews for ${gap.showId}...`);
      execSync(
        `gh workflow run gather-reviews.yml -f shows="${gap.showId}" -f max_tier=3 -f aggregators_only=false`,
        { stdio: 'inherit' }
      );

      console.log(`Dispatching collect-review-texts for ${gap.showId}...`);
      execSync(
        `gh workflow run "Collect Review Texts" -f show_filter="${gap.showId}" -f max_reviews=0 -f chain=true`,
        { stdio: 'inherit' }
      );
    } catch (e) {
      console.error(`Failed to dispatch for ${gap.showId}:`, e.message);
    }
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
