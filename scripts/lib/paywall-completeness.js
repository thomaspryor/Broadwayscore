'use strict';

/**
 * paywall-completeness.js — is a hard-paywall review text the WHOLE review?
 * (BRO-4334)
 *
 * School Girls opening night (2026-09-29): ScrapingBee returned only page one
 * of Helen Shaw's NYT Critic's Pick (3,283 chars, prose + a bare "Helen Shaw"
 * byline, no production info box). The collector's tier loop accepted the
 * first non-garbage result, so the logged-in Browserbase tier never ran, the
 * text was tiered 'complete' (the old 3,000-char NYT floor passed it, and the
 * lone `no_ending_punctuation` signal was tolerated), and it scored 78 off a
 * partial review.
 *
 * Two pure decisions live here so the collector and its tests share them:
 *   - assessPaywallCompleteness(): does this text look like the full article?
 *   - decideTierResult(): stop the tier loop now, or keep the better of the
 *     results so far and try the next tier?
 *
 * Completeness rule (hard-paywall domains only):
 *   complete  ⇔  no paywall/bot-wall tail  AND
 *                ( the body ends with a production info box
 *                  ("Running time: …", "…; lortel.org.")
 *                  OR (body length ≥ domain floor AND ends in punctuation) )
 * The info-box ending is how modern NYT/WaPo/etc. reviews end; having it means
 * we reached the end of the article, so short-but-whole off-Broadway capsules
 * are not penalised by the floor. A trailing critic byline is stripped before
 * checking (complete NYT pages end "…Running time: 2 hours. Jesse Green";
 * page-one captures end "…prose.) Helen Shaw").
 */

const { cleanText } = require('./text-quality');
const { TRUNCATION_SIGNALS } = require('./content-quality');

// Per-domain character floors for texts WITHOUT an info-box ending.
// Derived from the review-texts corpus (2026-09-29, contentTier=complete):
//   nytimes p10 ≈ 4,560 / median ≈ 6,700; newyorker p10 ≈ 5,500;
//   washingtonpost p10 ≈ 3,900; chicagotribune p10 ≈ 3,840; wsj p10 ≈ 2,300.
const HARD_PAYWALL_FLOORS = Object.freeze({
  'nytimes.com': 4500,
  'newyorker.com': 4000,
  'washingtonpost.com': 3000,
  'chicagotribune.com': 3000,
  'wsj.com': 2500,
});

// Texts at least this multiple of the floor may end without punctuation.
const CHROME_TOLERANT_MULTIPLIER = 1.5;

const HARD_PAYWALL_DOMAINS = Object.freeze(Object.keys(HARD_PAYWALL_FLOORS));

// Production info box that closes a review ("Running time: 1 hour 40 minutes.",
// "Samuel J. Friedman Theater, Manhattan; manhattantheatreclub.com.").
// Checked against the last ~300 chars of the byline-stripped body only.
const INFO_BOX_ENDING_PATTERNS = [
  /running time\s*:?[^.]{0,60}\.?\s*$/i,
  /\b\d+\s*(hours?|hrs?|minutes?|mins?)\b[^.]{0,40}(intermissions?|intervals?)?\.?\s*$/i,
  /\b(one|no|with an?|two)\s+intermissions?\.?\s*$/i,
  /\.(com|org|net|nyc|co\.uk)\/?\s*\.?\s*$/i,
  /\b(Manhattan|Brooklyn|Queens|Bronx|Chicago|Washington|D\.C\.)\s*;/,
];

// Paywall / continue prompts near the end of the text — deliberately narrow
// phrases (bare "sign in"/"subscribe" false-positive on prose like "design in").
const PAYWALL_TAIL_RE = /\b(subscribe (now|today|to (continue|read|keep))|already a subscriber|(log|sign) in to (continue|read|keep)|create a free account|continue reading|to read the full (article|review|story)|subscriber[- ]only|for subscribers only)\b/i;

// Page furniture that survives stripTrailingJunk at the very end of some
// captures ("… Comments Sign up", "… Advertisement"). Stripped (repeatedly)
// before the ending is judged; never touches prose.
const TAIL_FURNITURE_RE = /\s*(?:Comments|Sign up|Advertisement|SKIP ADVERTISEMENT|Share full article|Give this article|Learn more)\s*$/i;

function stripTailFurniture(text) {
  let out = text;
  for (let i = 0; i < 6; i++) {
    const next = out.replace(TAIL_FURNITURE_RE, '');
    if (next === out) break;
    out = next;
  }
  return out;
}

const BOT_STUB_PATTERNS = (TRUNCATION_SIGNALS && TRUNCATION_SIGNALS.severeAnywhere) || [];

/** Hard-paywall domain key for a URL, or null. Subdomains match (www., cooking.). */
function getHardPaywallDomain(url) {
  if (!url || typeof url !== 'string') return null;
  let host;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
  return HARD_PAYWALL_DOMAINS.find((d) => host === d || host.endsWith(`.${d}`)) || null;
}

function isHardPaywallUrl(url) {
  return getHardPaywallDomain(url) !== null;
}

const NAME_LINE_RE = /^[A-Z][\p{L}.'’-]+(?:\s+[A-Z][\p{L}.'’-]+){1,3}$/u;

/**
 * Remove a trailing critic byline. Recognises (a) the review's own critic name
 * at the very end, and (b) a final short Name-Case line with no punctuation.
 * @returns {{ body: string, bylineStripped: boolean }}
 */
function stripTrailingByline(text, criticName) {
  let body = String(text || '').replace(/\s+$/, '');
  const name = typeof criticName === 'string' ? criticName.trim() : '';
  if (name && name.length >= 4 && body.toLowerCase().endsWith(name.toLowerCase())) {
    const before = body.slice(0, body.length - name.length);
    // Must be a separate token (not the tail of a longer word).
    if (before === '' || /[\s.!?"'”’)\]]$/.test(before)) {
      return { body: before.replace(/\s+$/, ''), bylineStripped: true };
    }
  }
  const nl = body.lastIndexOf('\n');
  if (nl > 0) {
    const lastLine = body.slice(nl + 1).trim();
    if (lastLine.length > 0 && lastLine.length <= 40 && NAME_LINE_RE.test(lastLine)) {
      return { body: body.slice(0, nl).replace(/\s+$/, ''), bylineStripped: true };
    }
  }
  return { body, bylineStripped: false };
}

/**
 * Assess whether a hard-paywall text is the complete article.
 *
 * @param {string} text  raw extracted text (tier result) or stored fullText
 * @param {string} url   review URL (decides the domain + floor)
 * @param {{ criticName?: string }} [opts]
 * @returns {{
 *   hardPaywall: boolean, domain: string|null, floor: number|null,
 *   length: number, complete: boolean, infoBoxEnding: boolean,
 *   bylineStripped: boolean, reasons: string[]
 * }}
 *   For non-hard-paywall URLs, `complete` is always true (no opinion — the
 *   caller keeps its existing behaviour).
 */
function assessPaywallCompleteness(text, url, opts = {}) {
  const domain = getHardPaywallDomain(url);
  const raw = typeof text === 'string' ? text : '';
  if (!domain) {
    return {
      hardPaywall: false, domain: null, floor: null, length: raw.length,
      complete: true, infoBoxEnding: false, bylineStripped: false, reasons: [],
    };
  }
  const floor = HARD_PAYWALL_FLOORS[domain];
  const reasons = [];

  if (BOT_STUB_PATTERNS.some((p) => p.test(raw))) reasons.push('bot_wall_stub');

  // Endings are judged on the RAW text (byline + page furniture stripped,
  // whitespace collapsed): cleanText()'s stripTrailingJunk can chop the info
  // box, the paywall prompt, or even mid-sentence, which would hide exactly
  // the signals we are looking for. Length uses the cleaned body so nav/junk
  // does not count toward the floor.
  const first = stripTrailingByline(stripTailFurniture(raw.replace(/\s+$/, '')), opts.criticName);
  const collapsed = first.body.replace(/\s+/g, ' ').trim();
  const second = stripTrailingByline(collapsed, opts.criticName);
  const rawBody = stripTailFurniture(second.body);
  const bylineStripped = first.bylineStripped || second.bylineStripped;
  const cleanedBody = cleanText(rawBody) || '';
  const length = Math.min(cleanedBody.length || rawBody.length, rawBody.length);

  if (PAYWALL_TAIL_RE.test(rawBody.slice(-600))) reasons.push('paywall_prompt');

  const tail = rawBody.slice(-300);
  const infoBoxEnding = INFO_BOX_ENDING_PATTERNS.some((p) => p.test(tail));
  const endsWithPunctuation = /[.!?"'”’)\]]\s*$/.test(rawBody);

  if (!infoBoxEnding) {
    // A bad ending on a SHORT text is a cut-off; on a long one it is almost
    // always trailing page chrome ("… Manage Privacy Preferences") after a
    // whole review (corpus check 2026-09-29), so it is tolerated there.
    if (!endsWithPunctuation && length < floor * CHROME_TOLERANT_MULTIPLIER) reasons.push('no_ending_punctuation');
    if (length < floor) reasons.push(`below_floor:${length}<${floor}`);
    if (bylineStripped && length < floor) reasons.push('trailing_byline_after_prose');
  }

  return {
    hardPaywall: true,
    domain,
    floor,
    length,
    complete: reasons.length === 0,
    infoBoxEnding,
    bylineStripped,
    reasons,
  };
}

/**
 * Rank two tier candidates: complete beats partial; otherwise the longer
 * assessed body wins. Candidates are `{ assessment, ... }`.
 */
function isBetterCandidate(candidate, incumbent) {
  if (!incumbent) return true;
  if (!candidate) return false;
  const c = candidate.assessment || {};
  const i = incumbent.assessment || {};
  if (!!c.complete !== !!i.complete) return !!c.complete;
  return (c.length || 0) > (i.length || 0);
}

/**
 * Tier-loop decision for one non-garbage tier result.
 *
 * @param {{ best: object|null, candidate: object, url: string, criticName?: string }} args
 *   candidate: the tier result ({ text, method, ... }); `best` is the best
 *   partial kept so far (as returned in a previous decision's `best`).
 * @returns {{ action: 'accept'|'continue', best: object|null, assessment: object }}
 *   'accept'   → stop and use `candidate` now (complete, or not a hard-paywall URL).
 *   'continue' → try the next tier; `best` is the better of best/candidate
 *                (with `.assessment` attached) to fall back to at the end.
 */
function decideTierResult({ best = null, candidate, url, criticName } = {}) {
  const assessment = assessPaywallCompleteness(candidate && candidate.text, url, { criticName });
  if (!assessment.hardPaywall || assessment.complete) {
    return { action: 'accept', best, assessment };
  }
  const annotated = { ...candidate, assessment };
  return {
    action: 'continue',
    best: isBetterCandidate(annotated, best) ? annotated : best,
    assessment,
  };
}

// Logged-in tiers tried next once a hard-paywall partial is in hand. The
// weekly regenerate-tier-configs job owns the per-domain START order (and now
// counts partial text as failure); this only decides what runs after a
// partial, so the credentialed session is reached inside the review's time
// budget instead of after several archive lookups.
const PARTIAL_ESCALATION_TIER_IDS = Object.freeze(['browserbase', 'direct-cookies']);

/**
 * Reorder the not-yet-run tiers after the first partial result: escalation
 * tiers first (in PARTIAL_ESCALATION_TIER_IDS order), the rest keep their
 * relative order. Pure; returns a new array.
 * @param {Array<{id: string}>} remaining
 */
function escalateAfterPartial(remaining) {
  const list = Array.isArray(remaining) ? remaining : [];
  const front = [];
  for (const id of PARTIAL_ESCALATION_TIER_IDS) {
    const t = list.find((x) => x && x.id === id);
    if (t) front.push(t);
  }
  return front.concat(list.filter((x) => !front.includes(x)));
}

// Source methods whose hard-paywall text may be a partial capture. Human /
// subscriber-recovery sources (manual-entry, url-ingest, *-otp-login,
// newspapers-com-ocr) are trusted as-is.
const SCRAPED_SOURCE_METHODS = Object.freeze(new Set([
  'brightdata', 'scrapingbee', 'scrapingbee_premium', 'archive', 'playwright',
  'browserbase', 'direct-cookies', 'amp', 'archive-today',
]));

// Opening-window recheck: a stored 'complete' hard-paywall text first seen
// this recently is re-assessed by the collector (and re-fetched if partial).
const RECHECK_WINDOW_MS = 3 * 24 * 3600 * 1000;

/**
 * Should the collector re-fetch a stored hard-paywall review that is labelled
 * 'complete'? True only inside the opening window, for scraped sources, when
 * the stored text fails assessPaywallCompleteness. Bounded by the window so a
 * bulk run never re-fetches the historical corpus.
 *
 * @param {object} data review-text file
 * @param {number} nowMs
 */
function needsPaywallRecheck(data, nowMs = Date.now()) {
  if (!data || data.contentTier !== 'complete' || !data.fullText) return false;
  if (!isHardPaywallUrl(data.url)) return false;
  if (!SCRAPED_SOURCE_METHODS.has(data.sourceMethod || data.fetchMethod)) return false;
  // firstSeenAt only — textFetchedAt is reset on every write, which would
  // pull old files back into the window.
  const seen = Date.parse(data.firstSeenAt || '');
  if (!Number.isFinite(seen) || nowMs - seen > RECHECK_WINDOW_MS) return false;
  return !assessPaywallCompleteness(data.fullText, data.url, { criticName: data.criticName }).complete;
}

const PAYWALL_TRUNCATION_REASON_RE = /^Paywall truncation:/;

// Soft-paywall hosts: text shorter than this from a scraper is a paywall hit,
// not a capsule review. Single source for the collector's label and the
// rebuild's override (was inline in collect-review-texts.js).
const SOFT_PAYWALL_MIN_CHARS = {
  'ft.com': 2000,
  'vulture.com': 2500,
  'nymag.com': 2500,
  'bloomberg.com': 2000,
};

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch (_) { return null; }
}

/**
 * Rebuild-side tier decision (BRO-4334 ship-check P1). rebuild-all-reviews.js
 * re-runs classifyContentTier() on every file and writes the result back, which
 * reset the collector's 'truncated' label to 'complete'. This keeps a paywall
 * truncation in force while the stored text still fails the assessment.
 *
 * Scoped so the historical corpus is NOT mass-reclassified: only files the
 * collector already labelled ("Paywall truncation: …" reason) or first seen
 * inside the opening window, scraped sources only, hard-paywall URLs only.
 *
 * @param {object} data review-text record (pre-reclassification fields)
 * @param {{contentTier: string, tierReason?: string}} tierResult classifyContentTier() output
 * @param {number} [nowMs]
 * @returns {object} tierResult, or a copy overridden to 'truncated'
 */
function applyPaywallTierOverride(data, tierResult, nowMs = Date.now()) {
  if (!data || !tierResult || tierResult.contentTier !== 'complete' || !data.fullText) return tierResult;
  if (!SCRAPED_SOURCE_METHODS.has(data.sourceMethod || data.fetchMethod)) return tierResult;
  const priorReason = data.contentTierReason || data.tierReason || '';
  const labelled = PAYWALL_TRUNCATION_REASON_RE.test(priorReason);
  if (!isHardPaywallUrl(data.url)) {
    // Soft-paywall sites (vulture.com, nymag.com, ft.com …) are labelled by the
    // collector's PAYWALL_MIN_CHARS rule. The label stands until the collector
    // rewrites the file (it re-derives the tier on every write), so a rebuild
    // must not reset it (ship-check P2, BRO-4334).
    const host = hostOf(data.url);
    const minChars = host && SOFT_PAYWALL_MIN_CHARS[host];
    if (!labelled || !minChars || data.fullText.length >= minChars) return tierResult;
    const reason = `Paywall truncation: ${data.fullText.length} chars < ${minChars} min for ${host} (source: ${data.sourceMethod || data.fetchMethod})`;
    return { ...tierResult, contentTier: 'truncated', tierReason: reason, paywallOverride: true };
  }
  const seen = Date.parse(data.firstSeenAt || '');
  const inWindow = Number.isFinite(seen) && nowMs - seen <= RECHECK_WINDOW_MS;
  if (!labelled && !inWindow) return tierResult;
  const a = assessPaywallCompleteness(data.fullText, data.url, { criticName: data.criticName });
  if (a.complete) return tierResult;
  const reason = `Paywall truncation: ${a.reasons.join(', ')} for ${a.domain} (source: ${data.sourceMethod || data.fetchMethod})`;
  return { ...tierResult, contentTier: 'truncated', tierReason: reason, paywallOverride: true };
}

/**
 * Field patch that re-labels a stored hard-paywall text as truncated when it
 * fails the assessment (used when a re-fetch keeps the stored text), or null.
 */
function truncatedTierPatch(data) {
  if (!data || data.contentTier !== 'complete' || !data.fullText) return null;
  if (!isHardPaywallUrl(data.url)) return null;
  if (!SCRAPED_SOURCE_METHODS.has(data.sourceMethod || data.fetchMethod)) return null;
  const a = assessPaywallCompleteness(data.fullText, data.url, { criticName: data.criticName });
  if (a.complete) return null;
  const reason = `Paywall truncation: ${a.reasons.join(', ')} for ${a.domain} (source: ${data.sourceMethod || data.fetchMethod})`;
  return {
    contentTier: 'truncated',
    tierReason: reason,
    contentTierReason: reason,
    textStatus: 'truncated',
    textQuality: 'truncated',
    isFullReview: false,
  };
}

/**
 * After a re-fetch that did not produce complete text: should the stored text
 * be kept instead of overwriting it with the new (still partial) result?
 * True when the stored text is at least as good by the same ranking.
 */
function shouldKeepStoredText({ storedText, newText, url, criticName } = {}) {
  if (!storedText || !isHardPaywallUrl(url)) return false;
  const stored = { assessment: assessPaywallCompleteness(storedText, url, { criticName }) };
  const fresh = { assessment: assessPaywallCompleteness(newText, url, { criticName }) };
  return !isBetterCandidate(fresh, stored);
}

module.exports = {
  SOFT_PAYWALL_MIN_CHARS,
  HARD_PAYWALL_FLOORS,
  HARD_PAYWALL_DOMAINS,
  getHardPaywallDomain,
  isHardPaywallUrl,
  stripTrailingByline,
  assessPaywallCompleteness,
  isBetterCandidate,
  decideTierResult,
  shouldKeepStoredText,
  PARTIAL_ESCALATION_TIER_IDS,
  escalateAfterPartial,
  SCRAPED_SOURCE_METHODS,
  RECHECK_WINDOW_MS,
  needsPaywallRecheck,
  truncatedTierPatch,
  applyPaywallTierOverride,
};
