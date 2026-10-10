/**
 * execSync/execFileSync's Error.message is "Command failed: <cmd>\n<real stderr>"
 * — the diagnostic text that actually matters is on line 2+, not the command
 * echo on line 1. A naive `e.message.split('\n')[0]` keeps exactly the useless
 * part and discards the real failure reason (found via bsc-conductor.js
 * ship-check, 2026-07-14; same-shape bug also present in pause-rebuild.js,
 * ingest-urls.js, audit-show-review-gap.js before this fix).
 */
// Lines every child prints while loading the outlet registry (review-normalization.js
// domain-collision warnings). Left in, they fill the first 100 chars and hide the
// real failure: run 38042379107 reported an LTR ingest as failing with
// "Domain collision on timeout.com" (BRO-4956).
const NOISE_LINE = /^\s*⚠️\s+Domain collision on /;

function execErrorDetail(err, maxLen = 200) {
  const raw = String(err && err.message || err).replace(/^Command failed:[^\n]*\n?/, '');
  const detail = raw.split('\n').filter((l) => !NOISE_LINE.test(l)).join('\n').trim() || String(err && err.message || err);
  return maxLen ? detail.slice(0, maxLen) : detail;
}

module.exports = { execErrorDetail };
