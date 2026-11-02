'use strict';
/**
 * BRO-6491: neutralize content-verifier rejections whose ONLY objection is that
 * the scraped body does not show the critic byline or outlet name.
 *
 * Scraped article bodies routinely omit page headers, bylines and branding
 * (Exeunt Magazine rows were rejected for exactly this). The prompt already
 * says missing attribution is neutral; this is the deterministic backstop.
 *
 * Deliberately narrow (an earlier, looser carve-out was rejected in review
 * because it could flip wrong-article / truncated verdicts):
 *   - an issue counts only when its WHOLE text is an absence-of-byline/outlet
 *     clause: every word is attribution / absence / filler vocabulary or a
 *     (near-)spelling of the expected critic or outlet name. Any other word
 *     ("truncated", "different", "AP", "excerpt", "date", "venue", a third
 *     person's name, a digit) keeps the issue.
 *   - "is not <X>" / "not by" / "not from" (an identity claim, i.e. a
 *     different critic or outlet) keeps the issue.
 *   - the verdict changes only when EVERY issue is such a clause and the model
 *     set no wrongArticle / wrongProduction / isFilmTv / truncated flag and
 *     called it a review. Otherwise the verdict is returned unchanged.
 */

const SUBJECT = new Set([
  'critic', 'critics', 'byline', 'bylines', 'author', 'authors', 'authorship', 'writer', 'reviewer',
  'outlet', 'outlets', 'publication', 'publications', 'publisher', 'attribution', 'attributions',
  'masthead', 'branding', 'credit', 'credited', 'signature',
]);

const ABSENCE = new Set([
  'no', 'not', 'missing', 'absent', 'absence', 'lacks', 'lacking', 'lack', 'without', 'cannot', 'unable',
  'unverified', 'unverifiable', 'none', 'neither', 'nor',
]);

// After "not", only an absence verb may follow ("not credited", "does not name").
const AFTER_NOT = new Set([
  'be', 'been', 'credited', 'credit', 'named', 'name', 'names', 'mentioned', 'mention', 'mentions', 'visible',
  'present', 'found', 'find', 'identified', 'identify', 'identifies', 'verified', 'verify', 'verifiable',
  'shown', 'listed', 'included', 'include', 'includes', 'provided', 'provide', 'given', 'stated',
  'displayed', 'available', 'confirmed', 'confirm', 'appear', 'appears',
  'specified', 'indicated', 'anywhere', 'clearly', 'explicitly',
]);

const FILLER = new Set([
  ...AFTER_NOT,
  'name', 'names', 'expected', 'stated', 'the', 'a', 'an', 'in', 'of', 'from', 'to', 'is', 'are', 'was', 'were',
  'be', 'been', 'any', 'this', 'that', 'it', 'its', 'for', 'on', 'with', 'by', 'or', 'and', 'either',
  'as', 'there',
  'does', 'do', 'did', 'can', 'could', 'so', 'but', 'information', 'line', 'visible', 'verification', 'confirmation',
  'confirmable', 'attributed', 'attribute', 'appearing', 'present', 'here', 'also', 'same',
]);

// Where the byline is missing FROM: "in the scraped text", "from the provided
// content", "scraped content does not name ...". Only these phrases may carry
// the words text/content/article/review/page/body: on their own those words
// describe the article ("no review content, only the byline") and keep the issue.
const LOCATION_PHRASE = new RegExp(
  '\\b(?:(?:in|from|within|on|of)\\s+(?:the\\s+|this\\s+|any\\s+)?(?:(?:scraped|provided|extracted|fetched|review|article)\\s+)*'
  + '|(?:the\\s+)?(?:scraped|provided|extracted|fetched)\\s+)(?:text|content|page|article|review|body|sample|copy)\\b',
  'g'
);

function tokens(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/'s\b/g, '')
    .replace(/n't\b/g, ' not')
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function editDistance(a, b) {
  if (Math.abs(a.length - b.length) > 2) return 3;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

/** Tokens of the expected critic / outlet names (a typo of one, like "Kalsall", still matches). */
function nameMatcher(names) {
  const known = [...new Set(names.flatMap(tokens).filter((t) => t.length >= 3 && !/^\d+$/.test(t)))];
  return (t, exact) => !/^\d+$/.test(t) && known.some((k) => k === t || (!exact && t.length >= 5 && editDistance(k, t) <= 1));
}

const IDENTITY = new Set(['by', 'is', 'was', 'are', 'were']);

/**
 * Whether the whole issue string only says the expected byline / outlet is not
 * shown in the scraped text.
 */
function isAttributionAbsenceIssue(issue, names) {
  const { criticName, outletName } = names || {};
  if (!tokens(issue).length) return false;
  const toks = tokens(String(issue).toLowerCase().replace(LOCATION_PHRASE, ' '));
  const isName = nameMatcher([criticName, outletName].filter(Boolean));
  // A near-spelling ("Greer" for "Green") is only a typo when nothing names
  // someone as the author: with "by" in the issue, or right after "is", exact only.
  const strictNames = toks.includes('by');
  let subject = false;
  let absence = false;
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t === 'not' && !AFTER_NOT.has(toks[i + 1])) return false;
    if (SUBJECT.has(t)) { subject = true; continue; }
    if (ABSENCE.has(t)) { absence = true; continue; }
    if (FILLER.has(t) || isName(t, strictNames || IDENTITY.has(toks[i - 1]))) continue;
    return false;
  }
  return subject && absence;
}

/**
 * Restore a verifier verdict rejected only for missing byline/outlet.
 * Returns { applied, isValid, issues, dropped }.
 */
function applyAttributionAbsenceCarveout(v, names) {
  const issues = Array.isArray(v && v.issues) ? v.issues.map(String) : [];
  const isValid = (v && v.isValid) ?? true;
  const unchanged = { applied: false, isValid, issues, dropped: [] };
  if (isValid || !issues.length) return unchanged;
  if (v.wrongArticle || v.wrongProduction || v.isFilmTv || v.truncated) return unchanged;
  if (v.articleType && v.articleType !== 'review') return unchanged;
  if (!issues.every((i) => isAttributionAbsenceIssue(i, names || {}))) return unchanged;
  return { applied: true, isValid: true, issues: [], dropped: issues };
}

module.exports = { isAttributionAbsenceIssue, applyAttributionAbsenceCarveout };
