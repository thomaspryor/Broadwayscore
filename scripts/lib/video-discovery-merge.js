/**
 * Carry LLM pre-classification flags across weekly discovery rescans.
 *
 * discover-videos.js rewrites each data/video-reviews-discovery/{handle}.json
 * from scratch on every scan, which used to wipe the llmFlagged=true markers
 * set by pre-classify-titles.js. TikTok captions rarely contain the word
 * "review", so once the flags were gone, collect-transcripts.js had nothing
 * to collect and TikTok creators silently stopped being picked up
 * (regression window: 2026-04 → 2026-06).
 *
 * preserveLlmFlags mutates newVideos in place: any video whose id was
 * llmFlagged in the previous scan keeps the flag. Returns the number of
 * flags carried over.
 */

function preserveLlmFlags(prevVideos, newVideos) {
  const flagged = new Map();
  for (const v of prevVideos || []) {
    if (v && v.llmFlagged && v.id) flagged.set(v.id, v.classification || 'llm-review-candidate');
  }
  let carried = 0;
  for (const v of newVideos || []) {
    if (!v || !v.id || v.llmFlagged || !flagged.has(v.id)) continue;
    v.llmFlagged = true;
    if (!v.isReviewCandidate) v.classification = flagged.get(v.id);
    carried++;
  }
  return carried;
}

module.exports = { preserveLlmFlags };
