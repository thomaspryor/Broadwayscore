/**
 * BRO-7381: start an unattended, --limit-capped run at a different offset each run, so shows that
 * keep failing (and never get a cast file) cannot hold the same slots forever.
 * `step` is a counter that moves once per run of THIS category (the workflow passes week / 3).
 */
function rotateShowWindow(shows, limit, step) {
  if (!Array.isArray(shows) || shows.length < 2 || !(limit > 0) || !Number.isFinite(step)) return shows;
  const off = (Math.floor(step) * limit) % shows.length;
  return shows.slice(off).concat(shows.slice(0, off));
}
module.exports = { rotateShowWindow };
