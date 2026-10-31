/**
 * Loop-mode helpers for scripts/watch-aggregator-urls.js (BRO-6628).
 *
 * The watcher workflow has a 5-minute cron, but GitHub throttled it to ~4 runs a day on
 * the A Few Good Men press night (BRO-6585), so the press-night window cannot
 * depend on that cron. Loop mode runs the watcher in ONE long job (precedent:
 * press-night-probe.yml, BRO-5912), dispatched once by the orchestrator.
 *
 * Staying in one process matters for cost: the DTLI slug map and the 15-min
 * BWW anchor cache live in memory / /tmp, so repeated runs would re-announce a
 * known DTLI slug (re-dispatching the poller) and re-pay Browserbase each tick.
 */

/** Per-show memory so an already-found URL is not re-dispatched or re-scraped. */
function createWatchState() {
  return { bwwDispatched: new Map(), dtliDispatched: new Map() };
}

/** Once a BWW roundup URL has been handed to the poller, stop probing BWW for that show. */
function shouldProbeBww(state, showId) {
  return !state.bwwDispatched.has(showId);
}

function markBwwDispatched(state, showId, url) {
  state.bwwDispatched.set(showId, url);
}

/** A DTLI slug triggers a dispatch once per (show, slug), not once per tick. */
function shouldDispatchDtli(state, showId, slug) {
  return state.dtliDispatched.get(showId) !== slug;
}

function markDtliDispatched(state, showId, slug) {
  state.dtliDispatched.set(showId, slug);
}

/** Everything the watcher can find has been found and handed off for every show. */
function allDone(state, showIds) {
  return showIds.every(id => state.bwwDispatched.has(id) && state.dtliDispatched.has(id));
}

/**
 * Run `pass` every `intervalMs` until `deadlineMs` (epoch ms) or until `pass`
 * returns { done: true }. `sleep` and `now` are injectable for tests. A pass
 * that throws is logged and the loop continues (a transient network error
 * must not end the press-night window).
 */
async function runLoop({ pass, intervalMs, deadlineMs, now = Date.now, sleep, log = () => {} }) {
  let iteration = 0;
  for (;;) {
    iteration++;
    let result = null;
    try {
      result = await pass(iteration);
    } catch (err) {
      log(`[watch-loop] pass ${iteration} failed: ${err.message}`);
    }
    if (result && result.done) return { iterations: iteration, reason: 'done' };
    if (now() + intervalMs >= deadlineMs) return { iterations: iteration, reason: 'deadline' };
    await sleep(intervalMs);
  }
}

module.exports = {
  createWatchState, shouldProbeBww, markBwwDispatched,
  shouldDispatchDtli, markDtliDispatched, allDone, runLoop,
};
