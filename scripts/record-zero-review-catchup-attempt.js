#!/usr/bin/env node
/**
 * record-zero-review-catchup-attempt.js
 *
 * Records a catch-up attempt for each id in the comma-separated batch
 * (BRO-3389). Called by update-show-status.yml ONLY after the
 * gather-reviews dispatch step reports success — recording an attempt on a
 * failed `gh workflow run` call (rate limit, transient API error) would
 * burn the give-up budget on collection that never actually happened.
 *
 * Usage: node scripts/record-zero-review-catchup-attempt.js "show-a,show-b"
 */
'use strict';

const path = require('path');
const { recordAttempts } = require('./lib/zero-review-catchup-attempts');

const ATTEMPTS_PATH = path.join(__dirname, '..', 'data', 'audit', 'zero-review-catchup-attempts.json');

function main() {
  const ids = (process.argv[2] || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!ids.length) {
    console.log('No ids to record.');
    return;
  }
  recordAttempts(ATTEMPTS_PATH, ids, Date.now());
  console.log(`Recorded catch-up attempt for: ${ids.join(', ')}`);
}

main();
