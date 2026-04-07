/**
 * Adjudication prompt builder — extracted for testability.
 * Used by adjudicate-review-queue.js.
 */

// Outlets known to publish their own star ratings — when an aggregator reports
// a star rating for one of these outlets, it's relaying the outlet's own score.
// Mirrored from rebuild-helpers.js — if you update one, update both.
const KNOWN_STAR_OUTLETS = new Set([
  // --- WE outlets (matches rebuild-helpers.js exactly) ---
  'timeout', 'timeout-london', 'guardian', 'telegraph', 'times-uk', 'standard',
  'independent', 'i-paper', 'financialtimes', 'daily-mail', 'the-express',
  'artsdesk', 'thestage', 'whatsonstage',
  // NOTE: london-theatre REMOVED — confirmed they do not publish star ratings
  // NOTE: london-box-office REMOVED — LBO is an aggregator, not an outlet
  'metro', 'the-sun', 'digital-spy', 'radio-times',
  'all-that-dazzles-uk', 'musical-theatre-review',
  'west-end-wilma', 'west-end-best-friend', 'theatre-bee-uk',
  'tim-talks-theatre-uk', 'city-am', 'plays-international',
  'theatreandtonic', 'the-recs', 'broadwayworld',
  'londontheatre1', 'everything-theatre', 'thereviewshub',
  'shy-strange-manic', 'express-uk', 'theatre-weekly',
  // --- US outlets (verified outletIds from reviews.json) ---
  'observer', 'nytimes', 'usatoday', 'nypost', 'nydailynews',
  'chicagotribune', 'chicago-sun-times', 'washpost',
  'san-francisco-chronicle', 'boston-globe', 'latimes', 'newsday', 'amny',
  'theatrely', 'nysr', 'curtainup',
  'ew', 'time', 'rollingstone',
]);

/**
 * Build the user prompt for a specific review adjudication.
 */
function buildUserPrompt(review, sourceData, showTitle) {
  const parts = [];

  parts.push(`## Review to Adjudicate`);
  parts.push(`**Show:** ${showTitle}`);
  parts.push(`**Outlet:** ${sourceData.outlet || review.outletId}`);
  parts.push(`**Critic:** ${sourceData.criticName || review.criticName || 'Unknown'}`);
  parts.push('');

  // Disagreement context
  parts.push(`## Disagreement`);
  parts.push(`**LLM Score:** ${review.llmScore} (bucket: ${review.llmBucket}, confidence: ${review.llmConfidence})`);

  const thumbParts = [];
  if (review.dtliThumb) thumbParts.push(`DTLI: ${review.dtliThumb}`);
  if (review.bwwThumb) thumbParts.push(`BWW: ${review.bwwThumb}`);
  parts.push(`**Aggregator Thumbs:** ${thumbParts.join(', ') || 'None'}`);
  parts.push(`**Reason flagged:** ${review.reason}`);
  if (review.detail) parts.push(`**Detail:** ${review.detail}`);
  parts.push('');

  // Review text
  parts.push(`## Review Text`);

  const textSources = [];
  if (sourceData.fullText) {
    const text = sourceData.fullText.length > 3000
      ? sourceData.fullText.slice(0, 3000) + '\n[...truncated for length]'
      : sourceData.fullText;
    textSources.push(`### Full Review Text\n${text}`);
  }

  const excerptFields = ['dtliExcerpt', 'bwwExcerpt', 'showScoreExcerpt', 'nycTheatreExcerpt', 'lboRoundupExcerpt'];
  for (const field of excerptFields) {
    if (sourceData[field]) {
      const label = field.replace('Excerpt', '').toUpperCase();
      textSources.push(`### ${label} Excerpt\n${sourceData[field]}`);
    }
  }

  if (textSources.length === 0) {
    parts.push('**WARNING: No review text available.** Only metadata is available for this review. You should return low confidence.');
  } else {
    if (!sourceData.fullText) {
      parts.push('**Note:** Full review text is not available — only aggregator excerpts below. Be cautious with confidence.');
    }
    parts.push(textSources.join('\n\n'));
  }

  // Star rating context — only include if the outlet is known to publish its own
  // star ratings. Aggregators like Show Score invent star ratings for outlets that
  // don't have them (e.g., "5/5 stars" for London Theatre), which misleads scoring.
  const outletId = sourceData.outletId || review.outletId;
  if (sourceData.originalScore && KNOWN_STAR_OUTLETS.has(outletId)) {
    parts.push(`\n### Original Rating\n${sourceData.originalScore}`);
  } else if (sourceData.originalScore) {
    parts.push(`\n### Original Rating (UNVERIFIED — this outlet is not known to publish star ratings; the rating may have been assigned by an aggregator, not the critic)\n${sourceData.originalScore}`);
  }

  parts.push('\nRespond with ONLY the JSON object.');
  return parts.join('\n');
}

module.exports = { KNOWN_STAR_OUTLETS, buildUserPrompt };
