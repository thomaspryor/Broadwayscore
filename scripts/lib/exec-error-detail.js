/**
 * execSync/execFileSync's Error.message is "Command failed: <cmd>\n<real stderr>"
 * — the diagnostic text that actually matters is on line 2+, not the command
 * echo on line 1. A naive `e.message.split('\n')[0]` keeps exactly the useless
 * part and discards the real failure reason (found via bsc-conductor.js
 * ship-check, 2026-07-14; same-shape bug also present in pause-rebuild.js,
 * ingest-urls.js, audit-show-review-gap.js before this fix).
 */
function execErrorDetail(err, maxLen = 200) {
  const detail = String(err && err.message || err).replace(/^Command failed:[^\n]*\n?/, '').trim() || String(err && err.message || err);
  return maxLen ? detail.slice(0, maxLen) : detail;
}

module.exports = { execErrorDetail };
