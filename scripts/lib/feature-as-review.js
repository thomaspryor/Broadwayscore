'use strict';
/**
 * feature-as-review.js (BRO-5420): signals that a stored "review" is a
 * feature, news item, interview or blog post. million-dollar-quartet-2010
 * counted an NYT ArtsBeat post on the actors ("The Men Behind the Musicians")
 * as a 75 review beside Isherwood's real one.
 *
 * Signals only; a hand check or the classifier decides.
 */

// Path shapes of non-review pages. Matched against host + path, lowercased.
const FEATURE_URL_PATTERNS = [
  ['blog', /(?:^|[./])(?:artsbeat|[a-z]+)\.blogs\.nytimes\.com\//],
  ['blog', /\/blogs?\//],
  ['news', /\/news\//],
  ['interview', /interview/],
  ['feature', /\/features?\//],
  ['q-and-a', /\/q-?(?:and|&)-?a\b|\/qa\//],
  ['behind-the-scenes', /behind-the-scenes|the-(?:men|women|people)-behind/],
];

function featureUrlSignal(url) {
  if (!url || typeof url !== 'string') return null;
  const u = url.toLowerCase().replace(/^https?:\/\//, '').replace(/[?#].*$/, '');
  // A path that says "review" is a review even under /news/ or /blog/
  // (whatsonstage.com/news/<show>-review-..., londonboxoffice /news/post/...).
  if (/review/.test(u.replace(/^[^/]*/, ''))) return null;
  for (const [name, re] of FEATURE_URL_PATTERNS) if (re.test(u)) return name;
  return null;
}

// The body reports another critic's verdict instead of giving its own.
const PARAPHRASE_RE = /\bin (?:his|her|their) (?:review|notice)\b|\b(?:his|her) review (?:of|in) (?:the|this)\b|\b(?:times|post|journal|guardian|telegraph) (?:critic|reviewer) \w+ \w+ (?:called|calls|wrote|writes|said|praised|panned)\b/i;

function paraphrasedReviewSignal(text) {
  if (!text || typeof text !== 'string') return null;
  const m = PARAPHRASE_RE.exec(text);
  if (!m) return null;
  const start = Math.max(0, m.index - 60);
  return { match: m[0], context: text.slice(start, m.index + m[0].length + 100).replace(/\s+/g, ' ') };
}

module.exports = { featureUrlSignal, paraphrasedReviewSignal, FEATURE_URL_PATTERNS };
