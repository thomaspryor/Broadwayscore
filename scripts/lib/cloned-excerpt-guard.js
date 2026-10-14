'use strict';

/**
 * cloned-excerpt-guard.js — BRO-4406. Pure decision logic for "one aggregator
 * excerpt, two same-outlet review files" (phantom / duplicate reviews).
 *
 * Problem: within a show + outlet, an aggregator excerpt (dtliExcerpt,
 * bwwExcerpt, showScoreExcerpt, ...) can end up on TWO files. Engine dedup is
 * (outlet, criticName) only, so both files count: the show's review count is
 * inflated, a critic who never reviewed the show is displayed, and the
 * outlet's score is pulled toward the phantom. Writers that matched an
 * aggregator row to a file by OUTLET ONLY (merge-dtli-excerpts.js et al.) and
 * web-search records that copied an aggregator excerpt into their own fullText
 * created these.
 *
 * Every pair sharing an excerpt is exactly one of:
 *   same-review  — one article scraped twice (typo/unknown byline, URL variant,
 *                  two aggregator sources). Merge: keep the canonical file.
 *   phantom      — one side is a web-search guess whose text/URL is not a real
 *                  review of this show. It is removed.
 *   excerpt-copy — two genuinely different reviews from one outlet; the
 *                  excerpt belongs to the file whose own fullText contains it
 *                  and is stripped from the other.
 *   unresolved   — evidence does not decide; reported, never auto-applied.
 *
 * No I/O here (CLAUDE.md §15). The audit script and the write guard call in.
 */

const { EXCERPT_FIELDS } = require('./excerpt-fields');

const MIN_EXCERPT_CHARS = 40;
const SIMILAR_TEXT_JACCARD = 0.6;
const LONG_TEXT_CHARS = 300;

// A file carrying any of these is already out of the composite, so a pair
// with such a side is "resolved, pending rebuild" rather than a live clone.
const EXCLUSION_FLAGS = [
  'wrongShow', 'wrongProduction', 'wrongAttribution', 'wrongFullText',
  'isNotReview', 'isRoundupArticle', 'notAReview',
];

const WEAK_SOURCES = new Set(['web-search']);
const WEAK_REASONS = new Set([
  'url_dead', 'scraper_garbage', 'url_content_mismatch', 'wrong_content', 'partial_text',
]);
const WEAK_TIERS = new Set(['truncated', 'excerpt', 'stub', 'invalid']);

function normText(s) {
  return String(s == null ? '' : s)
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&[a-z]+;|&#\d+;/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Map<normalizedExcerpt, string[] fieldNames> for excerpts over MIN_EXCERPT_CHARS. */
function excerptValues(data) {
  const out = new Map();
  if (!data) return out;
  for (const f of EXCERPT_FIELDS) {
    const v = data[f];
    if (typeof v !== 'string' || v.length <= MIN_EXCERPT_CHARS) continue;
    const n = normText(v);
    if (!n) continue;
    if (!out.has(n)) out.set(n, []);
    out.get(n).push(f);
  }
  return out;
}

/** Normalized excerpt strings present on BOTH records (any excerpt field on either). */
function sharedExcerpts(a, b) {
  const av = excerptValues(a);
  const bv = excerptValues(b);
  return [...av.keys()].filter((k) => bv.has(k));
}

/** Host without www./theater., path without trailing slash, no query/hash. */
function canonUrl(u) {
  if (typeof u !== 'string' || !u.trim()) return null;
  const s = u.trim().replace(/^https?:\/\//i, '').replace(/[?#].*$/, '')
    .replace(/^www\./i, '').replace(/^theater\./i, '').replace(/\/+$/, '').toLowerCase();
  return s || null;
}

function wordSet(text) {
  return new Set(normText(text).split(' ').filter((w) => w.length > 2));
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  return inter / (a.size + b.size - inter);
}

function normCritic(name) {
  return normText(name).replace(/\b(unknown|staff)\b/g, '').trim();
}

/** Is text `small` (normalized) contained in `big` (normalized)? */
function contains(big, small) {
  return small.length > 0 && big.includes(small);
}

/**
 * Do these two records carry the same article? URL identity is only trusted
 * when the texts do not contradict it (once-upon-a-mattress: two different NYT
 * pieces under one URL is a URL-integrity bug, not one review).
 */
function isSameReview(a, b) {
  const ta = normText(a.fullText);
  const tb = normText(b.fullText);
  const bothLong = ta.length >= LONG_TEXT_CHARS && tb.length >= LONG_TEXT_CHARS;
  const sim = bothLong ? jaccard(wordSet(a.fullText), wordSet(b.fullText)) : null;
  if (sim !== null && sim >= SIMILAR_TEXT_JACCARD) return { same: true, reason: `text-similar (${sim.toFixed(2)})` };
  if (!bothLong && Math.min(ta.length, tb.length) >= 60 && (contains(ta, tb) || contains(tb, ta))) return { same: true, reason: 'short text contained in other' };
  const ua = canonUrl(a.url);
  const ub = canonUrl(b.url);
  if (ua && ua === ub && (sim === null || sim >= 0.35)) return { same: true, reason: 'same canonical url' };
  return { same: false, reason: sim === null ? 'texts not comparable' : `texts differ (${sim.toFixed(2)})` };
}

/** A web-search record whose text/URL does not look like a fetched review. */
function isWeakWebSearch(d) {
  if (!d || !WEAK_SOURCES.has(d.source)) return false;
  const len = (d.fullText || '').length;
  return Boolean(
    d.fetchDiscoveryAbandoned || WEAK_REASONS.has(d.incompleteReason)
    || WEAK_TIERS.has(d.contentTier) || len < 400
  );
}

/** Short record whose text failed to scrape into a real article. */
function isJunkFile(d) {
  const len = ((d && d.fullText) || '').length;
  return len < 1000 && (WEAK_TIERS.has(d.contentTier) || WEAK_REASONS.has(d.incompleteReason));
}

const SHINGLE_WORDS = 5;
const OWNS_FRACTION = 0.7;
const FOREIGN_FRACTION = 0.3;

function shingles(norm) {
  const w = norm.split(' ').filter(Boolean);
  const out = new Set();
  for (let i = 0; i + SHINGLE_WORDS <= w.length; i++) out.add(w.slice(i, i + SHINGLE_WORDS).join(' '));
  return out;
}

/**
 * Fraction (0..1) of the excerpt's 5-word shingles found in the record's OWN
 * fullText. Shingles, not substring, because aggregator excerpts splice
 * passages with "..." and a substring test would call every spliced excerpt
 * foreign. Text no longer than 1.5x the excerpt is not independent evidence
 * (web-search records copied the excerpt INTO fullText), so it scores 0.
 */
function excerptCoverage(d, normExcerpt) {
  const t = normText(d.fullText);
  if (t.length <= normExcerpt.length * 1.5) return 0;
  const ex = shingles(normExcerpt);
  if (!ex.size) return contains(t, normExcerpt) ? 1 : 0;
  const ts = shingles(t);
  let hit = 0;
  for (const g of ex) if (ts.has(g)) hit++;
  return hit / ex.size;
}

function sameCritic(a, b) {
  const x = normCritic(a.criticName);
  const y = normCritic(b.criticName);
  if (!x || !y) return false;
  if (x === y) return true;
  // "john chavez" inside "david john chavez", "scott reedy" inside "r scott reedy"
  const tx = x.split(' ');
  const ty = y.split(' ');
  const [short, long] = tx.length <= ty.length ? [tx, ty] : [ty, tx];
  if (short.length >= 2 && short.every((t) => long.includes(t))) return true;
  // typo twins (biedenahrn/biedenharn, elisabeth/elizabeth): edit distance <= 2
  if (Math.abs(x.length - y.length) > 2) return false;
  const m = Array.from({ length: x.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= y.length; j++) m[0][j] = j;
  for (let i = 1; i <= x.length; i++) {
    for (let j = 1; j <= y.length; j++) {
      m[i][j] = Math.min(m[i - 1][j] + 1, m[i][j - 1] + 1, m[i - 1][j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
    }
  }
  return m[x.length][y.length] <= 2;
}

function isFileExcluded(d) {
  if (!d) return true;
  if (d.duplicateOf) return true;
  return EXCLUSION_FLAGS.some((f) => d[f] === true || (typeof d[f] === 'string' && d[f]));
}

/**
 * Classify one pair sharing an excerpt.
 * @param {{file:string,data:object}} a
 * @param {{file:string,data:object}} b
 * @returns {{cls:'same-review'|'phantom'|'excerpt-copy'|'unresolved', reason:string,
 *   phantom?:string, owner?:string, stripFrom?:string}}
 */
function classifyPair(a, b) {
  const same = isSameArticle(a.data, b.data);
  if (same.same) return { cls: 'same-review', reason: same.reason };
  const ga = isUnverifiableGuess(a.data) && isAttestedFull(b.data);
  const gb = isUnverifiableGuess(b.data) && isAttestedFull(a.data);
  if (ga !== gb) return { cls: 'phantom', reason: 'unverifiable web-search guess (dead/mismatched url) beside an attested full review', phantom: ga ? a.file : b.file };

  const wa = isWeakWebSearch(a.data);
  const wb = isWeakWebSearch(b.data);
  if (wa !== wb) {
    const phantom = wa ? a.file : b.file;
    return { cls: 'phantom', reason: 'web-search record with weak text/url, sibling is not', phantom };
  }

  const shared = sharedExcerpts(a.data, b.data);
  const cov = (d) => Math.max(0, ...shared.map((x) => excerptCoverage(d, x)));
  const ca = cov(a.data);
  const cb = cov(b.data);
  // One critic reviews a production once per outlet, so two files under the
  // same (or typo-variant) byline are one review whose text differs by scrape
  // noise (nav boilerplate, retired-subdomain copy) - UNLESS the texts are
  // different articles (the-coast-of-utopia-2006: Brantley on Voyage vs on
  // Shipwreck, one excerpt copied across). So require the excerpt to sit in
  // both texts, or one side to have no real text of its own.
  if (sameCritic(a.data, b.data)) {
    const noText = (d) => normText(d.fullText).length < LONG_TEXT_CHARS;
    if (ca >= OWNS_FRACTION && cb >= OWNS_FRACTION) return { cls: 'same-review', reason: 'same critic byline, excerpt in both texts' };
    if (noText(a.data) || noText(b.data)) return { cls: 'same-review', reason: 'same critic byline, one side has no text' };
  }
  const aOwns = ca >= OWNS_FRACTION && cb < FOREIGN_FRACTION;
  const bOwns = cb >= OWNS_FRACTION && ca < FOREIGN_FRACTION;
  if (aOwns || bOwns) {
    return {
      cls: 'excerpt-copy', reason: `excerpt is inside only one file's own fullText (${ca.toFixed(2)} vs ${cb.toFixed(2)})`,
      owner: aOwns ? a.file : b.file, stripFrom: aOwns ? b.file : a.file,
    };
  }
  // Neither text owns the excerpt. If exactly one side is scrape junk (short,
  // truncated/dead-url) the other is the real article and the junk file is the
  // phantom (time-stands-still-2010: nav boilerplate filed under a wrong byline).
  const ja = isJunkFile(a.data);
  const jb = isJunkFile(b.data);
  if (ja !== jb) return { cls: 'phantom', reason: 'scrape-junk record beside a real article', phantom: ja ? a.file : b.file };
  return { cls: 'unresolved', reason: `excerpt ownership undecided (${ca.toFixed(2)} vs ${cb.toFixed(2)})` };
}

/** Fields of `data` holding any of the shared normalized excerpts. */
function fieldsHoldingExcerpts(data, sharedNorm) {
  const set = new Set(sharedNorm);
  const out = [];
  for (const f of EXCERPT_FIELDS) {
    const v = data[f];
    if (typeof v === 'string' && v.length > MIN_EXCERPT_CHARS && set.has(normText(v))) out.push(f);
  }
  return out;
}

// Identical-article detection (BRO-4412). Aggregator-excerpt sharing misses
// web-search phantoms whose fullText is a copy of the real article under a
// guessed byline/URL (3 Variety rows on a-dolls-house-2023). Two same-outlet
// files that carry the same article (near-identical text or same canonical
// URL) are one review however many bylines they wear.
const MIN_ARTICLE_CHARS = 150;
// A web-search record whose URL could not be fetched or matched to the show:
// its byline/text are a guess and cannot stand beside a real sibling.
const UNVERIFIABLE_REASONS = new Set(['url_dead', 'url_content_mismatch', 'wrong_content', 'scraper_garbage']);

/** Same article by text or URL, ignoring the excerpt fields. */
function isSameArticle(a, b) {
  const ta = normText(a.fullText);
  if (ta.length >= MIN_ARTICLE_CHARS && ta === normText(b.fullText)) return { same: true, reason: 'identical fullText' };
  return isSameReview(a, b);
}

/** Web-search record with an unfetchable/mismatched URL: an unverified guess. */
function isUnverifiableGuess(d) {
  return Boolean(d && WEAK_SOURCES.has(d.source) && normText(d.fullText).length < 1000
    && (UNVERIFIABLE_REASONS.has(d.incompleteReason) || (d.fetchDiscoveryAbandoned && normText(d.fullText).length < 400))
    && !(d.sources || []).some((s) => !WEAK_SOURCES.has(s)));
}

/** A real (non-web-search, full-length) live review from this outlet. */
function isAttestedFull(d) {
  return Boolean(d && !WEAK_SOURCES.has(d.source) && normText(d.fullText).length >= LONG_TEXT_CHARS && !isFileExcluded(d));
}

/**
 * All same-outlet pairs in one show directory that share an excerpt, carry the
 * same article (text/URL), or pair an unverifiable web-search guess with an
 * attested full review from the same outlet (Time Out "Adam Feldman" beside
 * Melissa Rose Bernardo on for-colored-girls: guessed dead URL, 160 chars).
 * @param {{file:string,data:object}[]} records
 * @returns {{a:object,b:object,shared:string[],via?:string}[]}
 */
function findClonedPairs(records) {
  const byOutlet = new Map();
  for (const r of records) {
    const outlet = (r.data && r.data.outletId) || r.file.split('--')[0];
    if (!byOutlet.has(outlet)) byOutlet.set(outlet, []);
    byOutlet.get(outlet).push(r);
  }
  const pairs = [];
  for (const arr of byOutlet.values()) {
    for (let i = 0; i < arr.length; i++) {
      for (let j = i + 1; j < arr.length; j++) {
        const [x, y] = [arr[i], arr[j]];
        const shared = sharedExcerpts(x.data, y.data);
        if (shared.length) { pairs.push({ a: x, b: y, shared }); continue; }
        const same = isSameArticle(x.data, y.data);
        if (same.same) { pairs.push({ a: x, b: y, shared: [], via: same.reason }); continue; }
        if ((isUnverifiableGuess(x.data) && isAttestedFull(y.data)) || (isUnverifiableGuess(y.data) && isAttestedFull(x.data))) {
          pairs.push({ a: x, b: y, shared: [], via: 'unverifiable-guess' });
        }
      }
    }
  }
  return pairs;
}

/**
 * Write-time guard. Given the record about to be written and its same-show
 * siblings, return the excerpt fields to strip from the INCOMING record.
 * Conservative: only strips where the sibling provably owns the excerpt
 * (excerpt-copy) or the incoming record is the weak phantom. Same-review
 * twins are the duplicate machinery's job and are left alone here.
 *
 * @param {string} file basename being written
 * @param {object} incoming record about to be written
 * @param {{file:string,data:object}[]} siblings other files in the show dir
 * @returns {{fields:string[], because:string[]}}
 */
function excerptFieldsToStrip(file, incoming, siblings) {
  const fields = new Set();
  const because = [];
  const outlet = incoming.outletId || file.split('--')[0];
  for (const s of siblings) {
    if (s.file === file || isFileExcluded(s.data)) continue;
    if (((s.data && s.data.outletId) || s.file.split('--')[0]) !== outlet) continue;
    const shared = sharedExcerpts(incoming, s.data);
    if (!shared.length) continue;
    const c = classifyPair({ file, data: incoming }, s);
    const stripIncoming = (c.cls === 'excerpt-copy' && c.stripFrom === file)
      || (c.cls === 'phantom' && c.phantom === file);
    if (!stripIncoming) continue;
    for (const f of fieldsHoldingExcerpts(incoming, shared)) fields.add(f);
    because.push(`${s.file}: ${c.cls}`);
  }
  return { fields: [...fields], because };
}

/**
 * Write-time refusal (BRO-4412). Is the INCOMING web-search record a phantom of
 * a live same-outlet sibling under a different byline: same article, or an
 * unverifiable guess beside an attested full review? Web-search is the only
 * writer that guesses bylines/URLs, so only its records are refused; an
 * attested (aggregator/scrape) record is never blocked here.
 * @returns {string|null} the sibling file it duplicates, else null
 */
function phantomOfSibling(file, incoming, siblings) {
  if (!incoming || incoming.source !== 'web-search') return null;
  const outlet = incoming.outletId || file.split('--')[0];
  for (const s of siblings) {
    if (s.file === file || isFileExcluded(s.data)) continue;
    if (((s.data && s.data.outletId) || s.file.split('--')[0]) !== outlet) continue;
    if (sameCritic(incoming, s.data)) continue; // same byline = the same file's rewrite, not a phantom
    // Not classifyPair: with no shared excerpt its weak/junk branches would
    // refuse a genuine short second critic. Only provable phantoms are refused.
    if (isSameArticle(incoming, s.data).same) return s.file;
    if (isUnverifiableGuess(incoming) && isAttestedFull(s.data)) return s.file;
  }
  return null;
}

module.exports = {
  phantomOfSibling,
  MIN_EXCERPT_CHARS,
  EXCLUSION_FLAGS,
  normText,
  normCritic,
  excerptValues,
  sharedExcerpts,
  canonUrl,
  isSameReview,
  isSameArticle,
  isUnverifiableGuess,
  isAttestedFull,
  isWeakWebSearch,
  excerptCoverage,
  sameCritic,
  isFileExcluded,
  classifyPair,
  fieldsHoldingExcerpts,
  findClonedPairs,
  excerptFieldsToStrip,
};
