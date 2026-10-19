'use strict';
// Wall-clock cutoff for the opening-night poller's SERP layer (BRO-5674).
//
// opening-night-poller.yml runs each show under `timeout 600`. Discovered
// reviews are only written in the "Processing N discovered reviews" phase that
// runs AFTER Layer 4 SERP, so a kill during SERP throws away everything layers
// 1-3 found. Other Desert Cities 2026 (run 39198573930) lost 36 candidates
// this way when Bright Data timed out on every outlet (~50s per call).
//
// SERP checks this before each outlet and stops once the process has used
// its share of the 600s window, leaving the rest for processing.

const DEFAULT_SERP_DEADLINE_SEC = 360;

function serpDeadlineSec(env = process.env) {
  const n = Number(env.POLLER_SERP_DEADLINE_SEC);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_SERP_DEADLINE_SEC;
}

// True when another SERP call may start. A single call can run ~70s past this
// (BD 30s + BD SERP 20s + SB fallback), which still fits inside 600s.
function serpTimeLeft(startMs, nowMs, deadlineSec) {
  return (nowMs - startMs) / 1000 < deadlineSec;
}

module.exports = { DEFAULT_SERP_DEADLINE_SEC, serpDeadlineSec, serpTimeLeft };
