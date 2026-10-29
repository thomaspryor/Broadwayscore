'use strict';
// BRO-6089: spend-guard counters for the theatre.reviews round-up fetch loop.
// A page that redirects to another page ("moved") is not a provider outage, so
// it has its own, larger cap instead of the plain consecutive-failure cap.
const MAX_CONSECUTIVE_FETCH_FAILURES = 8;
const MAX_CONSECUTIVE_MOVED = 25;

function nextFetchFailureState(state, { failed, moved }) {
  if (!failed) return { consecutive: 0, moved: 0, abort: false };
  const consecutive = state.consecutive + (moved ? 0 : 1);
  const movedRun = state.moved + (moved ? 1 : 0);
  return {
    consecutive,
    moved: movedRun,
    abort: consecutive >= MAX_CONSECUTIVE_FETCH_FAILURES || movedRun >= MAX_CONSECUTIVE_MOVED,
  };
}

module.exports = { nextFetchFailureState, MAX_CONSECUTIVE_FETCH_FAILURES, MAX_CONSECUTIVE_MOVED };
