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
  for (const m of (result.missing || [])) {
    const id = identityFor(m);
    if (!id) continue;
    entries.push({ outletId: id, outlet: m.knownOutletId || m.host || id, critic: 'Unknown', stars: null, url: m.url || '' });
  }
  for (const m of (result.flaggedMisses || [])) {
    const id = identityFor(m);
    if (!id) continue;
    entries.push({ outletId: id, outlet: m.knownOutletId || m.host || id, critic: 'Unknown', stars: null, url: m.url || '' });
  }
  for (const c of (result.citedNoUrl || [])) {
    if (!c || !c.outletId) continue;
    entries.push({ outletId: c.outletId, outlet: c.outletName || c.outletId, critic: 'Unknown', stars: null, url: '' });
  }
  const hadAnySource = (Array.isArray(result.aggregatorArticles) && result.aggregatorArticles.length > 0)
    || (Array.isArray(result.aggregatorListedUrls) && result.aggregatorListedUrls.length > 0);
  const census = { entries, count: entries.length, sourcesPresent: hadAnySource ? ['gap-audit'] : [], hadAnySource };
  const censusOpts = { suppressed: CI_UNFETCHABLE_OUTLETS, clockAnchor: result.openingDate || null, ...opts };
  const v = censusVerdict(census, covered, censusOpts);
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
    const cv = (r.censusVerdict && typeof r.censusVerdict.liveCount === 'number') ? r.censusVerdict : censusVerdictFor(r);
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
 * Merge this run's results into the previously-persisted audit.
 *
 * @param {Object|null} prevAudit  parsed previous show-review-gap.json (or null)
 * @param {Object} runAudit        this run's audit object ({generatedAt, windowDays, targets, results})
 * @param {Object} [opts]
 * @param {number} [opts.retentionDays=45]
 * @param {string} [opts.now=runAudit.generatedAt]  ISO stamp for this run
 * @returns {Object} merged audit — same shape, plus per-result `computedAt`
 */
function mergeGapAudit(prevAudit, runAudit, opts = {}) {
  const now = opts.now || (runAudit && runAudit.generatedAt) || new Date().toISOString();
  const retentionDays = opts.retentionDays == null ? DEFAULT_RETENTION_DAYS : opts.retentionDays;
  const cutoffMs = Date.parse(now) - retentionDays * 24 * 3600 * 1000;

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
    if (Number.isFinite(stampMs) && Number.isFinite(cutoffMs) && stampMs < cutoffMs) { dropped++; continue; }
    if (!byId.has(r.showId)) carried++;
    byId.set(r.showId, stamp ? { ...r, computedAt: stamp } : { ...r });
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

/** Recompute the summary counts over an arbitrary results array. */
function countsFor(results) {
  const rs = results || [];
  const len = (v) => (Array.isArray(v) ? v.length : 0);
  return {
    withGap: rs.filter(r => len(r.missing) + len(r.flaggedMisses) + len(r.citedNoUrl) > 0).length,
    totalMissing: rs.reduce((a, r) => a + len(r.missing), 0),
    totalCitedNoUrl: rs.reduce((a, r) => a + len(r.citedNoUrl), 0),
    totalFlaggedMisses: rs.reduce((a, r) => a + len(r.flaggedMisses), 0),
    totalRecoverable: rs.reduce((a, r) => a + (Array.isArray(r.flaggedMisses) ? r.flaggedMisses.filter(m => m && m.recoverable).length : 0), 0),
    totalRecovered: rs.reduce((a, r) => a + (Array.isArray(r.recoveryResults) ? r.recoveryResults.filter(x => x && x.recovered).length : 0), 0),
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

module.exports = { mergeGapAudit, countsFor, gapStateFor, censusVerdictFor, stateMap, riskStateMap, isRiskyGapChange, withFileLock, DEFAULT_RETENTION_DAYS };
