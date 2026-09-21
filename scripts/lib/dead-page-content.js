/**
 * Dead-page detection for scraped review text (BRO-3862 follow-up).
 *
 * THE CLASS
 * ---------
 * A fetch can return HTTP 200 and a thousand words of text that is not the
 * article at all: a parked domain offering itself for sale, a cookie-consent
 * wall, a paywall reprint notice, a newsletter-signup interstitial, an
 * edition picker, even a stylesheet's font declarations. The scrape did not
 * fail loudly, so the text was stored and then handed to the gemini
 * non-review classifier, which dutifully labelled it `isNonReview` with a
 * type like 'news' or 'feature'.
 *
 * That label is wrong in a way that COSTS us. `isNonReview` means "a real
 * article that isn't a review" — an editorial judgement a human might
 * reverse. So every one of these files sits in the false-positive audit
 * queue looking like a review we might be wrongly excluding. BRO-3862's
 * audit found 211 such candidates; measuring them showed roughly a THIRD are
 * this class, not articles at all. They make the real backlog look far worse
 * than it is and they bury the genuine misclassifications underneath.
 *
 * MEASURED, not assumed (full corpus, 44,179 review-text files, 2026-09-20):
 *   - parked-domain / for-sale pages ............................    33 files
 *   - text identical across >=3 DIFFERENT shows ................. 2,506 files
 *     in 592 groups (paywall reprint notices, cookie banners,
 *     "best of London straight to your inbox", WSJ edition
 *     pickers, @font-face blocks)
 *   - of ALL of those, files carrying a score and not already
 *     flagged ..................................................         0
 * The last number is the important one: nothing in this class is currently
 * being scored, so classifying it correctly cannot move a single show's
 * score. It is a truthfulness fix to the audit surface, plus a guard so the
 * next one never enters.
 *
 * TWO DETECTORS, because the evidence has two different shapes
 * ------------------------------------------------------------
 * 1. detectParkedDomain(text) — per-file. The giveaway phrases are
 *    unambiguous web plumbing that cannot occur in theatre criticism, so
 *    they are matched position-independently over the whole body, the same
 *    treatment content-quality.js gives STRONG_ERROR_PAGE_PATTERNS.
 *    Verified against the whole corpus: 33 hits, 0 of them scored.
 *
 * 2. buildChromeFingerprintIndex(files) — corpus-level. Boilerplate cannot
 *    be recognised from one file; it is recognised by being IDENTICAL under
 *    shows that have nothing to do with each other. Three distinct shows is
 *    the threshold: two can legitimately share an opening (a transfer, or a
 *    syndicated wire review republished for both runs), three effectively
 *    cannot.
 *
 * Deliberately NOT a regex list for case 2. A "cookie consent" or "paywall"
 * pattern list would be a bare-keyword false-positive generator of exactly
 * the kind CLAUDE.md §12.8 and audit-regex-patterns.js exist to catch — real
 * reviews discuss paywalls, newsletters and subscriptions. Cross-show
 * identity is evidence; a keyword is a guess.
 */

'use strict';

// Unambiguous parked-domain / domain-for-sale chrome. Every pattern requires
// the word "domain" adjacent to a sale phrase, or a parking-page call to
// action, so theatre prose about "the public domain" cannot match.
const PARKED_DOMAIN_PATTERNS = [
  /\bthe\s+domain\s+name\s+[\w.-]+\s+is\s+for\s+sale\b/i,
  /\bthis\s+domain\s+(?:name\s+)?is\s+for\s+sale\b/i,
  /\bbuy\s+this\s+domain\b/i,
  /\bdomain\s+(?:name\s+)?is\s+(?:parked|for\s+sale)\b/i,
  /\bget\s+a\s+price\s+in\s+less\s+than\s+24\s+hours\b/i,
];

// How much of the opening text identifies a boilerplate dump.
const CHROME_FINGERPRINT_CHARS = 300;
// Distinct shows required before identical text is called boilerplate.
const CHROME_MIN_DISTINCT_SHOWS = 3;
// Short texts collide by chance; the boilerplate dumps are long.
const CHROME_MIN_LENGTH = 400;

function normalizeForFingerprint(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

/**
 * Is this text a parked-domain / for-sale page rather than an article?
 * @param {string} text
 * @returns {{ detected: boolean, match: string|null }}
 */
function detectParkedDomain(text) {
  const t = String(text || '');
  if (!t) return { detected: false, match: null };
  for (const re of PARKED_DOMAIN_PATTERNS) {
    const m = t.match(re);
    if (m) return { detected: true, match: m[0] };
  }
  return { detected: false, match: null };
}

/**
 * Fingerprint used for cross-show identity. Exported so the audit, the sweep
 * and any future ingest-time check all derive it the same way.
 * @param {string} text
 * @returns {string|null} null when the text is too short to judge
 */
function chromeFingerprint(text) {
  const t = normalizeForFingerprint(text);
  if (t.length < CHROME_MIN_LENGTH) return null;
  return t.slice(0, CHROME_FINGERPRINT_CHARS);
}

/**
 * Group files by fingerprint, keeping only groups that span enough DIFFERENT
 * shows to be boilerplate rather than a legitimately shared opening.
 *
 * @param {Array<{showId:string, file?:string, text:string}>} files
 * @param {{minDistinctShows?:number}} [opts]
 * @returns {Map<string, {fingerprint:string, shows:string[], files:Array}>}
 */
function buildChromeFingerprintIndex(files, opts = {}) {
  const minShows = opts.minDistinctShows ?? CHROME_MIN_DISTINCT_SHOWS;
  const byFp = new Map();
  for (const f of files || []) {
    const fp = chromeFingerprint(f && f.text);
    if (!fp) continue;
    if (!byFp.has(fp)) byFp.set(fp, []);
    byFp.get(fp).push(f);
  }
  const out = new Map();
  for (const [fp, group] of byFp) {
    const shows = [...new Set(group.map(g => g.showId))];
    if (shows.length < minShows) continue;
    out.set(fp, { fingerprint: fp, shows, files: group });
  }
  return out;
}

/**
 * The single question a caller asks about one file, given a prebuilt index.
 *
 * @param {{fullText?:string}} data
 * @param {Map} [chromeIndex] from buildChromeFingerprintIndex
 * @returns {{ dead: boolean, kind: 'parked-domain'|'cross-show-chrome'|null, evidence: string|null }}
 */
function classifyDeadPage(data, chromeIndex) {
  const text = data && data.fullText;
  if (!text) return { dead: false, kind: null, evidence: null };

  const parked = detectParkedDomain(text);
  if (parked.detected) {
    return { dead: true, kind: 'parked-domain', evidence: parked.match };
  }

  if (chromeIndex) {
    const fp = chromeFingerprint(text);
    const group = fp ? chromeIndex.get(fp) : null;
    if (group) {
      return {
        dead: true,
        kind: 'cross-show-chrome',
        evidence: `identical opening text under ${group.shows.length} different shows`,
      };
    }
  }

  return { dead: false, kind: null, evidence: null };
}

module.exports = {
  PARKED_DOMAIN_PATTERNS,
  CHROME_FINGERPRINT_CHARS,
  CHROME_MIN_DISTINCT_SHOWS,
  CHROME_MIN_LENGTH,
  detectParkedDomain,
  chromeFingerprint,
  buildChromeFingerprintIndex,
  classifyDeadPage,
};
