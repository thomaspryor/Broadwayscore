'use strict';
// BRO-5861: opening-night-poller.yml polls shows one after another with no
// overall cap. Run 39632362408 polled 32 shows for 1h57m, so the 145-min job
// timeout killed the rebuild step (cancelled -> "crashed" -> page). The loop
// now has a wall-clock budget so collect/score/rebuild always keep their time.

// Rotate the show list so a budget cut does not starve the same tail every run.
function rotateShows(shows, seed) {
  const list = shows.filter(Boolean);
  if (list.length === 0) return list;
  const n = ((Number(seed) || 0) % list.length + list.length) % list.length;
  return list.slice(n).concat(list.slice(0, n));
}

// Seconds the next show may use: the per-show cap, clamped to what is left in
// the loop budget. 0 means stop (not enough left for a useful poll). The last
// show is clamped to `remaining`, so the loop overruns only by the few seconds
// of per-show bookkeeping after the poller exits.
function showTimeoutSec(remainingSec, capSec = 600, minUsefulSec = 120) {
  if (!(remainingSec >= minUsefulSec)) return 0;
  return Math.min(capSec, Math.floor(remainingSec));
}

module.exports = { rotateShows, showTimeoutSec };

if (require.main === module) {
  const [cmd, a, b] = process.argv.slice(2);
  if (cmd === 'rotate') console.log(rotateShows(String(a || '').split(','), b).join(','));
  else if (cmd === 'timeout') console.log(showTimeoutSec(Number(a), Number(b) || 600));
  else { console.error('usage: rotate <csv> <seed> | timeout <remainingSec> [capSec]'); process.exit(2); }
}
