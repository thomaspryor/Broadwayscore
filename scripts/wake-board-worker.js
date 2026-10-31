#!/usr/bin/env node
/** wake-board-worker.js (BRO-6715): fire the board worker routine now. Run by board-worker-wake.yml. Exit 0 unless the call itself errored. */
'use strict';
const { wakeBoardWorker } = require('./lib/board-worker-wake.js');
(async () => {
  const r = await wakeBoardWorker({ reason: process.argv[2] || '' });
  console.log(JSON.stringify(r));
  if (!r.fired && r.why && r.why !== 'not-configured') process.exitCode = 1;
})();
