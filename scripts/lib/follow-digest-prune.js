/**
 * Shows in the follow-notification digest that nobody follows (BRO-4897).
 *
 * detect-show-changes.js carries every pending `changes` entry forward and
 * send-follow-notifications.js only deletes shows it fully delivered, so a
 * show with no followers would keep its changes forever (entries carry no
 * timestamp to age out). A later follower would then get months-old news.
 * send-follow-notifications.js drops these after each run.
 *
 * @param {Record<string, unknown[]>} changes  digest.changes
 * @param {Record<string, string[]>} followersByShow  followers.json `followers`
 * @returns {string[]} show ids to drop from the digest
 */
function unfollowedShowIds(changes, followersByShow) {
  const map = followersByShow || {};
  return Object.keys(changes || {}).filter((showId) => {
    const list = map[showId];
    return !Array.isArray(list) || list.length === 0;
  });
}

module.exports = { unfollowedShowIds };
