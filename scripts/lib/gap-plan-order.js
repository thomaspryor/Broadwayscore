/**
 * gap-plan-order.js — BRO-7942: the gap-recovery driver's run order, retry
 * backoff and URL_FIND time slice. Pure functions; the driver feeds them
 * ledger rows and candidates.
 *
 * Order (owner 2026-11-20, "give it a full order"):
 *   band 1  floor outlets, recent shows
 *   band 2  other recent shows
 *   band 3  floor outlets, historic shows
 *   band 4  the rest, by outlet tier (T1 > T2 > T3 > T4)
 * Inside a band a never-attempted gap goes before a retry.
 *
 * Backoff: a (review, strategy) pair that ended in no_evidence / rejected
 * (including fetch_error), or in a recovery that did not raise the tier,
 * waits BASE * 2^(n-1) hours (n = consecutive no-gain tries, capped), so it
 * never takes a slot two nights running. New evidence (the review's url
 * changed since the last try) or a reopen resets it.
 */
'use strict';

const { isMajorFulltextOutlet, isRecentProductionShow } = require('./outlet-fulltext');

const BACKOFF_BASE_H = 36; // > one night (the nightly starts ~24h apart, a try ends mid-run)
const BACKOFF_CAP_H = 21 * 24;
const NO_GAIN_OUTCOMES = new Set(['no_evidence', 'rejected']);
const INERT = new Set(['URL_FIND_PROBE']);
const ATTEMPT_OUTCOMES = new Set(['no_evidence', 'rejected', 'pending_push', 'recovered']);
// Only these strategies store the review's own url on their rows (URL_FIND / URL_REDISCOVER store the found link).
const STORED_URL_STRATEGIES = new Set(['REFETCH_FREE', 'ARCHIVE', 'PAID_FETCH', 'BROWSER_SESSION']);
// Identical-refetch proof: this many REFETCH_FREE refusals with the same fetched-text hash.
const IDENTICAL_REFETCH_PROOF = 2;
const NOT_LONGER_REASONS = new Set(['not_longer', 'not_materially_longer']);

const ms = (v) => { const t = Date.parse(v || ''); return Number.isFinite(t) ? t : 0; };

/** 1..4, see the header. Needs c.outletId and c.recency ('recent' | other). */
function bandOf(c) {
  const major = isMajorFulltextOutlet(c.outletId);
  const recent = c.recency === 'recent';
  // Band 1 is exactly what check-outlet-fulltext-floors counts (a major outlet on a 2025/26
  // production, BRO-7702); a major outlet on an older recent show is "other recent".
  const showId = String(c.showId || String(c.reviewKey || '').split('/')[0]);
  if (recent) return major && isRecentProductionShow(showId) ? 1 : 2;
  return major ? 3 : 4;
}

/** Attempt facts from a review's live ledger rows (already past the last reopen). */
function attemptFacts(liveRows) {
  // Only real tries: a browser_unavailable / auth_failed / vanished-file row is not an attempt.
  const rows = (liveRows || []).filter((r) => !INERT.has(r.strategy) && ATTEMPT_OUTCOMES.has(r.outcome));
  let lastTryMs = 0;
  for (const r of rows) lastTryMs = Math.max(lastTryMs, ms(r.ts));
  return { attempts: rows.length, lastTryMs };
}

/**
 * The candidate comparator. Candidate fields: recency, outletId, tier (number|null),
 * attempts, lastTryMs, showDate, strategy, reviewKey.
 * @param {{costOf?: (strategy:string|null)=>number}} [o]
 */
function compareByBand(o = {}) {
  const costOf = o.costOf || (() => 0);
  const tier = (c) => { const n = Number(c.tier); return Number.isFinite(n) && n > 0 ? n : 9; };
  return (a, b) => {
    const ba = bandOf(a); const bb = bandOf(b);
    if (ba !== bb) return ba - bb;
    const na = (a.attempts || 0) === 0; const nb = (b.attempts || 0) === 0;
    if (na !== nb) return na ? -1 : 1; // never attempted before retries
    if (ba === 4 && tier(a) !== tier(b)) return tier(a) - tier(b);
    if (!na && (a.lastTryMs || 0) !== (b.lastTryMs || 0)) return (a.lastTryMs || 0) - (b.lastTryMs || 0); // least recently tried first
    if (ms(a.showDate) !== ms(b.showDate)) return ms(b.showDate) - ms(a.showDate);
    const ca = costOf(a.strategy); const cb = costOf(b.strategy);
    if (ca !== cb) return ca - cb;
    return String(a.reviewKey).localeCompare(String(b.reviewKey));
  };
}

/** Consecutive trailing no-gain tries of `strategy` in a review's live rows. */
function noGainStreak(liveRows, strategy, { reviewUrl = null } = {}) {
  const mine = (liveRows || []).filter((r) => r.strategy === strategy);
  let n = 0; let last = null;
  for (let i = mine.length - 1; i >= 0; i--) {
    const r = mine[i];
    const noGain = NO_GAIN_OUTCOMES.has(r.outcome)
      || (r.outcome === 'recovered' && r.detail && r.detail.tierImproved === false);
    if (!noGain) {
      if (r.outcome === 'recovered') break; // a landed tier gain ends the chain
      if (r.outcome === 'pending_push') continue; // publication step of an attempt: neutral
      continue; // non-evidence (no browser, no key, vanished file): neither counts nor resets
    }
    if (!last) last = r;
    n++;
  }
  // New evidence: the stored url changed since the last failed try.
  if (last && reviewUrl && last.url && STORED_URL_STRATEGIES.has(strategy) && require('./url-change-invariant').urlCanonicallyChanged(last.url, reviewUrl)) return { n: 0, lastTs: null, newEvidence: true };
  return { n, lastTs: last ? last.ts : null, newEvidence: false };
}

function backoffHours(n, { baseH = BACKOFF_BASE_H, capH = BACKOFF_CAP_H } = {}) {
  if (n <= 0) return 0;
  return Math.min(capH, baseH * 2 ** (n - 1));
}

/**
 * Is (review, strategy) inside its backoff window?
 * @returns {{ok:boolean, reason:string, n:number, waitH:number}}
 */
function backoffGate(liveRows, strategy, { nowMs = Date.now(), reviewUrl = null, baseH = BACKOFF_BASE_H } = {}) {
  const { n, lastTs } = noGainStreak(liveRows, strategy, { reviewUrl });
  if (!n) return { ok: true, reason: 'no_backoff', n: 0, waitH: 0 };
  const waitH = backoffHours(n, { baseH });
  if (nowMs - ms(lastTs) < waitH * 3600e3) return { ok: false, reason: 'retry_backoff', n, waitH };
  return { ok: true, reason: 'backoff_elapsed', n, waitH };
}

/**
 * Two identical refetches are proof the text is complete: REFETCH_FREE refused
 * `not_longer` / `not_materially_longer` at least twice with the same hash of
 * the fetched text. Rows without a hash never count (no proof without one).
 */
function identicalRefetchProof(liveRows, { need = IDENTICAL_REFETCH_PROOF, reviewUrl = null } = {}) {
  const counts = new Map();
  const { urlCanonicallyChanged } = require('./url-change-invariant');
  for (const r of liveRows || []) {
    if (reviewUrl && r.url && urlCanonicallyChanged(r.url, reviewUrl)) continue; // proof belongs to the url it was fetched from
    if (r.strategy !== 'REFETCH_FREE' || r.outcome !== 'rejected' || !NOT_LONGER_REASONS.has(r.reason)) continue;
    const h = r.detail && r.detail.fetchedHash;
    if (h) counts.set(h, (counts.get(h) || 0) + 1);
  }
  for (const [hash, n] of counts) if (n >= need) return { ok: true, hash, n };
  return { ok: false, hash: null, n: 0 };
}


// BRO-7997: what a logged-in subscriber-browser read proves. Bright Data cannot
// log in, so once the subscriber browser has read this review's stored url the
// other routes add nothing:
//   complete    the browser's text equals the stored text (not_longer, equal
//               length, stored text unchanged since): the stored text IS the
//               article the subscriber sees. Close the gap, no escalation.
//   wrong_page  the browser read the stored url and it is not this show's
//               review (show_not_mentioned / wrong_article): re-fetching the
//               same url by any other route reads the same wrong page. Only a
//               new url (URL_FIND, then the browser on it) can help.
const SUBSCRIBER_WRONG_PAGE_REASONS = new Set(['show_not_mentioned', 'wrong_article']);
const sha16 = (t) => require('crypto').createHash('sha1').update(String(t || '').replace(/\s+/g, ' ').trim()).digest('hex').slice(0, 16);

/** True when the gate's not_longer message says both lengths are equal: "(2455 >= 2455)". */
function equalLengthNotLonger(code, reason) {
  if (code !== 'not_longer') return false;
  const m = /\((\d+) >= (\d+)\)/.exec(String(reason || ''));
  return !!m && m[1] === m[2];
}

/** Extra ledger detail for a BROWSER_SESSION gate refusal, so a later run can prove the above. */
function subscriberReadDetail({ code, reason, storedText }) {
  return { storedHash: sha16(storedText), ...(equalLengthNotLonger(code, reason) ? { equalToStored: true } : {}) };
}

/**
 * @returns {{kind:'complete'|'wrong_page'|null, ts:string|null}} from the review's
 * LATEST conclusive BROWSER_SESSION refusal at the stored url.
 */
function subscriberReadProof(liveRows, { reviewUrl = null, storedText = '' } = {}) {
  const { urlCanonicallyChanged } = require('./url-change-invariant');
  const mine = (liveRows || []).filter((r) => r.strategy === 'BROWSER_SESSION' && r.outcome === 'rejected' && r.url
    && !(reviewUrl && urlCanonicallyChanged(r.url, reviewUrl)));
  for (let i = mine.length - 1; i >= 0; i--) {
    const r = mine[i];
    if (r.reason === 'not_longer') {
      if (r.detail && r.detail.equalToStored && r.detail.storedHash === sha16(storedText)) return { kind: 'complete', ts: r.ts };
      continue; // a shorter browser text proves nothing
    }
    if (SUBSCRIBER_WRONG_PAGE_REASONS.has(r.reason)) return { kind: 'wrong_page', ts: r.ts };
  }
  return { kind: null, ts: null };
}

/** Retry vs new-item slot split over the work list (a retry has a live ledger row). */
function slotSplit(work) {
  let retry = 0; let fresh = 0;
  for (const c of work) { if ((c.attempts || 0) > 0) retry++; else fresh++; }
  return { retry, new: fresh };
}

/**
 * URL_FIND time slice. Each attempt runs 3-6 minutes for ~0% yield; once the
 * night's URL_FIND time passes the slice the rest wait for another night.
 */
// BRO-7986: the 15-min slice was sized for the 90-min nightly (a sixth of the
// run). A shorter run (a 20-min batch round) gets the same sixth, never more
// than 15 min; GAP_URL_FIND_SLICE_MIN set explicitly always wins. The run
// length is read exactly as gap-recovery-driver reads it (parseInt, 60 unset).
const URL_FIND_SLICE_MAX_MIN = 15;
const URL_FIND_SLICE_SHARE = 1 / 6;
function runBudgetMin(env = process.env) {
  return parseInt(env.TIME_BUDGET_MIN || '60', 10) || 60;
}
/**
 * @param {object} [env]
 * @param {{only?: string|null}} [opts]  the driver's --strategy filter: a run
 *   that does nothing but URL_FIND has no other strategy to share time with,
 *   so the slice is the whole run.
 */
function urlFindSliceMs(env = process.env, { only = null } = {}) {
  const raw = env.GAP_URL_FIND_SLICE_MIN;
  const n = Number(raw);
  if (raw != null && String(raw).trim() !== '' && Number.isFinite(n) && n >= 0) return n * 60000;
  if (only === 'URL_FIND') return runBudgetMin(env) * 60000;
  return Math.round(Math.min(URL_FIND_SLICE_MAX_MIN, runBudgetMin(env) * URL_FIND_SLICE_SHARE) * 60000);
}
/**
 * The slice opts for a run: URL_FIND gets the whole run when it is all the run
 * plans (--strategy=URL_FIND, or a --class whose items all plan URL_FIND).
 * Pure.
 */
function urlFindSliceOpts(work, only = null) {
  const all = only === 'URL_FIND' || (Array.isArray(work) && work.length > 0 && work.every((c) => c && c.strategy === 'URL_FIND'));
  return { only: all ? 'URL_FIND' : only };
}
function urlFindSliceExhausted(spentMs, env = process.env, opts = {}) {
  return spentMs >= urlFindSliceMs(env, opts);
}

/**
 * BRO-7943: group the run's BROWSER_SESSION items by adapter. Every adapter
 * session holds the one cookie-renew lock, so the driver closes one before it
 * opens another; four nightly adapters share a band, so one show's gaps came
 * out as ft, telegraph, thestage, times and each switch relaunched Chrome and
 * re-ran the auth probe. Only browser items move, and only among the slots
 * browser items already held: non-browser items keep their places, and
 * within an adapter the priority order is kept. Adapters go in the order of
 * their first item, inside each (band, fresh/retry) partition. Apply after --limit.
 * @param {Array<{strategy:string}>} work
 * @param {(c:object)=>string|null} adapterNameOf
 * @returns {Array} a new array
 */
function groupBrowserSessions(work, adapterNameOf) {
  // Grouping stays inside a priority partition (band, fresh vs retry): a run
  // that stops early on its time budget or ceiling must not have spent it on a
  // historic retry pulled forward past a fresh band-1 gap (review).
  const partOf = (c) => `${bandOf(c)}:${(c.attempts || 0) > 0 ? 'retry' : 'fresh'}`;
  const slots = [];
  const items = [];
  const partFirst = new Map();
  const groupFirst = new Map();
  work.forEach((c, i) => {
    if (c.strategy !== 'BROWSER_SESSION') return;
    const p = partOf(c);
    const g = `${p}|${adapterNameOf(c) || ''}`;
    if (!partFirst.has(p)) partFirst.set(p, i);
    if (!groupFirst.has(g)) groupFirst.set(g, i);
    slots.push(i);
    items.push({ c, i, p: partFirst.get(p), g: groupFirst.get(g) });
  });
  const ordered = items.sort((x, y) => x.p - y.p || x.g - y.g || x.i - y.i).map((x) => x.c);
  const out = work.slice();
  slots.forEach((slot, j) => { out[slot] = ordered[j]; });
  return out;
}

module.exports = {
  groupBrowserSessions,
  bandOf, attemptFacts, compareByBand, noGainStreak, backoffHours, backoffGate, identicalRefetchProof, subscriberReadProof, subscriberReadDetail, equalLengthNotLonger,
  slotSplit, urlFindSliceMs, urlFindSliceExhausted, urlFindSliceOpts, runBudgetMin,
  BACKOFF_BASE_H, BACKOFF_CAP_H, IDENTICAL_REFETCH_PROOF,
};
