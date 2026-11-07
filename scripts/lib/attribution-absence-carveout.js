'use strict';
/**
 * BRO-6491: neutralize content-verifier rejections whose ONLY objection is that
 * the scraped body does not show the critic byline or outlet name.
 *
 * Scraped article bodies routinely omit page headers, bylines and branding
 * (Exeunt Magazine rows were rejected for exactly this). The prompt already
 * says missing attribution is neutral; this is the deterministic backstop.
 *
 * Deliberately narrow. Two word-bag versions leaked in review (stub pages
 * "only the byline, no review text", a near-spelled different critic), so an
 * issue now counts only when the WHOLE normalized string matches one anchored
 * template below. The templates were written from the issue strings the
 * verifier actually stored on byline-only rejections (see the test file); the
 * expected critic / outlet appear only as exact (case/diacritic/whitespace-
 * normalized) names, never by edit distance. Anything else keeps the issue.
 *
 * The verdict changes only when EVERY issue matches and the model set no
 * wrongArticle / wrongProduction / isFilmTv / truncated flag and called it a
 * review. Otherwise the verdict is returned unchanged.
 */

function norm(s) {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[‘’“”'"()]/g, '')
    .replace(/\s*[—–]\s*/g, ': ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\.$/, '');
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

// Building blocks. <N> is replaced per call by the exact expected names.
const SUBJ = '(?:critic|outlet)(?:/publication)?(?: name| byline| attribution)?';
const HEAD = `(?:missing (?:critic|outlet) (?:byline|attribution)|${SUBJ} missing|${SUBJ} not (?:found|identified)(?: in scraped content)?)`;
const LOC = '(?: anywhere)? (?:(?:in|from) (?:the )?(?:scraped|review) (?:text|content)|in the article)';
const NOTPRESENT = '(?:is|are) not (?:named|identified|present|mentioned)';
const BODIES = [
  // expected <c> but no byline is present [in the scraped content]
  `(?:the )?expected (?:critic |outlet )?<N>(?: from <N>)?,? but no (?:byline|outlet attribution|byline or outlet attribution) (?:is present|appears)(?:${LOC})?`,
  // the expected critic is <c>, but no byline is present in the scraped content
  `(?:the )?expected (?:critic|outlet) is <N>,? but no (?:byline|outlet attribution) is present${LOC}`,
  // expected critic <c> is not named anywhere in the scraped text / not found in scraped content
  `expected (?:critic |outlet )?<N>(?: and (?:critic|outlet) <N>)? (?:${NOTPRESENT}|not found)${LOC}`,
  // scraped content does not name <c> as the author
  'scraped content does not name <N> as the author',
  // no attribution to <o> found in scraped text
  `no attribution to <N> found${LOC}`,
  // no author name <c> expected appears in the scraped text
  `no (?:author|outlet) name <N> expected appears${LOC}`,
  // critic name <c> does not appear ... / outlet <o> is not identified ... / the byline/author <c> is not present ...
  `(?:${SUBJ}|the byline/author) <N> (?:does not appear|${NOTPRESENT})${LOC}`,
  `<N> ${NOTPRESENT}${LOC}`,
  // outlet attribution to <o> cannot be verified from the scraped content
  `${SUBJ} to <N> cannot be verified${LOC}`,
  'no byline or critic attribution is present in the article',
  `cannot verify (?:outlet or critic|critic or outlet) attribution${LOC}`,
  'cannot verify attribution to stated critic',
  `byline does not appear${LOC}`,
  // expected critic is <c>; no critic name is present in the review text
  `expected (?:critic|outlet) is <N>; no (?:critic|outlet)(?:/publication)? name is present${LOC}`,
];

function templateFor(names) {
  const exact = [names.criticName, names.outletName].map(norm).filter((n) => n.length >= 3);
  // No usable name: templates that need one cannot match.
  const N = exact.length ? `(?:${exact.map(escapeRe).join('|')})` : '(?!)';
  const body = `(?:${BODIES.join('|')})`.replace(/<N>/g, N);
  return new RegExp(`^(?:${HEAD}[:;] )?${body}(?:(?:; |\\. |: )${body})?$`);
}

/**
 * Whether the whole issue string only says the expected byline / outlet is not
 * shown in the scraped text.
 */
function isAttributionAbsenceIssue(issue, names) {
  const n = norm(issue);
  return !!n && templateFor(names || {}).test(n);
}

/**
 * Restore a verifier verdict rejected only for missing byline/outlet.
 * Returns { applied, isValid, issues, dropped }.
 */
function applyAttributionAbsenceCarveout(v, names) {
  if (!v || typeof v !== 'object') return { applied: false, isValid: false, issues: [], dropped: [] };
  const issues = Array.isArray(v.issues) ? v.issues.map(String) : [];
  const isValid = v.isValid ?? true;
  const unchanged = { applied: false, isValid, issues, dropped: [] };
  if (isValid || !issues.length) return unchanged;
  if (v.wrongArticle || v.wrongProduction || v.isFilmTv || v.truncated) return unchanged;
  if (v.articleType && v.articleType !== 'review') return unchanged;
  if (!issues.every((i) => isAttributionAbsenceIssue(i, names || {}))) return unchanged;
  return { applied: true, isValid: true, issues: [], dropped: issues };
}

module.exports = { isAttributionAbsenceIssue, applyAttributionAbsenceCarveout };
