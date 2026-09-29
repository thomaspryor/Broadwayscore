'use strict';

const fs = require('fs');
const path = require('path');
const { isIncludableForRebuild } = require('./review-guards');

/**
 * Reads all JSON files in the show's review-texts directory, applies
 * isIncludableForRebuild to each, and returns counts.
 *
 * @param {string} showId
 * @param {string} reviewTextsRoot  default: 'data/review-texts'
 * @param {object} [show]  optional show context — pass when available so
 *   the predicate's stale-wrongShow override can fire (Codex ship-check
 *   2026-04-29). Omitted callers fail safe (over-exclude wrongShow files
 *   that would have cleared with show context).
 * @returns {{ total: number, included: number, excluded: number }}
 */
function countLocalIncluded(showId, reviewTextsRoot = 'data/review-texts', show) {
  const dir = path.join(reviewTextsRoot, showId);
  if (!fs.existsSync(dir)) {
    return { total: 0, included: 0, excluded: 0 };
  }
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
  let included = 0;
  let excluded = 0;
  for (const f of files) {
    let data;
    try {
      data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    } catch {
      excluded++;
      continue;
    }
    if (isIncludableForRebuild(data, show)) {
      included++;
    } else {
      excluded++;
    }
  }
  return { total: files.length, included, excluded };
}

/**
 * Counts reviews for a show in a parsed reviews.json document.
 * Handles both array and {reviews: [...]} shapes.
 *
 * @param {string} showId
 * @param {Array|{reviews: Array}} reviewsDoc
 * @returns {number}
 */
function countAggregate(showId, reviewsDoc) {
  const list = Array.isArray(reviewsDoc)
    ? reviewsDoc
    : (reviewsDoc && reviewsDoc.reviews) || [];
  return list.filter(r => r.showId === showId || r.show === showId).length;
}

/**
 * Fetches the live review count from the production JSON endpoint.
 * The per-show JSON uses the `rc` field (verified 2026-04-16).
 *
 * @param {string} showId
 * @returns {Promise<{ rc: number|null, err: string|null, errKind: 'http'|'timeout'|'network'|'missing-field'|null }>}
 */
async function fetchLiveRc(showId) {
  const url = `https://broadwayscorecard.com/data/shows/${showId}.json`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 8000);
  try {
    const res = await fetch(url, {
      headers: { 'cache-control': 'no-cache' },
      signal: ac.signal,
    });
    clearTimeout(timer);
    if (!res.ok) {
      return { rc: null, err: `HTTP ${res.status}`, errKind: 'http' };
    }
    const json = await res.json();
    return classifyLiveRcPayload(json);
  } catch (err) {
    clearTimeout(timer);
    return err.name === 'AbortError'
      ? { rc: null, err: 'timeout (8s)', errKind: 'timeout' }
      : { rc: null, err: String(err), errKind: 'network' };
  }
}

/**
 * Classify a successfully-fetched live show JSON. A 200 response whose body
 * lacks a numeric `rc` is NOT "can't compare" — the deployed artifact itself
 * is malformed/stale (the site is serving a show without its review count),
 * which is precisely the drift symptom the detector exists to catch. Callers
 * distinguish it from transport errors via errKind === 'missing-field'.
 */
function classifyLiveRcPayload(json) {
  const rc = json && typeof json.rc === 'number' ? json.rc : null;
  return rc == null
    ? { rc: null, err: 'field rc not found in response', errKind: 'missing-field' }
    : { rc, err: null, errKind: null };
}

/** True when the live page was served (HTTP 200) but carries no review count. */
function isLiveRcMissingField(live) {
  return !!live && live.errKind === 'missing-field';
}

/**
 * Reads the local per-show JSON (stage 3) and returns both the cached `rc`
 * count and the actual length of the `rv` reviews array. Returns null if the
 * file is missing or unreadable.
 *
 * Pairs with fetchLiveRc: fetchLiveRc reads the same file served from CDN
 * (stage 4), countLocalPerShowJson reads it from the local filesystem (stage 3).
 * Drift between the two isolates deploy-lag from generation bugs.
 *
 * @param {string} showId
 * @param {string} publicDataRoot  default: 'public/data/shows'
 * @returns {{ rc: number|null, reviewsArrayLength: number }|null}
 */
function countLocalPerShowJson(showId, publicDataRoot = 'public/data/shows') {
  const filePath = path.join(publicDataRoot, `${showId}.json`);
  if (!fs.existsSync(filePath)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const rc = typeof data.rc === 'number' ? data.rc : null;
    const reviewsArrayLength = Array.isArray(data.rv) ? data.rv.length : 0;
    return { rc, reviewsArrayLength };
  } catch {
    return null;
  }
}

/**
 * Computes drift from the available count sources. Any field that is null/
 * undefined is omitted. With all four provided: max - min over
 * [local, aggregate, localJson, live].
 *
 * @param {{ local: number, aggregate: number, localJson?: number|null, live?: number|null }} counts
 * @returns {{ min: number, max: number, drift: number }}
 */
function computeDrift({ local, aggregate, localJson, live }) {
  const values = [local, aggregate];
  if (localJson != null) values.push(localJson);
  if (live != null) values.push(live);
  const min = Math.min(...values);
  const max = Math.max(...values);
  return { min, max, drift: max - min };
}

/**
 * BRO-931 #4 — "local 21 vs live 13" went unexplained for hours during the
 * Fear of 13 (2026-04-15) opening night. check-opening-night-drift.js's
 * grace-window logic (shouldAlert: only fire once the SAME fingerprint has
 * persisted across 2+ consecutive runs) previously built its fingerprint
 * from ALL FOUR stage counts (local, agg, localJson, live). During exactly
 * that incident shape — local/agg/localJson climbing every ~30min as new
 * reviews are gathered and rebuilt while live stays frozen — the fingerprint
 * changed on every single run, so `consecutiveCount` never reached the grace
 * threshold and the alert never fired for as long as local kept growing:
 * backwards, since a growing gap while live is stuck is the incident getting
 * WORSE, not resolving.
 *
 * The signal that must stay unchanged to prove "genuinely stuck, not just
 * mid-cascade" is whether LIVE has moved, not whether the whole tuple is
 * identical — the other three stages are expected to advance while the
 * pipeline is actively catching up; only a frozen live count means nothing
 * reached production. Keying the fingerprint on `live` alone lets the grace
 * window accumulate correctly in the exact scenario it exists to catch, and
 * still resets appropriately the moment live actually advances (even
 * slowly), since that's real progress, not a stuck state.
 */
function makeFingerprint(live) {
  return `${live ?? 'null'}`;
}

// Re-alert only after 6h if the same stuck state persists.
const SAME_FP_COOLDOWN_MS = 6 * 60 * 60 * 1000;
// Only alert once the SAME stuck state has been observed on 2+ consecutive runs.
const GRACE_CONSECUTIVE = 2;

/**
 * Returns true if we should fire an alert for this show given the current
 * fingerprint and state entry.
 *
 * Adversarial ship-check finding (BRO-931 #4 follow-up): `updateState` runs
 * every check, including healthy (non-drifting) runs, so `consecutiveCount`
 * was accumulating regardless of drift status. If live happened to hold the
 * same value through a healthy stretch and THEN a real drift appeared with
 * that same live value (a common shape — live freezes, then local/agg start
 * climbing on top of it), the fingerprint already matched the prior entry on
 * the very FIRST drifting run, so the grace window was pre-armed and alerted
 * immediately instead of waiting for 2 CONFIRMED-DRIFTING consecutive runs.
 * `aboveThreshold` closes this: a run only continues the grace window when
 * the PREVIOUS entry was also above threshold with the same fingerprint: a
 * healthy→drifting transition always restarts the count at 1, even when the
 * live value itself didn't change.
 *
 * Alert fires when:
 *   - Same fingerprint AND both runs above threshold AND 2+ consecutive runs
 *   - AND (never alerted before, OR >6h since the last alert)
 */
function shouldAlert(showId, fingerprint, drift, threshold, state) {
  if (drift <= threshold) return false;

  const entry = state[showId];
  if (!entry || entry.fingerprint !== fingerprint || !entry.aboveThreshold) {
    // New/changed fingerprint, or the previous run wasn't drifting — start (or restart) the grace window.
    return false; // Wait for next run to confirm
  }

  // Same fingerprint AND previous run was also above threshold.
  const consecutiveCount = (entry.consecutiveCount || 1) + 1;
  if (consecutiveCount < GRACE_CONSECUTIVE) return false;

  const now = Date.now();
  if (!entry.lastAlertTs) return true;
  return (now - entry.lastAlertTs) >= SAME_FP_COOLDOWN_MS;
}

/**
 * @param {boolean} aboveThreshold whether THIS run's drift exceeds the
 *   configured threshold — see shouldAlert's doc comment for why this must
 *   gate continuation of the grace window, not just fingerprint equality.
 */
function updateState(state, showId, fingerprint, didAlert, aboveThreshold) {
  const entry = state[showId];
  const now = Date.now();

  if (!entry || entry.fingerprint !== fingerprint || !entry.aboveThreshold) {
    state[showId] = {
      fingerprint,
      firstSeen: now,
      consecutiveCount: 1,
      lastAlertTs: didAlert ? now : null,
      aboveThreshold,
    };
  } else {
    state[showId] = {
      ...entry,
      consecutiveCount: (entry.consecutiveCount || 1) + 1,
      lastAlertTs: didAlert ? now : entry.lastAlertTs,
      aboveThreshold,
    };
  }
}

module.exports = {
  countLocalIncluded,
  countAggregate,
  fetchLiveRc,
  countLocalPerShowJson,
  computeDrift,
  classifyLiveRcPayload,
  isLiveRcMissingField,
  makeFingerprint,
  shouldAlert,
  updateState,
};
