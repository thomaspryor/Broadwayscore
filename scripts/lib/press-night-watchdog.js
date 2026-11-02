'use strict';
/**
 * press-night-watchdog.js (BRO-6858): the old-path press-night watchdog's decisions. Pure: no network, no clock.
 *
 * Audit (BRO-6858): no Broadway press night has come in on its own. A Few Good Men 10-29 went first-live at +100 min,
 * and on every measured night a found review file took 45-65 min to reach the site. Nothing watched the old path
 * between ticks. scripts/press-night-watchdog.js runs one tick every ~10 min from the embargo to +3h; each tick
 * gathers state (review files, core reviews.json, the live show JSON, recent workflow runs) and asks evaluateTick
 * what to do. This module never decides "slow"; it only acts on "stalled": a found review that is not live while
 * nothing that would move it is queued or running.
 *
 * A found review is an includable review-text file of the night (rebuild's own predicate via press-night-review-state,
 * first seen inside the night window, DEFAULT_GATES.nightStartH before the embargo). Its stage is where it is stuck:
 *   score   - no LLM score yet                      -> llm-ensemble-score.yml for the show
 *   rebuild - scored, not in core reviews.json      -> rebuild-fast.yml
 *   deploy  - in core reviews.json, not on the site -> vercel-deploy.yml (its documented opening-night "ship NOW" path)
 * A scored file still absent from reviews.json after a rebuild finished later than its score is one the rebuild drops
 * (dedup, census exclusions): not found, never retried, never paged (second-opinion blocker 3).
 *
 * Each stage is re-dispatched at most once per night (the CLI holds a lease-store claim per stage, so a re-run or a
 * second watchdog cannot dispatch it again), only when no run that moves that stage is active, and only after the
 * review has been found STALL_MIN. The owner is paged (press-night:stuck:, page-worthy) only when a review is still
 * stalled a tick after the watchdog's own retry went out, so a slow but moving pipeline never pages.
 *
 * No pipeline: inside [embargo, embargo+2h], with no orchestrator or poller run for the show active and the broadcast
 * not done, dispatch the targeted orchestrator once. That claim uses the lane watchdog's own fallback key
 * (auto-fallback leaseKey show|night on its branch), so the two watchdogs start the old path once between them.
 * A clean orchestrator exit ("all shows broadcast", its deadline) is not a stall: with nothing found-and-not-live,
 * no page.
 *
 * Lane-only nights (LANE_ONLY_MARKETS covers the show, LANE_STANDDOWN does not) belong to the lane and its watchdog:
 * this one observes only (second-opinion blocker 4).
 */

const MIN = 60000;
const STALL_MIN = 15; // card: owner hears within 15 min of a found review not going live
const NIGHT_START_H = 4; // = press-night-record DEFAULT_GATES.nightStartH
const PIPELINE_WINDOW_MIN = 120; // the no-pipeline rule covers the first 2h after the embargo
const ACTIVE = new Set(['queued', 'in_progress', 'pending', 'waiting', 'requested']);

const STAGES = {
  score: { workflow: 'llm-ensemble-score.yml' },
  rebuild: { workflow: 'rebuild-fast.yml' },
  deploy: { workflow: 'vercel-deploy.yml' },
};

const foldKey = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z]/g, '');
const toMs = (t) => (t == null || t === '' ? NaN : typeof t === 'number' ? t : Date.parse(t));

/** Is this run about the show? Orchestrator/poller/scoring titles name it; rebuild-fast and vercel-deploy are global. */
function runIsForShow(run, showId) {
  const wf = run.workflow;
  if (wf === 'rebuild-fast.yml' || wf === 'vercel-deploy.yml') return true;
  const title = String(run.displayTitle || '');
  if (wf === 'opening-night-orchestrator.yml') {
    if (/ targeted /.test(title)) return title.includes(` ${showId} `) || title.endsWith(` ${showId}`);
    return !/\(west-end\)|\(off-west-end\)/.test(title); // the cron run of another market polls none of ours
  }
  // Poller "Opening Night Poller — <id>|auto", scoring "LLM Ensemble Score Reviews[ — <ids>]": an untargeted run covers all.
  const m = /—\s*(.+)$/.exec(title);
  return !m || m[1].trim() === 'auto' || m[1].split(',').map((x) => x.trim()).includes(showId);
}

/** Workflows whose active run counts as moving a review in each stage (the poller scores, rebuilds and deploys inline). */
const MOVERS = {
  score: ['opening-night-poller.yml', 'llm-ensemble-score.yml'],
  rebuild: ['opening-night-poller.yml', 'llm-ensemble-score.yml', 'rebuild-fast.yml'],
  deploy: ['opening-night-poller.yml', 'rebuild-fast.yml', 'vercel-deploy.yml'],
  pipeline: ['opening-night-orchestrator.yml', 'opening-night-poller.yml'],
};

function activeFor(kind, runs, showId) {
  return (runs || []).some((r) => MOVERS[kind].includes(r.workflow) && ACTIVE.has(r.status) && runIsForShow(r, showId));
}

/**
 * Start of the latest successful run of `workflow` for the show, or NaN. Start, not finish: a rebuild that began
 * before a review was scored can finish after it without containing it, which is not a drop.
 */
function lastSuccessMs(workflow, runs, showId) {
  let best = NaN;
  for (const r of runs || []) {
    if (r.workflow !== workflow || r.conclusion !== 'success' || !runIsForShow(r, showId)) continue;
    const ms = toMs(r.startedAt || r.createdAt);
    if (Number.isFinite(ms) && !(ms <= best)) best = ms;
  }
  return best;
}

/**
 * The night's found reviews with their stage. `coreRows` = core reviews.json rows of the show ({outletId|outlet,
 * criticName}); `liveRows` = the live show JSON's `rv` rows ({o, cn}); `normOutlet` maps an outlet name to its id.
 */
function foundReviews({ files, coreRows, liveRows, runs, showId, embargoMs, nowMs, normOutlet }) {
  const startMs = embargoMs - NIGHT_START_H * 60 * MIN;
  const key = (oid, critic) => `${oid}|${foldKey(critic)}`;
  const core = new Set();
  const coreOutlets = new Set();
  for (const r of coreRows || []) {
    const oid = r.outletId || normOutlet(r.outlet);
    core.add(key(oid, r.criticName)); coreOutlets.add(oid);
  }
  const live = new Set();
  const liveOutlets = new Set();
  for (const r of liveRows || []) {
    const oid = normOutlet(r.o);
    live.add(key(oid, r.cn)); liveOutlets.add(oid);
  }
  const rebuiltMs = lastSuccessMs('rebuild-fast.yml', runs, showId);
  const out = [];
  const seen = new Set();
  for (const f of files || []) {
    if (!f || !f.includable || !f.outletId) continue;
    const seenMs = toMs(f.firstSeenAt);
    if (!Number.isFinite(seenMs) || seenMs < startMs || seenMs > nowMs) continue;
    const k = key(f.outletId, f.critic);
    if (seen.has(k)) continue;
    seen.add(k);
    // A critic name can differ between the file and the site (initials, a co-byline): fall back to the outlet.
    const isLive = live.has(k) || (!f.critic && liveOutlets.has(f.outletId));
    const inCore = core.has(k) || (!f.critic && coreOutlets.has(f.outletId));
    const scoredMs = toMs(f.scoredAt);
    let stage = null;
    if (!isLive) {
      if (inCore) stage = 'deploy';
      else if (!Number.isFinite(scoredMs)) stage = 'score';
      else if (Number.isFinite(rebuiltMs) && rebuiltMs > scoredMs + 2 * MIN) stage = 'dropped';
      else stage = 'rebuild';
    }
    // Found = when it was first seen, or the embargo for a file seen before it (an early publish waits for the embargo).
    out.push({ key: k, outletId: f.outletId, critic: f.critic || null, live: isLive, stage, foundMs: Math.max(seenMs, embargoMs) });
  }
  return out;
}

/**
 * One tick. `state` carries across ticks ({retried:{stage:atMs}, orchestratorAt, paged:{key:true}}) and is returned
 * updated. Returns {actions:[{type:'dispatch',stage}|{type:'dispatch-orchestrator'}|{type:'page',key,reason,stalled}|
 * {type:'resolve'}], found, summary, state}.
 */
function evaluateTick({ showId, embargoMs, nowMs, files, coreRows, liveRows, runs, broadcastDone = false,
  laneOwnsNight = false, state = {}, normOutlet }) {
  const st = { retried: { ...(state.retried || {}) }, orchestratorAt: state.orchestratorAt || null, paged: { ...(state.paged || {}) } };
  const actions = [];
  const found = foundReviews({ files, coreRows, liveRows, runs, showId, embargoMs, nowMs, normOutlet });
  const pending = found.filter((f) => !f.live && f.stage !== 'dropped' && f.foundMs <= nowMs);
  const stalled = pending.filter((f) => nowMs - f.foundMs >= STALL_MIN * MIN && !activeFor(f.stage, runs, showId));
  const pipelineActive = activeFor('pipeline', runs, showId);
  const minutes = (ms) => Math.round((nowMs - ms) / MIN);
  const summary = {
    at: new Date(nowMs).toISOString(), sinceEmbargoMin: minutes(embargoMs), found: found.length,
    live: found.filter((f) => f.live).length, pending: pending.map((f) => `${f.outletId}:${f.stage}:${minutes(f.foundMs)}m`),
    dropped: found.filter((f) => f.stage === 'dropped').map((f) => f.outletId),
    stalled: stalled.map((f) => `${f.outletId}:${f.stage}`), pipelineActive, laneOwnsNight, broadcastDone,
  };
  if (nowMs < embargoMs) return { actions, found, summary, state: st };
  if (laneOwnsNight) { summary.note = 'lane-only night: observing only'; return { actions, found, summary, state: st }; }

  // Retry each stalled stage once per night.
  for (const stage of new Set(stalled.map((f) => f.stage))) {
    if (st.retried[stage] == null) { actions.push({ type: 'dispatch', stage }); st.retried[stage] = nowMs; }
  }
  // No pipeline in the first 2h, broadcast not done: start the targeted orchestrator once.
  const inWindow = nowMs - embargoMs <= PIPELINE_WINDOW_MIN * MIN;
  if (inWindow && !pipelineActive && !broadcastDone && st.orchestratorAt == null) {
    actions.push({ type: 'dispatch-orchestrator' }); st.orchestratorAt = nowMs;
  }
  // Page: still stalled a full tick after this watchdog's own retry of that stage (the retry did not move it).
  const afterRetry = stalled.filter((f) => st.retried[f.stage] != null && nowMs - st.retried[f.stage] >= 8 * MIN);
  const noPipeline = inWindow && !pipelineActive && !broadcastDone && st.orchestratorAt != null
    && nowMs - st.orchestratorAt >= STALL_MIN * MIN && pending.length > 0;
  if ((afterRetry.length || noPipeline) && !st.paged.stuck) {
    const reason = afterRetry.length
      ? `${afterRetry.length} found review(s) not on the site and not moving after the watchdog's retry: ${afterRetry.slice(0, 6).map((f) => `${f.outletId} (${f.stage}, found ${minutes(f.foundMs)} min ago)`).join(', ')}`
      : `no orchestrator or poller run for the show ${minutes(st.orchestratorAt)} min after the watchdog started one, with ${pending.length} review(s) waiting`;
    actions.push({ type: 'page', reason, stalled: afterRetry.map((f) => f.outletId) });
    st.paged.stuck = nowMs;
  }
  if (st.paged.stuck && !st.paged.resolved && pending.length === 0) { actions.push({ type: 'resolve' }); st.paged.resolved = nowMs; }
  return { actions, found, summary, state: st };
}

/**
 * An action the CLI did not really send (blind tick, failed claim write, failed dispatch or page) must not spend its
 * once-per-night slot: put back the state key that action set, from the state before the tick.
 */
function undoUnsent(prev, next, action) {
  const p = prev || {};
  const st = { ...next, retried: { ...next.retried }, paged: { ...next.paged } };
  const put = (obj, key, val) => { if (val == null) delete obj[key]; else obj[key] = val; };
  if (action.type === 'dispatch') put(st.retried, action.stage, (p.retried || {})[action.stage]);
  else if (action.type === 'dispatch-orchestrator') st.orchestratorAt = p.orchestratorAt || null;
  else if (action.type === 'page') put(st.paged, 'stuck', (p.paged || {}).stuck);
  else if (action.type === 'resolve') put(st.paged, 'resolved', (p.paged || {}).resolved);
  return st;
}

module.exports = { evaluateTick, undoUnsent, foundReviews, runIsForShow, activeFor, STAGES, MOVERS, STALL_MIN, NIGHT_START_H, PIPELINE_WINDOW_MIN };
