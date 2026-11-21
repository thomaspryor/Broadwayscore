'use strict';
/**
 * Press-night priority (BRO-7198). On a Broadway press night, opening-night work (lane, poller, rebuild, scoring,
 * pull quotes, deploy) must not wait for runners behind background work. This module is the pure decision: given
 * tonight's shows and a list of queued / in-progress workflow runs, which runs may be cancelled.
 *
 * It automates the side-effect-free part of the go-live-now skill's "Safe to cancel" list and reports the rest. Every run that is not on that
 * list is kept, and so is any run whose title names a show whose press night is tonight. Land runs are never
 * cancelled here: the skill cancels OTHER sessions' landings relative to the one fix a person is rushing, and an
 * automatic step cannot tell which landing carries tonight's fix.
 *
 * Window: a Broadway show's embargo (press-night-record defaultEmbargoAt, the show's override or the market hour)
 * minus 1 hour to plus 6 hours. Pure apart from the lazy require of press-night-record.
 */

const MIN = 60 * 1000;
const WINDOW_BEFORE_MIN = 60;
const WINDOW_AFTER_MIN = 360;
const PROTECT_BEFORE_MIN = 180;
const ACTIVE_STATUSES = new Set(['queued', 'in_progress', 'waiting', 'requested', 'pending']);

/**
 * The skill's "Safe to cancel" list, split in two. AUTO_* runs are cancelled automatically: cancelling them raises no
 * alert, starts no follow-up job and loses no work (they rerun on their own schedule). MANUAL_* runs are safe for a
 * person running go-live-now but not for an automatic loop, so they are reported and kept:
 * - test.yml / check-direct-push on main: a cancelled Test Suite fires cron-redispatch and main-infra-rerun (two more
 *   jobs, and the run may be re-queued), and leaves the sha without the verdict auto-revert reads.
 * - mirror, images, gather-reviews, probe, lane watchdog, lane shadow: each has an `if: cancelled()` alert or cleanup
 *   step, and gather-reviews carries its own work list, so a cancel pages the owner or loses the dispatch.
 */
const AUTO_SAFE = {
  '.github/workflows/demo-alias-watchdog.yml': 'demo alias watchdog',
};

/**
 * Auto-cancelled only while still queued: cancelling a demo build mid-run leaves the demo alias on stale content
 * (.github/workflows/CLAUDE.md, vercel-demo), so a running one is reported for a person instead.
 */
const AUTO_QUEUED_ONLY = {
  '.github/workflows/vercel-demo.yml': 'demo site deploy',
};

/**
 * Auto-cancelled only while still queued and only when the title names another show (none tonight). A queued scoring
 * run loses nothing: the 6-hourly batch (04:30, 10:30, 16:30, 22:30 UTC) scores whatever is still unscored. A running
 * one is reported for a person instead: its push steps run under if: always(), so a cancel still publishes partial
 * scores, moves main under a landing and holds the runner for up to ~10 more minutes (llm-ensemble-score.yml
 * PUSH_DEADLINE_SEC; press-night-watchdog.yml's ledger push is the same).
 */
const AUTO_OTHER_SHOW = {
  '.github/workflows/llm-ensemble-score.yml': 'scoring',
  '.github/workflows/press-night-watchdog.yml': 'press-night watchdog',
};

/** Reported for a person to cancel by hand; never cancelled here. Main pushes only. */
const MANUAL_MAIN_PUSH = {
  '.github/workflows/test.yml': 'tests on a main push',
  '.github/workflows/check-direct-push-to-main.yml': 'direct-push check on a main push',
};

const MANUAL_SAFE = {
  '.github/workflows/mirror-data-to-gitlab.yml': 'core data mirror',
  '.github/workflows/fetch-all-image-formats.yml': 'show images',
};

/** Reported for a person to cancel by hand when the title names another show. */
const MANUAL_OTHER_SHOW = {
  '.github/workflows/gather-reviews.yml': 'review gathering',
  '.github/workflows/press-night-probe.yml': 'press-night probe',
  '.github/workflows/opening-night-lane-watchdog.yml': 'lane watchdog',
};

const LANE_LIVE = '.github/workflows/opening-night-lane-live.yml';

/**
 * Never cancelled, even if a later edit adds them to a safe list above. Mirrors the skill's "Never cancel" list plus
 * the opening-night pipeline itself.
 */
const NEVER = new Set([
  '.github/workflows/land.yml',
  // It re-runs cancelled Land jobs; one of them may carry tonight's fix, and its cron backstop is throttled.
  '.github/workflows/land-retry-cancelled.yml',
  '.github/workflows/vercel-deploy.yml',
  '.github/workflows/opening-night-lane-switch.yml',
  '.github/workflows/execute-approved-fix.yml',
  '.github/workflows/rebuild-reviews.yml',
  '.github/workflows/rebuild-fast.yml',
  '.github/workflows/extract-pull-quotes.yml',
  '.github/workflows/opening-night-poller.yml',
  '.github/workflows/opening-night-orchestrator.yml',
  '.github/workflows/morning-digest-action.yml',
  // Critics' Take: its run title never names the show (no run-name), the poller dispatches it for tonight's shows, and
  // its push and deploy steps are if: always(), so a cancel pushes a partial file. Not even by hand.
  '.github/workflows/update-critic-consensus.yml',
  '.github/workflows/opening-night-broadcast.yml', // real subscribers
  '.github/workflows/autonomous-merge.yml', // shares the landing mutex (land-retry-cancelled.yml header)
  '.github/workflows/update-deploy-watermark.yml',
  // BRO-7232: a hand-cancel on Wanted night left the clock chain dead for 3h16m. The land-cancel-guard hook refuses it.
  '.github/workflows/press-night-clock.yml',
]);

function embargoMs(show) {
  const { defaultEmbargoAt } = require('./press-night-record');
  try { return Date.parse(defaultEmbargoAt(show) || ''); } catch { return NaN; }
}

/** Shows whose window [embargo - beforeMin, embargo + 6h] contains nowMs, with their embargo. */
function showsInWindow(shows, nowMs, beforeMin, accept) {
  const out = [];
  for (const s of shows || []) {
    if (!s || !s.id || !s.openingDate || !accept(s)) continue;
    const at = embargoMs(s);
    if (!Number.isFinite(at)) continue;
    if (nowMs >= at - beforeMin * MIN && nowMs <= at + WINDOW_AFTER_MIN * MIN) out.push({ id: s.id, category: s.category, embargoAt: new Date(at).toISOString() });
  }
  return out;
}

/** Broadway (category) shows in their press-night window [embargo - 1h, embargo + 6h]: these switch priority on. */
function tonightShows(shows, nowMs) {
  // Intentionally NOT isBroadwayCategory: its permissive form treats a null category as Broadway, and an unclassified
  // show must never switch cancelling on. Strict match only; protectedShows() still covers every category.
  return showsInWindow(shows, nowMs, WINDOW_BEFORE_MIN, (s) => s.category === 'broadway');
}

/**
 * Every show, any category or market, whose own press night is near (embargo - 3h, the lane's window start, to + 6h).
 * Their runs are never cancelled: an Off-Broadway or West End show opening the same night is opening-night work too.
 */
function protectedShows(shows, nowMs) {
  return showsInWindow(shows, nowMs, PROTECT_BEFORE_MIN, () => true);
}

const titleOf = (run) => String(run.display_title || run.name || '');

const DAY = 24 * 60 * MIN;
/**
 * True when the title carries a YYYY-MM-DD night within a day of a protected show's opening date. Watchdog, probe and
 * lane titles name their night; this keeps a show's own opening-night run even when shows.json lacks or misstates its
 * openingDate.
 */
function titleNamesNearNight(title, nights) {
  for (const m of String(title).matchAll(/\b(\d{4}-\d{2}-\d{2})\b/g)) {
    const t = Date.parse(`${m[1]}T00:00:00Z`);
    if (Number.isFinite(t) && nights.some((n) => Math.abs(t - n) <= DAY)) return true;
  }
  return false;
}

/** Every known show id that appears in the title as a whole token. */
function showIdsInTitle(title, knownIds) {
  const tokens = new Set(String(title).split(/[\s,;|()]+/).filter(Boolean));
  return knownIds.filter((id) => tokens.has(id));
}

/**
 * Decide one run. ctx = {tonightIds:[id], knownIds:[id]} (knownIds = every show id, to recognise "another show").
 * Returns {action:'cancel'|'manual'|'keep', reason}.
 */
function classifyRun(run, ctx) {
  const keep = (reason) => ({ action: 'keep', reason });
  const cancel = (reason) => ({ action: 'cancel', reason });
  const manual = (reason) => ({ action: 'manual', reason });
  if (!run || !ACTIVE_STATUSES.has(run.status)) return keep('not queued or running');
  const wf = String(run.path || '').replace(/@.*$/, '');
  const title = titleOf(run);
  const tonightHit = (ctx.tonightIds || []).find((id) => title.includes(id));
  if (tonightHit) return keep(`for ${tonightHit}, whose press night is tonight`);
  if (NEVER.has(wf)) return keep('never-cancel list');
  if (titleNamesNearNight(title, ctx.nights || [])) return keep("names tonight's night");
  if (AUTO_SAFE[wf]) return cancel(AUTO_SAFE[wf]);
  if (AUTO_QUEUED_ONLY[wf]) return run.status === 'queued' ? cancel(`${AUTO_QUEUED_ONLY[wf]} (queued)`) : manual(`${AUTO_QUEUED_ONLY[wf]} (already building)`);
  if (MANUAL_SAFE[wf]) return manual(MANUAL_SAFE[wf]);
  if (MANUAL_MAIN_PUSH[wf]) {
    return run.event === 'push' && run.head_branch === 'main' ? manual(MANUAL_MAIN_PUSH[wf]) : keep('not a main push');
  }
  // gather-reviews can carry several shows; every one must be another show (none tonight, checked above).
  const named = showIdsInTitle(title, ctx.knownIds || []);
  const forOther = (label, act) => (named.length ? act(`${label} for ${named.join(', ')}`) : keep('show not named in the title'));
  if (AUTO_OTHER_SHOW[wf]) return forOther(run.status === 'queued' ? AUTO_OTHER_SHOW[wf] : `${AUTO_OTHER_SHOW[wf]} (already running; its pushes run even when cancelled)`, run.status === 'queued' ? cancel : manual);
  if (MANUAL_OTHER_SHOW[wf]) return forOther(MANUAL_OTHER_SHOW[wf], manual);
  if (wf === LANE_LIVE) {
    if (!/^Opening-night lane shadow\b/.test(title)) return keep('lane run that is not a shadow');
    return forOther('lane shadow', manual);
  }
  return keep('not on the safe-to-cancel list');
}

/** Plan for a run list: {tonight, cancel, manual, keep}, each [{run, reason}]. Empty plan outside a window. */
function planPriority({ shows, runs, nowMs }) {
  const tonight = tonightShows(shows, nowMs);
  const plan = { tonight, cancel: [], manual: [], keep: [] };
  if (!tonight.length) return plan;
  const prot = protectedShows(shows, nowMs);
  const byId = new Map((shows || []).filter((s) => s && s.id).map((s) => [s.id, s]));
  const nights = prot.map((t) => Date.parse(`${byId.get(t.id).openingDate}T00:00:00Z`)).filter(Number.isFinite);
  const ctx = { tonightIds: prot.map((t) => t.id), knownIds: [...byId.keys()], nights };
  for (const run of runs || []) {
    const d = classifyRun(run, ctx);
    plan[d.action].push({ run, reason: d.reason });
  }
  return plan;
}

module.exports = {
  WINDOW_BEFORE_MIN, WINDOW_AFTER_MIN, AUTO_SAFE, AUTO_QUEUED_ONLY, AUTO_OTHER_SHOW, MANUAL_SAFE, MANUAL_MAIN_PUSH, MANUAL_OTHER_SHOW, NEVER, LANE_LIVE,
  tonightShows, protectedShows, showIdsInTitle, titleNamesNearNight, classifyRun, planPriority,
};
