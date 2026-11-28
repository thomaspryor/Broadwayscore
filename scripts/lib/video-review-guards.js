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
      if (!r.videoUrl) continue; // no URL: can't be a cross-show duplicate
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
      if (r.videoUrl && showsByUrl.get(r.videoUrl).size > 1) {
        dropped.push({ showId, videoUrl: r.videoUrl, reason: `same video on ${[...showsByUrl.get(r.videoUrl)].join(', ')}` });
      } else {
        ok.push(r);
      }
    }
    if (ok.length) kept[showId] = ok;
  }
  return { kept, dropped };
}

// BRO-4760: a creator's own paid-promotion label (TikTok/YouTube #ad, "paid
// partnership", "sponsored by") marks an advert, not a review; tyvid5's
// Aladdin video ("#ad ... Thanks, Disney for the tickets and swag bag") was
// scored 87. Free press tickets are normal for critics and are NOT matched.
const PAID_PROMOTION_RE = /(?:^|[\s(])#(?:ad|ads|sponsored|paidpartnership|paidpartner)\b|\bpaid partnership\b|\bsponsored by\b|\bthis (?:video|post|episode) is sponsored\b/i;

/** @param {{title?: string, transcript?: string}} t a transcript file */
function isPaidPromotion(t) {
  return PAID_PROMOTION_RE.test(`${(t && t.title) || ''}\n${(t && t.transcript) || ''}`);
}

/**
 * BRO-4760: transcript files carry the platform handle ("MatthewHardyMusical",
 * "TheatreReviewsWithPaulSeven"), but profile pages are keyed by creator id
 * ("matthewhardymusical", "paulsevenlewis"). Matching on the raw handle left
 * 148 reviews with no profile and a 404 creator link. Case-insensitive lookup
 * by id, YouTube channel handle or TikTok handle.
 * @param {{id: string, platforms?: object}[]} creators data/video-creators.json .creators
 * @returns {(handle: string) => object | undefined}
 */
function creatorLookup(creators) {
  const map = new Map();
  for (const c of creators) {
    for (const k of [c.id, c.platforms?.youtube?.channelHandle, c.platforms?.tiktok?.handle]) {
      if (k && !map.has(k.toLowerCase())) map.set(k.toLowerCase(), c);
    }
  }
  return handle => map.get(String(handle || '').toLowerCase());
}

module.exports = { filterPublishableReviews, isPaidPromotion, creatorLookup };
