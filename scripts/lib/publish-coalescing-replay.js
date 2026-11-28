'use strict';
/**
 * BRO-5913: replay of GitHub's concurrency queue (1 running + 1 pending, a new
 * dispatch replaces the pending one) over a real run list. Input lines:
 *   <startHH:MM:SS> <endHH:MM:SS> <workflow> <id> <event> <conclusion> <title...>
 * Models rebuild-fast under (a) per-run groups (old) and (b) one shared group (new).
 */
const fs = require('fs');

const secs = (t) => { const [h, m, s] = t.split(':').map(Number); return h * 3600 + m * 60 + s; };

function parse(text, workflow) {
  return text.split('\n').filter((l) => l.trim()).map((l) => l.split(/\s+/))
    .filter((p) => p[2] === workflow)
    .map((p) => ({ id: p[3], at: secs(p[0]), dur: Math.max(60, secs(p[1]) - secs(p[0])) }))
    .sort((a, b) => a.at - b.at);
}

// Shared group: returns the runs that actually execute.
function simulateSharedGroup(runs) {
  const executed = [];
  let busyUntil = 0, pending = null;
  const drain = (now) => {
    while (pending && busyUntil <= now) {
      const r = pending; pending = null;
      const start = Math.max(busyUntil, r.at);
      busyUntil = start + r.dur; executed.push({ ...r, start });
    }
  };
  for (const r of runs) {
    drain(r.at);
    if (busyUntil <= r.at && !pending) { busyUntil = r.at + r.dur; executed.push({ ...r, start: r.at }); }
    else pending = r; // replaces any earlier pending run
  }
  drain(Infinity);
  return executed;
}

module.exports = { parse, simulateSharedGroup };

if (require.main === module) {
  const runs = parse(fs.readFileSync(process.argv[2], 'utf8'), 'rebuild-fast');
  const after = simulateSharedGroup(runs);
  console.log(`rebuild-fast runs: before=${runs.length} after=${after.length}`);
}
