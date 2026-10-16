'use strict';

const fs = require('fs');
const path = require('path');
const { routeAlert, resolveCondition, loadLedger } = require('./owner-alert-router');
const { reviewIdentity, excludedReviewIdentities, latestShowHeldAt, isShowHeld } = require('./stage-latency');

const DEFAULT_LOG = path.join(__dirname, '../../data/audit/stage-latency.jsonl');

const SLA_STATE_PATH = process.env.OPENING_NIGHT_SLA_STATE
  || path.join(__dirname, '../../data/audit/opening-night-sla-state.json');

// Stable per-incident keys for the owner-alert-router.
const SLA_PAGE_CONDITION = 'opening-night-sla:pages-stuck';
// BRO-5480: one condition per stuck show. The bare SLA_PAGE_CONDITION is the
// pre-BRO-5480 shared key; isSlaPageKey() still matches it so an incident left
// open under it resolves.
const slaPageKey = (showId) => `${SLA_PAGE_CONDITION}:${showId}`;
const isSlaPageKey = (key) => key === SLA_PAGE_CONDITION || String(key || '').startsWith(`${SLA_PAGE_CONDITION}:`);
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
// excluded reviews should not page at all (rebuild emits a per-review
// 'excluded' terminal for those, see stage-latency.js TERMINAL_EXCLUSION_REASONS). A reliable per-review deploy signal
// would need instrumentation work — tracked as a follow-up, not this P0.
const SHOW_LEVEL_TERMINAL = new Set(['rebuilt', 'deployed-live']);

/**
 * Turn the checklist output into an SLA scope, or say the scope is unknown.
 *
 * known:false means "we cannot tell which shows are live tonight", and the
 * caller must then neither page NOR resolve. Resolving on an unknown scope is
 * what sent the owner a duplicate P0 on 2026-10-15: opening-night-orchestrator
 * ran the dispatcher after its checklist crashed, the empty scope resolved the
 * open incident, and the next hourly run re-opened it and emailed again
 * (BRO-5427). A real checklist run always stamps generatedAt, including the
 * legitimate zero-shows path, so a payload without it is not a real run.
 *
 * @param {object|null} checklistData
 * @param {{ filtered?: boolean }} [opts] filtered: the checklist ran with --show
 * @returns {{ known: boolean, activeShowIds: string[], why?: string }}
 */
function resolveSlaScope(checklistData, { filtered = false } = {}) {
  // A --show=ID run (manual workflow_dispatch) sees one show, or none on a
  // typo; either way it cannot speak for the night, so it must not resolve.
  if (filtered) {
    return { known: false, activeShowIds: [], why: 'checklist was filtered to one show (--show)' };
  }
  if (!checklistData || typeof checklistData !== 'object') {
    return { known: false, activeShowIds: [], why: 'checklist JSON missing/unparseable' };
  }
  if (!checklistData.generatedAt || !Array.isArray(checklistData.shows)) {
    return { known: false, activeShowIds: [], why: 'checklist JSON lacks generatedAt/shows (not a real checklist run)' };
  }
  const ids = checklistData.shows
    .map(s => (s && s.show && (s.show.id || s.show.showId)) || (s && (s.showId || s.id)))
    .filter(Boolean);
  if (checklistData.shows.length > 0 && ids.length === 0) {
    return { known: false, activeShowIds: [], why: `checklist has ${checklistData.shows.length} show(s) but 0 extractable IDs (schema drift)` };
  }
  return { known: true, activeShowIds: ids };
}

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
  //
  // A terminal must carry a showId. rebuild-all-reviews also emits one
  // showId-less 'rebuilt' line per run for run-level visibility (task #388,
  // when the per-show loop was scoped down from ~1,210 lines to the tracked
  // shows) — that line is DELIBERATELY not a terminal here. It says a rebuild
  // happened, not that it covered this show: per-show lines only ever existed
  // for shows with ≥1 review in reviews.json, so a show whose first review is
  // still unscored has none, and its review must keep counting as in-flight.
  // At the time of that change 2 of the 13 shows with review-first-seen events
  // in the log had never appeared in a 'rebuilt' line — treating the global
  // line as a terminal would have silently cleared exactly the case this SLA
  // exists to catch: a brand-new opening's first review going nowhere.
  const showTerminalAt = new Map();
  for (const e of latencyEntries) {
    if (!e || !e.showId || e.reviewKey) continue;
    if (!SHOW_LEVEL_TERMINAL.has(e.stage)) continue;
    const prev = showTerminalAt.get(e.showId);
    if (!prev || e.at > prev) showTerminalAt.set(e.showId, e.at);
  }

  // Reviews the rebuild deliberately excluded as not-a-review-of-this-show.
  const excludedIds = excludedReviewIdentities(latencyEntries);
  // Shows rebuild is still holding back as not yet open (BRO-5480).
  const heldAt = latestShowHeldAt(latencyEntries);

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
    if (excludedIds.size && excludedIds.has(reviewIdentity(rv.showId, rv.reviewKey))) continue;
    if (isShowHeld(heldAt.get(rv.showId), firstSeen, now)) continue;

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
 *   - PAGES (≥60 min): one PARKED Linear card per stuck show (disposition
 *     'auto', key `opening-night-sla:pages-stuck:<showId>`), NOT an owner
 *     email (BRO-5480). Owner rule BRO-4603: email only when urgent AND the
 *     owner must act; a stuck review has no owner action. Parked, not
 *     dispatch-at-filing: sweep-resolved-alert-cards.js (daily CI) cancels a
 *     parked card once its condition resolves, with no Mac dependency, and
 *     upstream self-heals (orphan-unscored, verify-all-scored) usually fix the
 *     stall first. A show's key resolves the moment it has no stuck review;
 *     any other open key of this family (including the pre-BRO-5480 shared
 *     key, which carried the 'human' email disposition) resolves too.
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
async function dispatchSlaAlerts({ warnings, pages }, { dryRun = false, route = routeAlert, resolve = resolveCondition, statePath = SLA_STATE_PATH, readLedger = loadLedger } = {}) {
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

  // --- Pages → one parked worker card per stuck show (never an owner email) ---
  const byShow = new Map();
  for (const p of pages) {
    if (!byShow.has(p.showId)) byShow.set(p.showId, []);
    byShow.get(p.showId).push(p);
  }
  const liveKeys = new Set([...byShow.keys()].map(slaPageKey));

  // Resolve every open key of this family that has no stuck review now.
  let ledger = {};
  try { ledger = (readLedger() || {}); } catch (e) { console.error('[SLA] ledger read failed:', e.message); }
  const conds = ledger.conditions || ledger;
  let resolvedAny = false;
  for (const [key, c] of Object.entries(conds || {})) {
    if (!isSlaPageKey(key) || liveKeys.has(key) || !c || c.status !== 'open') continue;
    resolve(key);
    resolvedAny = true;
  }
  if (resolvedAny) console.log('[SLA] resolved stuck-review incident(s) that drained.');

  for (const [showId, items] of byShow) {
    const list = items.map(p => `• ${p.outletId} — ${p.elapsedMin} min in-flight (${p.reviewKey})`).join('\n');
    const res = await route({
      conditionKey: slaPageKey(showId),
      title: `Opening-night reviews stuck ≥60 min: ${showId} (${items.length})`,
      description: `Reviews for ${showId} stuck in the pipeline for ≥60 min during its opening-night window (first seen, never scored, excluded or folded into a rebuild):\n${list}\n\n`
        + `\`node scripts/verify-review-recovery.js --show=${showId} --production\` names the broken step and its fix command; `
        + `\`node scripts/rebuild-all-reviews.js --show=${showId}\` prints why a file is excluded. Junk (wrong show, news item, listing page) should be excluded by rebuild, which emits an 'excluded' stage and clears it here (BRO-5427). `
        + `This condition resolves on its own when the show has no stuck review, and the card is then cancelled if nobody touched it.`,
      severity: 'error',
      disposition: 'auto',
      fields: [{ name: 'Stuck reviews', value: String(items.length) }],
      // Lifecycle is resolve-on-drain; keep the time-based cooldown from
      // refiling a second card for the same open incident.
      cooldownHours: 24 * 30,
    }).catch(e => { console.error(`[SLA] page route failed for ${showId}:`, e.message); return { action: 'error' }; });
    if (res && res.action === 'auto' && res.dispatchOk === false) {
      console.error(`[SLA] card filing failed for ${showId}: ${res.dispatchError || 'unknown'} (retries next run)`);
    }
  }
  // Write only on change: the state file is committed by the hourly workflow.
  const stuckShows = [...byShow.keys()].sort();
  const prev = loadSlaState(statePath);
  if (JSON.stringify(prev.stuckShows || []) !== JSON.stringify(stuckShows)) {
    saveSlaState({ stuckShows, updatedAt: new Date().toISOString() }, statePath);
  }
}

module.exports = {
  evaluateSlaForReviews,
  dispatchSlaAlerts,
  isTestShowId,
  loadSlaState,
  resolveSlaScope,
  SLA_PAGE_CONDITION,
  slaPageKey,
  isSlaPageKey,
  SLA_WARN_CONDITION,
  _DEFAULT_LOG: DEFAULT_LOG,
  _SLA_STATE_PATH: SLA_STATE_PATH,
};
