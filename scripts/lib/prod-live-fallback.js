// BRO-6730: when local ancestry cannot say whether a commit is live (shallow
// cloud clone, unshallow fails), ask the GitHub compare API instead of giving
// up with "could not tell". `compare(full, deployedSha)` returns the compare
// status string ('ahead' | 'identical' | 'behind' | 'diverged') or throws.
// Returns true (live), false (not live), or null (still unknown).
function liveFromCompareStatus(status) {
  if (status === 'ahead' || status === 'identical') return true;
  if (status === 'behind' || status === 'diverged') return false;
  return null;
}

function resolveUnknownLiveness({ fullSha, deployedSha, compare, log = () => {} }) {
  if (!fullSha || !deployedSha || typeof compare !== 'function') return null;
  try {
    return liveFromCompareStatus(compare(fullSha, deployedSha));
  } catch (e) {
    log(`compare fallback failed: ${String((e && e.message) || e).split('\n')[0]}`);
    return null;
  }
}

module.exports = { liveFromCompareStatus, resolveUnknownLiveness };
