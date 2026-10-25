/**
 * BRO-3366: when rebuild folds a duplicateOf loser into its winner, the
 * loser is dropped. If the winner has no URL and a loser carries one, the
 * scored row ships with no outbound link. The winner inherits the loser's URL.
 *
 * Pure: callers pass a loader so this is unit-testable without the filesystem.
 */

/**
 * @param {string} winnerFile basename of the winning review-text file
 * @param {object} winnerData parsed winner
 * @param {string[]} siblingFiles basenames in the same show dir
 * @param {(name: string) => object|null} load parsed sibling loader
 * @returns {string|null} URL to inherit, or null (winner already has one / none to inherit)
 */
function inheritUrlFromDuplicateLosers(winnerFile, winnerData, siblingFiles, load) {
  if (!winnerData) return null;
  if (typeof winnerData.url === 'string' && winnerData.url.trim()) return null;
  const urls = [];
  for (const name of siblingFiles) {
    if (name === winnerFile) continue;
    const d = load(name);
    if (!d || d.duplicateOf !== winnerFile) continue;
    if (typeof d.url !== 'string' || !/^https?:\/\//i.test(d.url.trim())) continue;
    urls.push(d.url.trim());
  }
  if (urls.length === 0) return null;
  // Deterministic regardless of readdir order (BRO-3402 class).
  return urls.sort()[0];
}

module.exports = { inheritUrlFromDuplicateLosers };
