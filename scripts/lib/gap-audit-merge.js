/**
 * Per-show merge for data/audit/show-review-gap.json (task #893, Coverage
 * Verdict S0).
 *
 * The bug: audit-show-review-gap.js wrote the whole file from just the shows it
 * audited this run. A `--show=X` run — exactly what the newsletter send-day
 * runbook and every "collect the missing reviews" command tell you to run —
 * replaced 24 shows' audited state with 1. newsletter-preflight.js then read
 * that file for review-completeness and saw "no data" for every other featured
 * show, and the checkpoint-driven hourly cron re-audited from scratch.
 *
 * The fix: results are keyed by showId and merged. This run's entries win for
 * the shows it audited; everything else is carried forward with the
 * `computedAt` stamp from the run that produced it. Counts are recomputed over
 * the MERGED set so the summary describes the file, not the run.
 *
 * Retention: carried-forward entries older than `retentionDays` are dropped, so
 * the file converges on the shows still being audited instead of growing
 * forever. Entries this run produced are never dropped.
 *
 * Concurrency, honestly: the audit is the only writer, and the GitHub workflow
 * serializes ITS runs via a concurrency group — but a local terminal run can
 * still overlap a cron run, and last-writer-wins would drop the other run's
 * per-show results. Mitigations live at the call site: the previous file is
 * read at the END of the run — after all fetching, with no await between the
 * read and the write — so the lost-update window is the merge itself rather
 * than the whole multi-minute audit; and the write is a tmp+rename so a reader
 * never sees a torn file.
 * A real cross-process lock is out of S0 scope; if overlapping runs ever
 * become routine this needs the #784/#809 reconciler treatment.
 */

'use strict';

// Retention must OUTLAST the longest re-audit skip a show can earn, or the file
// evicts shows that are simply not due yet. Closed-and-clean shows skip for 365
// days (gap-audit-freshness MAX_FRESHNESS_SKIP_MS) and most of the back-catalogue
// backlog sits on that cycle — a 45-day retention (the first cut of this) would
// have dropped them ~320 days before their next audit, and gapStateFor would
// then read them as `no-census-yet`. Derived, not guessed, so the two can't
// drift apart silently.
const { MAX_FRESHNESS_SKIP_MS } = require('./gap-audit-freshness');
const { censusVerdict, CI_UNFETCHABLE_OUTLETS } = require('./review-census');
const {
  CENSUS_SCHEMA,
  isPriorProductionCitation,
  currentRunOnly,
  priorProductionOnly,
} = require('./prior-production-citations');
const RETENTION_GRACE_DAYS = 30;
const DEFAULT_RETENTION_DAYS = Math.ceil(MAX_FRESHNESS_SKIP_MS / (24 * 3600 * 1000)) + RETENTION_GRACE_DAYS;

/** Best-effort hostname (no `www.`) for a review URL — the fallback candidate
 * identity when an aggregator-listed URL has no knownOutletId resolved yet. */
function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return null; }
}

/**
 * Adapt a show-review-gap `result` (missing/flaggedMisses/citedNoUrl/
 * aggregatorListedUrls) into the census shape censusVerdict() expects, and
 * call it for the verdict + per-candidate states (Coverage Verdict S2, task
 * #906). This is the single source of truth the S0 docstring earmarked for
 * S2: gapStateFor no longer hand-derives complete/incomplete/no-census-yet —
 * it reads `.verdict` off this.
 *
 * Identity: outletId is knownOutletId when the aggregator/dirFile scan
 * resolved one, else the bare hostname. A hostname always carries a dot/TLD
 * so it can never collide with a real canonical outlet id (e.g. "standard" vs
 * "standard.co.uk") — safe to mix within one show's synthetic census even
 * though this never touches the outlet registry.
 *
 * hadAnySource intentionally matches the OLD gapStateFor's `sawReference`
 * (aggregatorArticles.length>0 || aggregatorListedUrls.length>0) rather than
 * also counting citedNoUrl, so this is a drop-in replacement with the same
 * verdict on real data (parity-tested). The one deliberate behavior change is
 * inherited from censusVerdict() itself: an aggregator article that yielded
 * ZERO extractable URLs now reads `no-census-yet` instead of `complete` — the
 * vacuous-truth trap review-census.js's own docstring warns about. The S0
 * blast-radius guard is exactly the safety net for that class of shift.
 *
 * @param {object} result  one audit-show-review-gap.js per-show result
 * @param {object} [opts]  forwarded to censusVerdict (now/clockAnchor/prevCandidates/suppressed/…)
 * @returns {{verdict, missing, suppressedMissing, candidates, liveCount, candidateCount}}
 */
function censusVerdictFor(result, opts = {}) {
  if (!result || typeof result !== 'object') {
    return { verdict: 'no-census-yet', missing: [], suppressedMissing: [], candidates: [], liveCount: 0, candidateCount: 0 };
  }
  const missingUrls = new Set((result.missing || []).map((m) => m.url));
  const flaggedUrls = new Set((result.flaggedMisses || []).map((m) => m.url));
  const entries = [];
  const covered = new Set();
  // One candidate per URL, NOT per host. `covered` stays outlet(host)-level —
  // that is the verdict's input and a second URL from an already-covered outlet
  // must not change complete/incomplete — but the CANDIDATE list is the plan's
  // "every review the system knows about gets exactly one visible state", so an
  // outlet that published two reviewed URLs owes two states. Deduping entries by
  // host here left the sibling URL with no state at all (caught by
  // report-stateless-candidates.js on real data: Time Out + londontheatre on
  // tao-of-glass, nystagereview on les-miserables-arena). Identical repeated URLs
  // still collapse.
  const seenUrls = new Set();
  for (const url of (result.aggregatorListedUrls || [])) {
    if (missingUrls.has(url) || flaggedUrls.has(url)) continue;
    const id = hostOf(url);
    if (!id || seenUrls.has(url)) continue;
    seenUrls.add(url);
    covered.add(id);
    entries.push({ outletId: id, outlet: id, critic: 'Unknown', stars: null, url });
  }
  // knownOutletId first (real registry id), then the host field the audit
  // already computed alongside url, then a fresh parse of url as a last
  // resort — a missing/flagged entry must never silently vanish from the
  // census just because none of its identity fields happened to be set.
  //
  // Collision guard (ship-check finding): an UNREGISTERED host (no
  // knownOutletId) falls back to its bare hostname, same as the "covered"
  // loop above. If that host has ONE covered URL and a DIFFERENT missing/
  // flagged URL, both would land on the identical outletId — censusVerdict's
  // covered-set check would then treat the missing citation as covered too,
  // silently masking a real gap (the exact vacuous-truth trap this system
  // exists to prevent). A knownOutletId is curated and safe to collapse on;
  // a bare hostname is not, so give the URL its own identity whenever it
  // would otherwise collide with something already in `covered`.
  const identityFor = (m) => {
    const id = m.knownOutletId || m.host || hostOf(m.url);
    if (!id) return null;
    if (!m.knownOutletId && covered.has(id)) return `${id}::${m.url || 'no-url'}`;
    return id;
  };
  // A prior-production citation is not a CANDIDATE for this run's census
  // either. countsFor already stops them inflating `withGap`/
  // `missingCurrentRun`, but the census is a separate surface and it is the
  // one that reaches people: generate-mobile-show-details.js publishes
  // liveCount/candidateCount to the iOS app, and coverage-digest.js formats
  // them into the owner's morning email. Measured on the live audit file
  // (2026-09-23), 146 shows were still publishing an inflated census —
  // hadestown-west-end-2024 said "8 of 102 known reviews live" with 101 of
  // those candidates from earlier productions; beetlejuice-2025 said "1 of
  // 74" with 80.
  //
  // It is not only a wrong number. These citations are permanently
  // ingest-blocked, so a revival could never reach `complete` however many
  // reviews we collected — the verdict carried no information at all. And
  // because the digest is ratio-sorted and capped at ten, shows whose gap was
  // ENTIRELY prior-production ("Bull Durham: 0 of 3 known reviews live, 3
  // excluded (older production)") sorted above shows with genuinely missing,
  // genuinely fetchable reviews, and pushed them off the list the owner reads.
  //
  // They stay in result.missing/flaggedMisses with their priorRun tag —
  // dropped from the census, not from the file.
  for (const m of (result.missing || [])) {
    if (isPriorProductionCitation(m)) continue;
    const id = identityFor(m);
    if (!id) continue;
    entries.push({ outletId: id, outlet: m.knownOutletId || m.host || id, critic: 'Unknown', stars: null, url: m.url || '' });
  }
  for (const m of (result.flaggedMisses || [])) {
    if (isPriorProductionCitation(m)) continue;
    const id = identityFor(m);
    if (!id) continue;
    entries.push({ outletId: id, outlet: m.knownOutletId || m.host || id, critic: 'Unknown', stars: null, url: m.url || '' });
  }
  for (const c of (result.citedNoUrl || [])) {
    if (!c || !c.outletId) continue;
    if (isPriorProductionCitation(c)) continue;
    entries.push({ outletId: c.outletId, outlet: c.outletName || c.outletId, critic: 'Unknown', stars: null, url: '' });
  }
  const hadAnySource = (Array.isArray(result.aggregatorArticles) && result.aggregatorArticles.length > 0)
    || (Array.isArray(result.aggregatorListedUrls) && result.aggregatorListedUrls.length > 0);
  const census = { entries, count: entries.length, sourcesPresent: hadAnySource ? ['gap-audit'] : [], hadAnySource };
  const censusOpts = { suppressed: CI_UNFETCHABLE_OUTLETS, clockAnchor: result.openingDate || null, ...opts };
  const v = censusVerdict(census, covered, censusOpts);
  // Stamped so a later run can tell a pre-v2 row from a current one.
  v.censusSchema = CENSUS_SCHEMA;
  // PUBLIC counts are OUTLET-level, deliberately, even though `candidates` is
  // URL-level. The gap audit resolves coverage per HOST (its dirByHost map), so
  // two aggregator-listed URLs from one outlet are both stamped `live` off a
  // single review file — publishing that as "2 of 2 reviews live" would state
  // something we cannot vouch for, and aggregator lists routinely carry a
  // listing page alongside the review (timeout.com/london/theatre/<show>).
  // Distinct outlets is the finest granularity the audit actually knows, and it
  // keeps liveCount ≤ candidateCount stable. Private per-candidate detail keeps
  // full URL resolution for the owner surfaces.
  const distinct = (rows) => new Set(rows.map((c) => c.outletId).filter(Boolean)).size;
  const liveCount = distinct(v.candidates.filter((c) => c.state === 'live'));
  const candidateCount = distinct(v.candidates);
  return { ...v, liveCount, candidateCount };
}

/**
 * Coverage state for one audited show, in the plan's vocabulary
 * (complete | incomplete | no-census-yet). Thin wrapper over
 * censusVerdictFor().verdict — kept as its own export because blast-radius
 * comparisons (stateMap) only ever need the verdict string, never the full
 * per-candidate detail, and never need a clock (verdict itself doesn't read
 * clockAgeHours — only the per-candidate GAP/IN_FLIGHT split does).
 */
function gapStateFor(result) {
  return censusVerdictFor(result).verdict;
}

/** { showId -> state } for a results array — the blast-radius guard's input. */
function stateMap(results) {
  const out = {};
  for (const r of results || []) {
    if (r && r.showId) out[r.showId] = gapStateFor(r);
  }
  return out;
}

/**
 * Per-show state for the review-gap blast-radius guard (BRO-513), as an
 * opaque `verdict:liveCount:candidateCount` string keyed by showId — the
 * shape blastRadiusCheck's stateMap args expect. Unlike stateMap()/
 * gapStateFor() above (the bare verdict word, used by every OTHER consumer
 * of this audit file), this deliberately keeps liveCount/candidateCount
 * alongside the verdict so isRiskyGapChange can tell "the census found a
 * genuine NEW gap" (candidateCount grew, nothing previously live was lost)
 * apart from "we lost coverage we used to have" (liveCount dropped — a
 * broken/partial review-texts checkout makes loadDirFiles() return [] for
 * every show, so previously-`live` outlets read as newly `missing`, the
 * SAME complete → incomplete verdict transition as the benign case). See
 * isRiskyGapChange below and coverage-gate.js's isRiskyChange rationale.
 */
function riskStateMap(results) {
  const out = {};
  for (const r of results || []) {
    if (!r || !r.showId) continue;
    // Prefer the ALREADY-STAMPED censusVerdict (mergeGapAudit computed it once
    // with the run's real `now`/prevCandidates opts, which affect per-candidate
    // live/in-flight classification) over recomputing with default opts here,
    // which could disagree at the margin. Recompute only as a fallback for
    // legacy rows that predate task #906's censusVerdict stamping.
    // A stored verdict is only usable here if the CURRENT candidate rule
    // produced it. The blast-radius guard calls `nextCandidates <
    // prevCandidates` risky — exactly the shape of a rule change (146 of 562
    // shows dropped candidates when prior-production citations stopped
    // counting) — so diffing an old-schema prev against a new-schema next
    // would refuse the write on every run, forever. Normalise both sides and
    // the guard goes back to catching what it is for: real coverage loss.
    const stored = r.censusVerdict;
    const usable = stored && typeof stored.liveCount === 'number' && stored.censusSchema === CENSUS_SCHEMA;
    const cv = usable ? stored : censusVerdictFor(r);
    const liveCount = Number.isFinite(cv.liveCount) ? cv.liveCount : 0;
    const candidateCount = Number.isFinite(cv.candidateCount) ? cv.candidateCount : 0;
    out[r.showId] = `${cv.verdict}:${liveCount}:${candidateCount}`;
  }
  return out;
}

/**
 * isRiskyChange predicate for blastRadiusCheck({ ... }) over riskStateMap()
 * output: risky iff EITHER count went DOWN. A verdict word changing while
 * both counts hold or grow (new gap discovered, or a gap got filled) is the
 * audit doing its job and is never risky.
 *
 * Known residual blind spot (adversarial ship-check follow-up): this is
 * cardinality-only, not identity-aware — a run that loses one live outlet
 * while simultaneously gaining a different one nets to an unchanged
 * liveCount and would not register as risky. Accepted: the documented
 * failure modes (dead SERP provider, empty census, partial checkout) zero
 * counts out, they don't swap one outlet's identity for another's, so this
 * doesn't match the guard's actual threat model. A full identity diff would
 * need per-candidate URL comparison, not a per-show scalar blastRadiusCheck
 * can consume — revisit only if a real incident ever shows this shape.
 */
function isRiskyGapChange(prevState, nextState) {
  const counts = (s) => String(s).split(':').slice(1).map(Number);
  const [prevLive, prevCandidates] = counts(prevState);
  const [nextLive, nextCandidates] = counts(nextState);
  return nextLive < prevLive || nextCandidates < prevCandidates;
}

/**
 * Split this run's freshly-audited results into the subset safe to persist
 * and the subset blastRadiusCheck flagged as risky (BRO-3002).
 *
 * WHY THIS EXISTS: the checkpoint selects the LEAST-RECENTLY-audited shows
 * each run — which shows land in one batch is unrelated to which of them
 * happen to carry a real new flag. Before this, a batch that mixed a handful
 * of genuinely-changed shows into a much larger set of unrelated ones had its
 * ENTIRE write refused, and the checkpoint rollback (audit-show-review-gap.js)
 * restored ALL of them — including the unrelated majority — to their old
 * timestamps. Next run, the same least-recently-audited selection picks the
 * identical batch again, hits the identical few risky shows, and refuses
 * again — forever. BRO-3002 observed exactly this: the same ~9-show set
 * recurred across three consecutive hourly runs on 2026-09-07, each one
 * comparing against the same 2026-09-05 baseline because no run since had
 * ever been allowed to advance it.
 *
 * Splitting the write lets the unrelated majority's freshness stamps advance
 * normally (so the checkpoint moves on to genuinely-stale shows next run)
 * while the risky subset alone stays parked at its old entry/timestamp —
 * still flagged, still re-selected, still alerting, but no longer able to
 * starve every other show behind it. A batch where EVERY examined show is
 * risky (the actual dead-SERP/empty-census/partial-checkout signature this
 * guard exists to catch) degrades to `safe: []` — i.e. today's full-block
 * behavior, unchanged.
 *
 * @param {Array} results  this run's raw per-show results (pre-merge)
 * @param {string[]} riskyIds  showIds blastRadiusCheck returned as changedIds
 * @returns {{safe: Array, risky: Array}}
 */
function partitionAuditedResults(results, riskyIds) {
  const risky = new Set(riskyIds || []);
  const safe = [];
  const flagged = [];
  for (const r of (results || [])) {
    if (r && r.showId && risky.has(r.showId)) flagged.push(r);
    else safe.push(r);
  }
  return { safe, risky: flagged };
}

/**
 * True when a persisted row's census verdict predates the current candidate
 * rule and must be re-derived before anyone reads or diffs it.
 *
 * A row with NO verdict is left alone: that is a legacy pre-#906 row, and
 * stamping one here would invent a verdict for a show this run never looked
 * at. riskStateMap already recomputes those in place for comparison.
 */
function needsCensusMigration(row) {
  const cv = row && row.censusVerdict;
  if (!cv || typeof cv !== 'object') return false;
  if (cv.censusSchema === CENSUS_SCHEMA) return false;
  // Only migrate a row that can actually SUPPORT a rebuilt verdict. The
  // recompute reads the raw arrays, not the stored verdict, so a row whose
  // arrays are absent or empty — a partial write, a truncated carry-forward —
  // would rebuild to `no-census-yet` with candidateCount 0 and silently erase
  // a census that was previously populated. riskStateMap would then normalise
  // the PREVIOUS row the same way and compare zero against zero, so the
  // blast-radius guard could not see the loss either (Codex adversarial
  // review). Refusing to migrate leaves the stale-but-real verdict in place;
  // the show's next real audit rewrites it properly.
  const hasSource = ['missing', 'flaggedMisses', 'citedNoUrl', 'aggregatorListedUrls', 'aggregatorArticles']
    .some((k) => Array.isArray(row[k]) && row[k].length > 0);
  return hasSource;
}

/**
 * Merge this run's results into the previously-persisted audit.
 *
 * @param {Object|null} prevAudit  parsed previous show-review-gap.json (or null)
 * @param {Object} runAudit        this run's audit object ({generatedAt, windowDays, targets, results})
 * @param {Object} [opts]
 * @param {number} [opts.retentionDays=45]
 * @param {string} [opts.now=runAudit.generatedAt]  ISO stamp for this run
 * @param {Set<string>|string[]} [opts.protectedIds]  showIds exempt from the
 *   retention-age drop below, even though this run did not re-audit them.
 *   BRO-3002: a quarantined show's carried-forward entry is otherwise an
 *   ordinary stale row — its computedAt is frozen at the run BEFORE it got
 *   quarantined and never advances (excluded from freshIds every subsequent
 *   run for as long as it stays risky), so once real wall-clock time exceeds
 *   retentionDays it would silently get pruned — "lost", not "parked",
 *   exactly the outcome the quarantine split exists to prevent. The caller
 *   (audit-show-review-gap.js) passes the risky showIds here on every
 *   quarantined-merge call.
 * @returns {Object} merged audit — same shape, plus per-result `computedAt`
 */
function mergeGapAudit(prevAudit, runAudit, opts = {}) {
  const now = opts.now || (runAudit && runAudit.generatedAt) || new Date().toISOString();
  const retentionDays = opts.retentionDays == null ? DEFAULT_RETENTION_DAYS : opts.retentionDays;
  const cutoffMs = Date.parse(now) - retentionDays * 24 * 3600 * 1000;
  const protectedIds = opts.protectedIds instanceof Set ? opts.protectedIds : new Set(opts.protectedIds || []);

  const runResults = Array.isArray(runAudit && runAudit.results) ? runAudit.results : [];
  const freshIds = new Set(runResults.map(r => r && r.showId).filter(Boolean));

  // Keyed by showId, NOT an append list. A duplicate showId — from either side
  // — must collapse to one row, or every merge appends another copy and the
  // counts inflate silently forever.
  const byId = new Map();
  // Keyed lookup into the PRIOR file (not the merged one) so freshly-audited
  // shows can carry each candidate's firstSeenAt forward even though their
  // top-level result is being fully replaced this run.
  const prevById = new Map();
  // 1. carry forward prior entries this run did NOT re-audit, subject to retention
  const prevResults = Array.isArray(prevAudit && prevAudit.results) ? prevAudit.results : [];
  let carried = 0, dropped = 0;
  for (const r of prevResults) {
    if (!r || !r.showId) continue;
    prevById.set(r.showId, r);
    if (freshIds.has(r.showId)) continue;
    // No computedAt (pre-#893 file) → stamp it with the previous run's
    // generatedAt so it ages out normally instead of living forever.
    const stamp = r.computedAt || (prevAudit && prevAudit.generatedAt) || null;
    const stampMs = stamp ? Date.parse(stamp) : NaN;
    // Unparseable/absent stamp → KEEP. Dropping real audited state because a
    // timestamp didn't parse is the wrong direction to fail on this file.
    if (!protectedIds.has(r.showId) && Number.isFinite(stampMs) && Number.isFinite(cutoffMs) && stampMs < cutoffMs) { dropped++; continue; }
    if (!byId.has(r.showId)) carried++;
    // A carried-forward row keeps the verdict it was stamped with, and for a
    // closed-and-clean show its next audit is up to 365 days away
    // (gap-audit-freshness MAX_FRESHNESS_SKIP_MS). So when the candidate RULE
    // changes, re-derive here rather than serving pre-fix numbers to the iOS
    // app and the owner's digest for a year. Anchored to the row's own
    // `stamp`, not to `now`, so live/in-flight classification stays as-of the
    // run that produced it, and prevCandidates carries firstSeenAt forward.
    const carriedRow = stamp ? { ...r, computedAt: stamp } : { ...r };
    if (needsCensusMigration(carriedRow)) {
      // Anchor the recompute to the row's own stamp so live/in-flight
      // classification stays as-of the run that produced it — but ONLY if that
      // stamp is a real date. A truthy-but-unparseable computedAt survives the
      // retention check above (it deliberately keeps rows it cannot date), and
      // feeding it to the classifier as `now` makes every age comparison
      // NaN — an existing GAP silently downgrades to IN_FLIGHT and the schema
      // stamp then stops it ever being retried (Codex adversarial review).
      // Fall back to the run clock, which is always valid.
      const anchorMs = stamp ? Date.parse(stamp) : NaN;
      carriedRow.censusVerdict = censusVerdictFor(carriedRow, {
        now: Number.isFinite(anchorMs) ? stamp : now,
        prevCandidates: (r.censusVerdict && r.censusVerdict.candidates) || [],
      });
    }
    byId.set(r.showId, carriedRow);
  }
  // 2. this run's entries win, stamped now (last write per showId wins).
  // censusVerdict (task #906) is (re)computed here — carried-forward entries
  // above keep whatever verdict they were stamped with the run that produced
  // them; only freshly-audited results get a new one, with firstSeenAt
  // continuity from the previous run's candidates for the SAME show.
  for (const r of runResults) {
    if (!r || !r.showId) continue;
    const prevCandidates = (prevById.get(r.showId) && prevById.get(r.showId).censusVerdict
      && prevById.get(r.showId).censusVerdict.candidates) || [];
    const cv = censusVerdictFor(r, { now, prevCandidates });
    byId.set(r.showId, { ...r, censusVerdict: cv, computedAt: now });
  }

  const merged = [...byId.values()].sort((a, b) => String(a.showId).localeCompare(String(b.showId)));

  return {
    generatedAt: now,
    windowDays: runAudit && runAudit.windowDays,
    // `targets` describes THIS run; `results` describes the whole file.
    targets: runAudit && runAudit.targets,
    auditedThisRun: runResults.length,
    carriedForward: carried,
    prunedStale: dropped,
    retentionDays,
    counts: countsFor(merged),
    results: merged,
  };
}

// BRO-3928: a citation belonging to an earlier production of the same title
// (`m.priorRun === true`, stamped by audit-show-review-gap.js's production-
// identity checks — a prior-run BWW/Playbill roundup, a stale-year Show Score
// URL, a WE reference row citing the earlier run) is PERMANENTLY ingest-
// blocked by design (gap-ingest-policy.js) — it is never a gap in THIS
// production. The audit already computed and tagged this correctly; these
// headline counts just never read the tag, so a revival with a well-cited
// prior production (Cats, Kimberly Akimbo, The Cherry Orchard, Golden Boy)
// summed those old citations into `totalMissing`/`withGap` and read as
// catastrophically incomplete. `currentRun` keeps only actionable entries;
// prior-production citations are tallied separately, informational only —
// they must never feed `withGap`/`missingCurrentRun`/`--fail-on-gap`.
// The rule itself lives in prior-production-citations.js so that every surface
// that counts these — countsFor here, the audit's per-show summary and
// checkpoint, the census candidate pool below, newsletter pre-send — asks the
// same function. It was already correct in five scattered places and wrong in
// the two a human reads; a sixth local copy is how that recurs.
const currentRun = currentRunOnly;
const priorRunOnly = priorProductionOnly;

/** Recompute the summary counts over an arbitrary results array. */
function countsFor(results) {
  const rs = results || [];
  return {
    withGap: rs.filter(r => currentRun(r.missing).length + currentRun(r.flaggedMisses).length + currentRun(r.citedNoUrl).length > 0).length,
    missingCurrentRun: rs.reduce((a, r) => a + currentRun(r.missing).length, 0),
    totalCitedNoUrl: rs.reduce((a, r) => a + currentRun(r.citedNoUrl).length, 0),
    totalFlaggedMisses: rs.reduce((a, r) => a + currentRun(r.flaggedMisses).length, 0),
    // priorRun-excluded to match totalFlaggedMisses: a prior-production
    // flaggedMiss can carry `recoverable: true` (auditShow sets it from the
    // file's own empty-body state, before priorRun tagging runs), but the
    // ingest loop's recBlockedPred permanently blocks recovery on it — so
    // counting it here would advertise a "recoverable" gap that never
    // actually recovers (Codex adversarial review, BRO-3928).
    totalRecoverable: rs.reduce((a, r) => a + currentRun(r.flaggedMisses).filter(m => m && m.recoverable).length, 0),
    totalRecovered: rs.reduce((a, r) => a + (Array.isArray(r.recoveryResults) ? r.recoveryResults.filter(x => x && x.recovered).length : 0), 0),
    // Informational only — never gates withGap/--fail-on-gap. Reported
    // separately in the run Summary so a revival's prior-production citations
    // are visible without inflating the actionable number.
    priorProductionCitations: rs.reduce((a, r) => a + priorRunOnly(r.missing).length + priorRunOnly(r.flaggedMisses).length + priorRunOnly(r.citedNoUrl).length, 0),
  };
}

// withFileLock used to live here, scoped (per its old docstring) to this
// file's merge. Task #923: it now also locks gap-audit-checkpoint.json, an
// unrelated file, so it moved to lib/file-lock.js — a lock helper whose
// docstring names one file while guarding a different one is exactly the kind
// of drift that hides a missing lock call at the next site. Re-exported here
// so existing `require('./gap-audit-merge').withFileLock` call sites keep
// working.
const { withFileLock } = require('./file-lock');

module.exports = { mergeGapAudit, countsFor, gapStateFor, censusVerdictFor, stateMap, riskStateMap, isRiskyGapChange, partitionAuditedResults, withFileLock, DEFAULT_RETENTION_DAYS, CENSUS_SCHEMA, needsCensusMigration };
