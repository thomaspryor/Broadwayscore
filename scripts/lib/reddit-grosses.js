'use strict';

/**
 * Shared predicate for identifying a Reddit post as a "Grosses Analysis" /
 * "Post-Mortem" weekly commercial-data post, regardless of author.
 *
 * Consolidated from 3 near-duplicate implementations (2026-07-19,
 * plan-review finding): scripts/scrape-boring-waltz-costs.js's
 * isRelevantPost(), and an inline `/grosses\s*analysis/i` regex in
 * scripts/update-commercial-data.js's fetchGrossesAnalysisPost(). Both
 * scripts now import from here instead of maintaining their own copy —
 * a 3rd/4th divergent copy is exactly what this consolidation avoids.
 */
function isRelevantPost(post) {
  const title = (post.title || '').toLowerCase();
  return title.includes('grosses') || title.includes('post-mortem') || title.includes('postmortem');
}

const SUFFIX_MULTIPLIER = { k: 1e3, thousand: 1e3, m: 1e6, mil: 1e6, million: 1e6 };

/**
 * A dollar amount in u/Boring_Waltz_9545's notation: "650k", "1.1M",
 * "850,000", or a number plus a separate suffix ("1", "million").
 * @returns {number|null} whole dollars
 */
function parseDollarAmount(number, suffix) {
  if (!number) return null;
  const val = parseFloat(String(number).replace(/[,$\s]/g, ''));
  if (!Number.isFinite(val)) return null;
  const mult = suffix ? SUFFIX_MULTIPLIER[suffix.toLowerCase()] : 1;
  return mult ? Math.round(val * mult) : null;
}

// "Estimated Weekly Operating Cost: $850k/week", "$1 million/week", "$1.1M",
// "$650-$700k" (a range: the midpoint). The suffix may follow a space
// ("$1 million"), which an earlier version read as $1 (BRO-4666). Also
// "Operating Costs", "**...Cost:** $850k" and "Cost: ~$850k".
const SUFFIX = String.raw`(million|mil|thousand|m|k)?\b`;
const COST_RE = new RegExp(
  // At most a closing "**" after the colon, so a "***Show Running Cost***
  // *$400k gross*" heading is not read as a cost line.
  String.raw`(?:Estimated\s+)?(?:Weekly\s+)?(?:Operating|Running)\s+Costs?:?\*{0,2}\s*~?\s*\$\s*([\d.,]+)\s*` + SUFFIX +
    String.raw`(?:\s*[-–—]\s*~?\$?\s*([\d.,]+)\s*` + SUFFIX + ')?',
  'i'
);

/**
 * The low end of "$650-$700k" or "$950-$1.1M": its own suffix, else the high
 * end's when that keeps it below the high end ($650k), else thousands
 * ($950k); null when neither does.
 */
function rangeLow(lowNum, lowSuffix, high, highSuffix) {
  if (lowSuffix) return parseDollarAmount(lowNum, lowSuffix);
  for (const suffix of [highSuffix, 'k']) {
    const low = parseDollarAmount(lowNum, suffix);
    if (low && high && low <= high) return low;
  }
  return null;
}
// ***Show Name*** (optionally an emoji inside the asterisks).
const SHOW_RE = /\*{3}\s*[^\w\s]*\s*([^*]+?)\s*\*{3}/;
const LEADING_EMOJI_RE = /^[\u{1F300}-\u{1FEFF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}\u{200D}\u{20E3}\u{E0020}-\u{E007F}]+\s*/u;
// "***Buena Vista Social Club-*** *$804k gross..." leaves a dash inside the bold.
const TRAILING_PUNCT_RE = /[\s\-–—:\\]+$/;

/**
 * Weekly operating cost estimates in a Grosses Analysis / Post-Mortem post,
 * in post order: one { showName, cost } per cost line, attributed to the
 * last ***Show Name*** heading above it.
 */
function extractCostsFromPost(selftext) {
  if (!selftext) return [];
  const results = [];
  let currentShowName = null;
  for (const line of selftext.split('\n')) {
    const showMatch = line.match(SHOW_RE);
    if (showMatch) {
      const name = showMatch[1].trim().replace(LEADING_EMOJI_RE, '').replace(TRAILING_PUNCT_RE, '').trim();
      if (name) currentShowName = name;
    }
    const m = line.match(COST_RE);
    if (!m || !currentShowName) continue;
    const [, lowNum, lowSuffix, highNum, highSuffix] = m;
    const high = highNum ? parseDollarAmount(highNum, highSuffix) : null;
    const low = high ? rangeLow(lowNum, lowSuffix, high, highSuffix) : parseDollarAmount(lowNum, lowSuffix);
    const cost = low && high ? Math.round((low + high) / 2) : (low || high);
    if (cost && cost > 0) results.push({ showName: currentShowName, cost });
  }
  return results;
}

module.exports = { isRelevantPost, parseDollarAmount, extractCostsFromPost };
