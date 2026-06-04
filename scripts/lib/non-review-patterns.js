/**
 * Shared non-review content detection (heuristic Layer 1).
 *
 * Single source of truth used by:
 *   - scripts/audit-non-reviews.js        (corpus audit + CI gate)
 *   - scripts/newspapers-com-extract.js   (reject bad OCR before saving)
 *
 * Catches text that is NOT a critical theater review: press releases, cast
 * news, previews, interviews, listicles, obituaries, paywall walls — AND
 * wrong-page newspaper OCR (weather pages, sports scoreboards, listings/stock
 * grids), which is the class that shipped an LA Times weather page scored 88
 * and a Chicago Tribune sports page scored 72 before this gate existed.
 *
 * `definitive: true` marks page-type signals a genuine review never contains
 * (a tide table, a SCOREBOARD header). A single definitive match in the
 * opening, absent strong review language, is high-confidence non-review.
 */

const NON_REVIEW_PATTERNS = [
  // Press releases / promotional
  { pattern: /(?:is pleased to announce|announces?\s+(?:that|the)|tickets? (?:are\s+)?(?:now\s+)?on sale|available at the box office)/i, type: 'press_release' },
  // Cast announcements
  { pattern: /(?:joins? the cast|has been cast|will star in|casting (?:announced|complete))/i, type: 'cast_announcement' },
  // Previews / anticipation articles
  { pattern: /(?:what to expect|first look at|sneak peek|before (?:it|the show) opens|preview article|previews begin)/i, type: 'preview_article' },
  // News/closings
  { pattern: /(?:closes? (?:early|unexpectedly|on)|final performance|closing notice|has been (?:cancelled|postponed|delayed))/i, type: 'news_article' },
  // Interviews
  { pattern: /(?:in (?:an|this) interview|(?:we|I) (?:spoke|sat down|chatted) with|Q&A with|exclusive interview)/i, type: 'interview' },
  { pattern: /Q:\s.{5,80}\nA:\s/i, type: 'interview' },
  // Listicles
  { pattern: /(?:top \d+ (?:shows|musicals|plays)|best (?:shows|musicals|plays) of \d{4}|our picks for|ranking (?:the|every)|must-see shows)/i, type: 'listicle' },
  // Award coverage
  { pattern: /(?:tony (?:nominations|winners|predictions)|award (?:nominations|winners)|receives? \d+ nomination)/i, type: 'awards_coverage' },
  // Photo galleries
  { pattern: /(?:photo gallery|see the photos|in photos|production photos|first photos)/i, type: 'photo_gallery' },
  // Obituaries
  { pattern: /(?:has died|passed away|in memoriam)/i, type: 'obituary' },
  { pattern: /(?:(?:age|aged) \d{2,3}).{0,40}(?:died|death|passed|memorial|funeral|tribute)/i, type: 'obituary' },
  { pattern: /(?:died|death|passed|memorial|funeral|tribute).{0,40}(?:(?:age|aged) \d{2,3})/i, type: 'obituary' },
  { pattern: /\bremembering\b.{0,20}(?:who|life|legacy|career)/i, type: 'obituary' },
  // Garbage scrapes — advisory only (NOT definitive). Real scraped reviews often
  // carry an incidental "BROWSER UPDATE"/"please upgrade your browser" boilerplate
  // fragment alongside the actual review text; making these single-match-definitive
  // false-flags ~72 genuine WSJ/HuffPost reviews. The reviewSignals>=2 guard keeps
  // them from gating real reviews; pure junk (no review signals, 2+ matches) still
  // reaches high-confidence via the standard rule.
  { pattern: /(?:BROWSER UPDATE|To gain access to the full experience|please upgrade your browser)/i, type: 'garbage_scrape' },
  { pattern: /(?:Subscribe to continue|subscribe now to read|sign in to continue reading|Already a subscriber)/i, type: 'paywall_wall' },
  { pattern: /(?:\.has-text-align-justify|margin-left:\s*auto|div\.admz)/i, type: 'css_junk' },

  // ── Wrong-page newspaper OCR (the embarrassing class) ──────────────────
  // Weather pages: tide tables, forecast grids, sunrise/sunset lines. A
  // theater review never carries these.
  { pattern: /\bthe weather\b[\s\S]{0,60}(?:county|forecast|sunrise|high\b.{0,10}\blow)/i, type: 'weather_page', definitive: true },
  { pattern: /\btide(?:s)?\b.{0,25}(?:table|\bhi(?:gh)?\b.{0,15}\blo(?:w)?\b|feet)/i, type: 'weather_page', definitive: true },
  // Require clock times so Fiddler's "Sunrise, Sunset" song (and similar) don't match.
  { pattern: /\bsunrise\b.{0,12}\d{1,2}:\d{2}\s*[ap]?\.?m?\.?.{0,25}\bsunset\b.{0,12}\d{1,2}:\d{2}/i, type: 'weather_page', definitive: true },
  { pattern: /\b(?:five|5)[-\s]day forecast\b/i, type: 'weather_page', definitive: true },
  // (Dropped bare "partly cloudy NN/NN" — FP'd on review metaphors like "a 50/50
  // gamble". The signals above already catch real weather pages.)
  // Sports pages: require sports CONTEXT near "scoreboard" so review metaphors
  // ("a scoreboard of emotions") don't trip the hard CI gate.
  { pattern: /\bscoreboard\b[\s\S]{0,120}\b(?:standings|box score|final score|sports|innings?|quarterback|touchdowns?|\bN[BFH]L\b|\bMLB\b)\b/i, type: 'sports_page', definitive: true },
  { pattern: /\bbox score\b[\s\S]{0,80}\b(?:innings?|at bat|rebounds?|assists?|final|quarter)\b/i, type: 'sports_page', definitive: true },
  { pattern: /\|\s*sports\s*\|/i, type: 'sports_page', definitive: true },
  { pattern: /\bstandings\b[\s\S]{0,40}\b(?:gb|wins?|losses?|pct)\b/i, type: 'sports_page', definitive: true },
];

// Patterns that strongly indicate it IS a review (suppress false positives).
const REVIEW_INDICATORS = [
  /(?:stars?|rating|grade|score):\s*[A-F][+-]?/i,
  /\b(?:directed by|written by|choreographed by)\b/i,
  /(?:opened? (?:last|this) (?:night|week)|opening night)/i,
  /(?:the (?:production|performance|staging|direction) (?:is|was|feels?))/i,
  /(?:brilliantly|masterfully|unfortunately|disappointing|thrilling|riveting|stunning)/i,
  /(?:curtain call|standing ovation|intermission)/i,
  /\d\s*(?:out of|\/)\s*(?:5|10|4)\s*stars?/i,
  /(?:stars?|rating):\s*\d/i,
];

/**
 * Heuristic non-review classification.
 * Returns { isNonReview, type, confidence: 'high'|'medium', evidence } or null.
 *
 * A `definitive` page-type signal (weather/sports/listings) anywhere in the
 * opening, with fewer than 2 strong review signals, is high-confidence — a real
 * review never contains a tide table or a SCOREBOARD header. Other signals keep
 * the original "2 matches in the opening + 0 review signals = high" rule.
 */
function heuristicClassify(text) {
  if (!text || text.length < 50) return null;

  let reviewSignals = 0;
  for (const pattern of REVIEW_INDICATORS) {
    if (pattern.test(text)) reviewSignals++;
  }

  // Definitive page-type signals: scan a wider window (these can appear after a
  // short mis-OCR'd lead) but still demand the absence of real review language.
  const wide = text.substring(0, 1200);
  for (const { pattern, type, definitive } of NON_REVIEW_PATTERNS) {
    if (!definitive) continue;
    const m = wide.match(pattern);
    if (m && reviewSignals < 2) {
      return { isNonReview: true, type, confidence: 'high', evidence: m[0].slice(0, 80) };
    }
  }

  const opening = text.substring(0, 400);
  const matches = [];
  for (const { pattern, type } of NON_REVIEW_PATTERNS) {
    const m = opening.match(pattern);
    if (m) matches.push({ type, evidence: m[0] });
  }
  if (matches.length === 0) return null;
  if (reviewSignals >= 2) return null;

  if (matches.length >= 2 && reviewSignals === 0) {
    return { isNonReview: true, type: matches[0].type, confidence: 'high', evidence: matches.map(m => m.evidence).join('; ') };
  }
  return { isNonReview: true, type: matches[0].type, confidence: 'medium', evidence: matches[0].evidence };
}

module.exports = { NON_REVIEW_PATTERNS, REVIEW_INDICATORS, heuristicClassify };
