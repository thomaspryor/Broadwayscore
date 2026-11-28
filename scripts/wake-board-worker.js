#!/usr/bin/env node
/**
 * wake-board-worker.js (BRO-6715): fire the board worker routine now. Run by board-worker-wake.yml.
 * Skips when a wake already succeeded in the last 4 minutes (one worker takes every answered card).
 * Prints only whether it fired, never the session link. Exit 0 unless the call itself errored.
 */
'use strict';
const { wakeBoardWorker, recentWakeRun } = require('./lib/board-worker-wake.js');
(async () => {
  const recent = await recentWakeRun();
  if (recent) { console.log(JSON.stringify({ fired: false, why: 'debounced', recentRun: recent.id })); return; }
  const r = await wakeBoardWorker({ reason: process.argv[2] || '' });
  console.log(JSON.stringify({ fired: r.fired, why: r.why || null }));
  if (!r.fired && r.why && r.why !== 'not-configured') process.exitCode = 1;
})();
