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
  for (const url of (result.aggregatorListedUrls || [])) {
    if (missingUrls.has(url) || flaggedUrls.has(url)) continue;
    const id = hostOf(url);
    if (!id || covered.has(id)) continue;
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
  return { ...v, liveCount: covered.size, candidateCount: entries.length };
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

/**
 * Run `fn` while holding an exclusive lock on `lockPath`.
 *
 * The plan's S0 acceptance is "`--show=X` twice CONCURRENTLY → no lost data".
 * Merging alone doesn't give that: two overlapping runs (the hourly cron and a
 * human at a terminal, which the GitHub concurrency group does not serialize)
 * both read the same prior file and the later write drops the earlier run's
 * per-show update — #893's data loss from a different cause. `wx` open is
 * atomic on POSIX, so exactly one process wins the create.
 *
 * Fail-open on every uncertainty: a lock we cannot create after the timeout is
 * broken (assumed stale from a killed process) and the work proceeds. Blocking
 * the audit forever on a leftover lockfile would be a worse failure than the
 * race it prevents.
 *
 * PRECONDITION: staleMs must comfortably exceed how long `fn` runs. The lock's
 * mtime is stamped once at acquire and never refreshed, so a critical section
 * longer than staleMs lets a waiter classify a LIVE lock as abandoned and steal
 * it. Here `fn` is a synchronous merge + two file writes (milliseconds) against
 * a 5-minute default, so the margin is ~5 orders of magnitude — but anyone
 * reusing this helper for slower work must raise staleMs to match.
 *
 * @param {string} lockPath
 * @param {() => any} fn                 executed while holding the lock
 * @param {{timeoutMs?: number, staleMs?: number, waitMs?: number}} [opts]
 */
function withFileLock(lockPath, fn, opts = {}) {
  const { timeoutMs = 30000, staleMs = 5 * 60 * 1000, waitMs = 100 } = opts;
  const fs = require('fs');
  const deadline = Date.now() + timeoutMs;
  let held = false;
  while (Date.now() < deadline) {
    try {
      fs.writeFileSync(lockPath, `${process.pid} ${new Date().toISOString()}\n`, { flag: 'wx' });
      held = true;
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') { held = false; break; } // unwritable dir etc — proceed unlocked
      // Break a lock left behind by a killed process.
      //
      // NOT unlinkSync: between judging the lock stale and deleting it, the
      // original owner can release and a NEW process can take a fresh lock at
      // the same path — the blind unlink would then delete a LIVE lock and two
      // writers would run concurrently, which is the exact failure this
      // function exists to prevent. rename(2) is atomic, so when several
      // processes race to steal the same stale lock exactly one rename
      // succeeds; the losers get ENOENT and simply retry. The steal only ever
      // moves the file we actually judged stale.
      try {
        const st = fs.statSync(lockPath);
        if (Date.now() - st.mtimeMs > staleMs) {
          const stealPath = `${lockPath}.stale-${process.pid}-${st.mtimeMs}`;
          fs.renameSync(lockPath, stealPath); // throws ENOENT if someone else won
          try { fs.unlinkSync(stealPath); } catch { /* best-effort */ }
          continue; // retry the wx create immediately
        }
      } catch { /* vanished or lost the steal race — fall through and retry */ }
      // Busy-wait: this runs once at the very end of a multi-minute audit, so a
      // short synchronous spin is simpler than making the whole write path async.
      const until = Date.now() + waitMs;
      while (Date.now() < until) { /* spin */ }
    }
  }
  try {
    return fn(held);
  } finally {
    // Only ever released when THIS process won the `wx` create above, so this
    // can't remove a lock belonging to someone else.
    if (held) { try { fs.unlinkSync(lockPath); } catch { /* best-effort */ } }
  }
}

module.exports = { mergeGapAudit, countsFor, gapStateFor, censusVerdictFor, stateMap, withFileLock, DEFAULT_RETENTION_DAYS };
