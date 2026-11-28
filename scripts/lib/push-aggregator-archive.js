#!/usr/bin/env node
// scripts/lib/push-aggregator-archive.js: pure retry budget + jitter for
// .github/actions/push-aggregator-archive/action.yml (BRO-6510).
//
// Several gather-reviews shards finish within seconds of each other and all
// push to the one private repo. Five attempts with a flat 5-14s sleep let the
// same pushers collide five times in a row (2 red runs of ~33). A larger budget
// with jitter that WIDENS per attempt spreads contenders out so each loses
// fewer rounds. Tests require() this file (CLAUDE.md rule 15).
//
// CLI (used by the action): `node push-aggregator-archive.js max` prints the
// attempt budget; `node push-aggregator-archive.js delay <attempt>` prints a
// jittered sleep in seconds for the attempt that just lost.

'use strict';

const MAX_ATTEMPTS = 10;
const BASE_SECONDS = 5;
const SPREAD_BASE_SECONDS = 10;
const SPREAD_PER_ATTEMPT_SECONDS = 6;

/**
 * Seconds to sleep after attempt `attempt` (1-based) lost a non-fast-forward
 * race. Uniform in [BASE, BASE + SPREAD_BASE + 6*attempt): attempt 1 sleeps
 * 5-20s, attempt 9 sleeps 5-68s. Worst case total across 9 sleeps stays under
 * ~10 minutes, well inside the gather job's 200 minute timeout.
 */
function contentionDelaySeconds(attempt, random = Math.random) {
  const n = Math.max(1, Math.floor(Number(attempt)) || 1);
  const spread = SPREAD_BASE_SECONDS + SPREAD_PER_ATTEMPT_SECONDS * n;
  return BASE_SECONDS + Math.floor(random() * spread);
}

/** Largest value contentionDelaySeconds can return for an attempt. */
function maxContentionDelaySeconds(attempt) {
  return contentionDelaySeconds(attempt, () => 0.999999999);
}

module.exports = { MAX_ATTEMPTS, contentionDelaySeconds, maxContentionDelaySeconds };

if (require.main === module) {
  const [cmd, arg] = process.argv.slice(2);
  if (cmd === 'max') console.log(MAX_ATTEMPTS);
  else if (cmd === 'delay') console.log(contentionDelaySeconds(arg));
  else {
    console.error('usage: push-aggregator-archive.js max | delay <attempt>');
    process.exit(2);
  }
}
