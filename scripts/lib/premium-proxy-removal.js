/**
 * Detects a direct ScrapingBee call that hardcodes premium_proxy=true in
 * source code (as opposed to a comment mentioning it, or a value threaded
 * through from a caller option that could be false). Used by task #5's
 * regression test to keep the migrated scripts from regressing back to a
 * direct SB premium call, which costs $2.48/1k — more than Bright Data's
 * $1.50/1k or Scrapingdog's ~$0.90/1k premium tier.
 *
 * Scans line-by-line and ignores comment-only lines (starting with // or *)
 * so explanatory comments referencing the old pattern don't trip the check.
 *
 * @param {string} source - File contents to scan
 * @returns {boolean} true if a live (non-comment) premium_proxy=true literal is present
 */
function hasHardcodedPremiumProxyTrue(source) {
  const lines = source.split('\n');
  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue;
    // Strip a trailing // comment from otherwise-live code. Split only on
    // whitespace-preceded '//' so "https://" URLs inside the line survive.
    const commentMatch = rawLine.match(/\s\/\/.*/);
    const codePart = commentMatch ? rawLine.slice(0, commentMatch.index) : rawLine;
    if (/premium_proxy['"]?\s*[:=,]\s*['"]?true\b/.test(codePart)) return true;
    if (/searchParams\.set\(\s*['"]premium_proxy['"]\s*,\s*['"]true['"]\s*\)/.test(codePart)) return true;
  }
  return false;
}

module.exports = { hasHardcodedPremiumProxyTrue };
