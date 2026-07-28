'use strict';

const fs = require('fs');
const path = require('path');
const { routeAlert, resolveCondition } = require('./owner-alert-router');

const DEFAULT_LOG = path.join(__dirname, '../../data/audit/stage-latency.jsonl');

const SLA_STATE_PATH = process.env.OPENING_NIGHT_SLA_STATE
  || path.join(__dirname, '../../data/audit/opening-night-sla-state.json');

// Stable per-incident keys for the owner-alert-router.
const SLA_PAGE_CONDITION = 'opening-night-sla:pages-stuck';
const SLA_WARN_CONDITION = 'opening-night-sla:warnings-delayed';

// Per-reviewKey terminal stages: a review that reached either is done from the
// SLA's perspective (scoring is the deliverable; a per-key deploy stamp is the
// strongest signal). NOTE: 'deployed-live' is almost always emitted per-SHOW
// (no reviewKey, see below) — it appears here only for the rare per-key case.
const PER_KEY_TERMINAL = ['scored', 'deployed-live'];

// Show-level terminal stages are emitted ONCE PER REBUILD/DEPLOY for the whole
// show, WITHOUT a reviewKey. A rebuild or deploy at/after a review's first-seen
// means that review was folded into the live site — even when its own per-key
// 'scored' stamp was never emitted (scoring instrumentation is incomplete on
// some paths; e.g. reviews scored at collect-time via LLM never emit 'scored').
// THIS IS THE FIX for the 2026-07-24 false-page storm: the old code only looked
// for 'deployed-live' PER reviewKey, but it is never emitted that way, so NO
// review could ever clear and every review-first-seen counted as "stuck ≥60 min"
// forever (15→29 growth = test fixtures + historical backfills accumulating in
// the log, not a real pipeline stall).
//
// KNOWN TRADE-OFF (ship-check 2026-07-24, both reviewers): 'rebuilt' fires for
// the whole show every ~30 min regardless of which reviews it includes, so this
// terminal cannot tell "this specific review went live" from "the show rebuilt".
// A review that arrived but is excluded/unscored still clears on the next
// rebuild. That is DELIBERATE — this SLA's job is opening-night PIPELINE
// liveness (are reviews arriving AND is the show rebuilding to fold them in?),
// which caught 6 of 8 recent whole-pipeline stalls. The per-review cases it
// intentionally defers are already covered elsewhere: includable-but-unscored
// by verify-all-scored.js → orphan-unscored self-heal (#356); silent per-review
// drops by opening-night-completeness-check.yml / analyze-rebuild-drops.js;
// excluded reviews should not page at all. A reliable per-review deploy signal
// would need instrumentation work — tracked as a follow-up, not this P0.
const SHOW_LEVEL_TERMINAL = new Set(['rebuilt', 'deployed-live']);

// Synthetic/fixture show IDs that leak into the prod stage-latency log from CI
// unit tests (review-file-writer emits review-first-seen unconditionally). They
// are never real opening-night shows, so they must never page. Primary defense
// is activeShowIds scoping (below); this is belt-and-suspenders for when the
// SLA runs without a checklist to scope against.
const TEST_SHOW_ID = /^(test-|merge-show|fs-show|fsm-show|guard-[a-z0-9]+-)/i;
function isTestShowId(showId) {
  return TEST_SHOW_ID.test(String(showId || ''));
}

/**
 * Read stage-latency.jsonl and find reviews that are stuck mid-pipeline.
 *
 * A review is "in-flight" if it has review-first-seen but has NOT reached a
 * terminal stage — neither a per-key `scored`/`deployed-live`, NOR a show-level
 * `rebuilt`/`deployed-live` at or after its first-seen.
 *
 * @param {object[]} latencyEntries  - parsed JSONL lines from stage-latency.jsonl
 * @param {object}   opts
 * @param {number}   [opts.warningMinutes=30]
 * @param {number}   [opts.pageMinutes=60]
 * @param {Date}     [opts.now]
 * @param {string[]|Set<string>|null} [opts.activeShowIds]
 *        When provided (e.g. the opening-night checklist's shows), ONLY reviews
 *        for those shows are considered — this scopes the SLA to shows we are
 *        actively shepherding and excludes test fixtures + historical backfills.
 *        When null/undefined, falls back to excluding obvious CI test fixtures.
 * @returns {{ warnings: object[], pages: object[] }}
 */
function evaluateSlaForReviews(latencyEntries, { warningMinutes = 30, pageMinutes = 60, now = new Date(), activeShowIds = null } = {}) {
  const activeSet = activeShowIds
    ? (activeShowIds instanceof Set ? activeShowIds : new Set(activeShowIds))
    : null;

  // Latest show-level terminal timestamp per show (rebuilt/deployed-live w/o key).
  const showTerminalAt = new Map();
  for (const e of latencyEntries) {
    if (!e || !e.showId || e.reviewKey) continue;
    if (!SHOW_LEVEL_TERMINAL.has(e.stage)) continue;
    const prev = showTerminalAt.get(e.showId);
    if (!prev || e.at > prev) showTerminalAt.set(e.showId, e.at);
  }

  // Per-reviewKey stage map (earliest timestamp per stage).
  const byKey = new Map();
  for (const e of latencyEntries) {
    if (!e || !e.reviewKey || !e.showId) continue;
    const k = `${e.showId}||${e.reviewKey}`;
    if (!byKey.has(k)) byKey.set(k, { showId: e.showId, reviewKey: e.reviewKey, stages: {} });
    const entry = byKey.get(k);
    if (!entry.stages[e.stage] || e.at < entry.stages[e.stage]) {
      entry.stages[e.stage] = e.at;
    }
  }

  const warnings = [];
  const pages = [];

  for (const [, rv] of byKey) {
    const firstSeen = rv.stages['review-first-seen'];
    if (!firstSeen) continue; // not a tracked review

    // Scope: only shows we're actively shepherding (opening-night checklist).
    // Without a scope list, fall back to excluding obvious CI test fixtures.
    if (activeSet) {
      if (!activeSet.has(rv.showId)) continue;
    } else if (isTestShowId(rv.showId)) {
      continue;
    }

    // Delivered? per-key terminal stage OR a show-level rebuild/deploy at or
    // after this review's first-seen.
    const perKeyDone = PER_KEY_TERMINAL.some(s => rv.stages[s]);
    const showDoneAt = showTerminalAt.get(rv.showId);
    const showDone = !!showDoneAt && showDoneAt >= firstSeen;
    if (perKeyDone || showDone) continue;

    const elapsedMin = Math.floor((now - new Date(firstSeen)) / 60000);
    const outletId = rv.reviewKey.split(':')[0] || 'unknown';
    const item = { reviewKey: rv.reviewKey, showId: rv.showId, outletId, elapsedMin };

    if (elapsedMin >= pageMinutes) pages.push(item);
    else if (elapsedMin >= warningMinutes) warnings.push(item);
  }

  warnings.sort((a, b) => b.elapsedMin - a.elapsedMin);
  pages.sort((a, b) => b.elapsedMin - a.elapsedMin);

  return { warnings, pages };
}

function loadSlaState(statePath = SLA_STATE_PATH) {
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    if (parsed && typeof parsed === 'object') return parsed;
  } catch { /* missing/corrupt — fresh */ }
  return {};
}

function saveSlaState(state, statePath = SLA_STATE_PATH) {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  const tmp = `${statePath}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n');
  fs.renameSync(tmp, statePath);
}

/**
 * Route SLA breaches through the owner-alert-router (single funnel, dedup,
 * resolve-on-drain) instead of emailing raw. Migrated 2026-07-24 — the old
 * path called sendAlert({email:true}) directly and fired one email every
 * checklist run (7 unrouted/undeduped pages in a single opening window).
 *
 * Semantics:
 *   - PAGES (≥60 min): disposition 'human' (email). ONE email per open
 *     incident. A count that GROWS past the last-notified peak is a state
 *     change worth one re-notify (resolve → re-open). Resolves (and the next
 *     occurrence notifies fresh) the moment the count drains to 0.
 *   - WARNINGS (≥30 min): disposition 'digest' (queued for the daily digest,
 *     never its own email).
 *
 * @param {{ warnings: object[], pages: object[] }} slaResult
 * @param {object} opts
 * @param {boolean}  [opts.dryRun=false]
 * @param {function} [opts.route=routeAlert]          injectable for tests
 * @param {function} [opts.resolve=resolveCondition]  injectable for tests
 * @param {string}   [opts.statePath]                 injectable for tests
 */
async function dispatchSlaAlerts({ warnings, pages }, { dryRun = false, route = routeAlert, resolve = resolveCondition, statePath = SLA_STATE_PATH } = {}) {
  if (dryRun) {
    if (warnings.length) console.log(`[SLA dry-run] ${warnings.length} warning(s):`, warnings.map(w => `${w.showId}/${w.outletId} (${w.elapsedMin}m)`).join(', '));
    if (pages.length) console.log(`[SLA dry-run] ${pages.length} page(s):`, pages.map(p => `${p.showId}/${p.outletId} (${p.elapsedMin}m)`).join(', '));
    if (!warnings.length && !pages.length) console.log('[SLA dry-run] no breaches');
    return;
  }

  // --- Warnings → digest (no email) ---
  if (warnings.length > 0) {
    const list = warnings.map(w => `• ${w.showId} / ${w.outletId} — ${w.elapsedMin} min in-flight`).join('\n');
    await route({
      conditionKey: SLA_WARN_CONDITION,
      title: `Opening Night SLA Warning — ${warnings.length} review(s) delayed`,
      description: `Reviews in the pipeline for ≥30 min without deploying:\n${list}`,
      severity: 'warning',
      disposition: 'digest',
    }).catch(e => console.error('[SLA] warning route failed:', e.message));
  } else {
    // Resolve the warn condition when the warning set clears — otherwise the
    // router keeps it "open" and a fresh batch of delayed reviews within the
    // 7-day cooldown produces no new digest line (ship-check finding #2).
    resolve(SLA_WARN_CONDITION);
  }

  // --- Pages → human (email), dedup + growth-aware re-notify + resolve-on-drain ---
  const state = loadSlaState(statePath);
  const prevNotified = state.notifiedPageCount || 0;

  if (pages.length === 0) {
    const wasOpen = resolve(SLA_PAGE_CONDITION);
    if (prevNotified > 0 || wasOpen) {
      saveSlaState({ notifiedPageCount: 0, resolvedAt: new Date().toISOString() }, statePath);
      console.log('[SLA] page incident resolved — 0 reviews stuck.');
    }
    return;
  }

  // Count grew past the last-notified peak → treat as a NEW state worth one
  // re-notify: resolve the open incident so routeAlert re-emails immediately.
  if (pages.length > prevNotified && prevNotified > 0) {
    resolve(SLA_PAGE_CONDITION);
  }

  const list = pages.map(p => `• ${p.showId} / ${p.outletId} — ${p.elapsedMin} min in-flight`).join('\n');
  const res = await route({
    conditionKey: SLA_PAGE_CONDITION,
    title: `Opening Night SLA P0 — ${pages.length} review(s) stuck ≥60 min`,
    description: `Reviews stuck in the pipeline for ≥60 min:\n${list}\n\nThis alert auto-resolves when the count drains to 0.`,
    severity: 'error',
    disposition: 'human',
    fields: [{ name: 'Stuck reviews', value: String(pages.length) }],
    // Incident lifecycle is governed by resolve-on-drain + resolve-on-growth
    // above; make the router's time-based cooldown a non-factor (an opening
    // window is ~2 days, so the 168h default would never fire anyway — but be
    // explicit so a persisting incident can't surprise-re-email). ship-check #2.
    cooldownHours: 24 * 30,
  }).catch(e => { console.error('[SLA] page route failed:', e.message); return { action: 'error' }; });

  // Advance the notified peak when the owner was actually told: either a
  // real email went out (action:'human', delivery didn't fail) or the
  // request was downgraded to a digest queue entry (page-worthy gate, card
  // #611) — both are non-silent notifications under routeAlert's own
  // contract. This MUST include 'digest': routeAlert records the condition
  // 'open' with THIS call's cooldownHours (24*30 = 720h) regardless of
  // which disposition actually fired, so if the peak were left at 0 on a
  // digest downgrade, `pages.length > prevNotified && prevNotified > 0`
  // above could never go true (prevNotified stuck at 0), the incident would
  // never resolve-and-reopen, and every subsequent call would come back
  // 'silent' from the ledger's own cooldown for up to 30 days instead of
  // re-queuing a digest line on the next check (adversarial-review find,
  // card #616 follow-up — a prior version of this comment claimed the
  // re-queue happened; traced through owner-alert-router.js and confirmed
  // it did not). On a Resend/policy failure routeAlert still returns
  // action:'human' with delivered:false and does NOT record its ledger, so
  // it retries next run — we must not advance the peak past a page nobody
  // received (ship-check finding #4). A 'silent' refire (incident open, not
  // growing) also leaves the peak unadvanced, same as before.
  if (res && (res.action === 'digest' || (res.action === 'human' && res.delivered !== false))) {
    saveSlaState({ notifiedPageCount: pages.length, lastNotifiedAt: new Date().toISOString() }, statePath);
  }
}

module.exports = {
  evaluateSlaForReviews,
  dispatchSlaAlerts,
  isTestShowId,
  loadSlaState,
  SLA_PAGE_CONDITION,
  SLA_WARN_CONDITION,
  _DEFAULT_LOG: DEFAULT_LOG,
  _SLA_STATE_PATH: SLA_STATE_PATH,
};
