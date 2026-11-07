// Handle to scan for a creator on their primary platform (BRO-6095).
// discover-videos.js used tiktok.handle first even for YouTube-primary creators,
// which breaks any creator whose two handles differ.
function creatorHandle(creator) {
  const p = creator.platforms || {};
  const primary = creator.primaryPlatform === 'youtube' ? p.youtube?.channelHandle : p.tiktok?.handle;
  return primary || p.tiktok?.handle || p.youtube?.channelHandle;
}
module.exports = { creatorHandle };
