'use strict';
/**
 * Preloaded (`node --require`) into scripts run by run-script-sealed.js. Their stdout
 * and stderr are pipes, which Node writes asynchronously, so a script that prints a
 * big report and then calls process.exit() loses everything still buffered: 2 MB came
 * through as 146 KB, and report-orphan-review-folders.js --json was cut at ~219 KB
 * (BRO-4317). Blocking pipes make every write complete before exit, for every script.
 */
for (const stream of [process.stdout, process.stderr]) {
  const handle = stream && stream._handle;
  if (handle && typeof handle.setBlocking === 'function') handle.setBlocking(true);
}
