/**
 * Publish-time guards for data/video-reviews.json (BRO-4328).
 *
 * The 2026-09-29 audit found reviews published under show ids that do not
 * exist in shows.json (beaches-2025, can-i-be-frank-off-broadway-2026,
 * every-brilliant-thing-off-broadway-2026) and one video published on two
 * shows with different scores (tylernabinger 7624353603184102670 on
 * beaches-2025 and beaches-2026). Pure so tests can require() it (§15).
 */

/**
 * @param {Record<string, object[]>} reviewsByShow showId -> reviews (each with videoUrl)
 * @param {Set<string>} knownShowIds ids present in data/shows.json
 * @returns {{ kept: Record<string, object[]>, dropped: {showId:string, videoUrl:string, reason:string}[] }}
 *   Unknown show ids are dropped. A video on more than one known show is
 *   dropped everywhere: which production it reviews is unknown, and showing it
 *   nowhere beats showing it on the wrong show.
 */
function filterPublishableReviews(reviewsByShow, knownShowIds) {
  const dropped = [];
  const showsByUrl = new Map();
  for (const [showId, reviews] of Object.entries(reviewsByShow)) {
    if (!knownShowIds.has(showId)) continue;
    for (const r of reviews) {
      if (!showsByUrl.has(r.videoUrl)) showsByUrl.set(r.videoUrl, new Set());
      showsByUrl.get(r.videoUrl).add(showId);
    }
  }

  const kept = {};
  for (const [showId, reviews] of Object.entries(reviewsByShow)) {
    if (!knownShowIds.has(showId)) {
      for (const r of reviews) dropped.push({ showId, videoUrl: r.videoUrl, reason: 'unknown show id' });
      continue;
    }
    const ok = [];
    for (const r of reviews) {
      if (showsByUrl.get(r.videoUrl).size > 1) {
        dropped.push({ showId, videoUrl: r.videoUrl, reason: `same video on ${[...showsByUrl.get(r.videoUrl)].join(', ')}` });
      } else {
        ok.push(r);
      }
    }
    if (ok.length) kept[showId] = ok;
  }
  return { kept, dropped };
}

module.exports = { filterPublishableReviews };
