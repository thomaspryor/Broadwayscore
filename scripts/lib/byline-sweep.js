/**
 * Pure decisions for scripts/sweep-websearch-bylines.js (BRO-5259).
 *
 * The sweep checks scored rows that only the deleted LLM 'web-search' step
 * ever vouched for (isLegacyWebSearchOnly) and that hold summary-length text:
 * does the stored url exist, and does the page name the stored critic?
 * Rows an aggregator also listed (sources include dtli/bww/playbill...) are
 * out of scope here: the aggregator vouches for the critic + show pair, and
 * odd pairs there belong to the tenure audit (BRO-5232).
 *
 * No I/O (CLAUDE.md section 15).
 */
'use strict';

const { isLegacyWebSearchOnly, legacyWebSearchFlagPatch } = require('./legacy-web-search');
const { EXCLUSION_FLAGS: COVERAGE_EXCLUSIONS } = require('./coverage-holes');
const { EXCLUSION_FLAGS: CLONE_EXCLUSIONS } = require('./cloned-excerpt-guard');

const SUMMARY_MAX_CHARS = 500;
// Any of these already keeps the row out of the composite (or records that a
// human/audit already decided), so the sweep has nothing to add.
const SKIP_FLAGS = [...new Set([
  ...COVERAGE_EXCLUSIONS, ...CLONE_EXCLUSIONS, 'isNonReview', 'crossOutletVerified',
])];

/**
 * Is this review file a sweep candidate?
 * @param {object} row review-texts record
 * @returns {boolean}
 */
function isSweepCandidate(row) {
  if (!row || row.source !== 'web-search' || !isLegacyWebSearchOnly(row)) return false;
  if (row.assignedScore == null) return false;
  if (String(row.fullText || '').length >= SUMMARY_MAX_CHARS) return false;
  if (row.fabricatedEntry === true || row.fabricatedEntry === false) return false;
  return !SKIP_FLAGS.some((k) => row[k]);
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Regex source matching the critic's first and last name, with an optional
 * middle name or initial between. A surname alone is not enough: "Green"
 * matched a cast list on an unrelated TheaterMania page (BRO-5259 hand-check).
 * Diacritics are folded off the stored name.
 * @param {string} criticName
 * @returns {string|null}
 */
const ACCENT_CLASS = { a: 'aàáâãäåā', e: 'eèéêëē', i: 'iìíîïī', o: 'oòóôõöøō', u: 'uùúûüū', c: 'cçć', n: 'nñń', s: 'sšś', z: 'zžź', y: 'yýÿ' };
// Tolerates accents on the page when the stored name has none (and the reverse).
function accentTolerant(word) {
  return word.split('').map((ch) => {
    const k = ch.toLowerCase();
    return ACCENT_CLASS[k] ? `[${ACCENT_CLASS[k]}${ACCENT_CLASS[k].toUpperCase()}]` : escapeRe(ch);
  }).join('');
}
const NAME_SUFFIX_RE = /^(?:jr|sr|ii|iii|iv)$/i;

function criticPattern(criticName) {
  const parts = String(criticName || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .split(/\s+/).map((p) => p.replace(/[^A-Za-z'.-]/g, '').replace(/\.+$/, ''))
    .filter((p) => /[a-z]/i.test(p) && !NAME_SUFFIX_RE.test(p));
  if (parts.length < 2) return null;
  const first = parts[0];
  const last = parts[parts.length - 1];
  // initials ("A. O. Scott", "A.O. Scott") are too weak to match on: no pattern, never a verdict against the row
  if (first.length < 2 || last.length < 2 || /\./.test(first)) return null;
  return `\\b${accentTolerant(first)}\\s+(?:[A-Za-z.'-]+\\s+){0,2}?${accentTolerant(last)}\\b`;
}

// A house credit or page-text "By ..." guess is not proof of another author.
const HOUSE_AUTHOR_RE = /\b(?:staff|team|desk|editors?|editorial|newsroom|reporters?|contributors?|variety|deadline|associated press|reuters|ap)\b/i;
function strongOtherAuthors(authors) {
  return authors.filter((a) => /^(?:meta|jsonld|rel-author):/.test(a) && !HOUSE_AUTHOR_RE.test(a));
}

/**
 * Verdict for one checked row.
 *   confirmed     page read, critic's surname is on it (author signal or text)
 *   byline-other  page read, it names other author(s) and never the critic
 *   url-dead      no page read, url answered 404/410 and Wayback had no copy
 *   unread        no page read for any other reason (paywall, block, timeout)
 *   no-signal     page read, no author signal and no critic mention
 * @param {object} row review record
 * @param {{via:string|null, statusLive?:number, authors:string[], matches:string[], url:string, snapshot?:string|null}} ev
 * @returns {{verdict:string, evidenceUrl:string|null, note:string}}
 */
function classifyEvidence(row, ev) {
  const src = criticPattern(row && row.criticName);
  const re = src ? new RegExp(src, 'i') : null;
  const evidenceUrl = (ev && (ev.snapshot || ev.url)) || null;
  if (!ev || !ev.via || ev.via === 'none') {
    const s = ev && ev.statusLive;
    if (s === 404 || s === 410) return { verdict: 'url-dead', evidenceUrl, note: `url answered ${s}, no Wayback copy` };
    return { verdict: 'unread', evidenceUrl, note: `no page read (live status ${s == null ? '?' : s})` };
  }
  const authors = Array.isArray(ev.authors) ? ev.authors : [];
  // Verdicts against the row need a pattern: initials/single names stay no-signal, never byline-other.
  if (!re) return { verdict: 'no-signal', evidenceUrl, note: `${ev.via} page read; critic name too short to match safely` };
  const authorMatch = authors.some((a) => re.test(a));
  const strongOther = strongOtherAuthors(authors);
  // A text-only mention ("More from <name>") does not confirm when the page credits someone else.
  if (authorMatch || ((ev.matches || []).length > 0 && strongOther.length === 0)) {
    return { verdict: 'confirmed', evidenceUrl, note: `${ev.via} page names ${row.criticName}` };
  }
  if (strongOther.length > 0 && (ev.matches || []).length === 0) {
    const names = strongOther.map((a) => a.replace(/^[a-z-]+:\s*/, '')).slice(0, 3).join('; ');
    return { verdict: 'byline-other', evidenceUrl, note: `${ev.via} page credits ${names}, never ${row.criticName}` };
  }
  return { verdict: 'no-signal', evidenceUrl, note: `${ev.via} page has no author signal` };
}

/**
 * new-fix-plan.js --review-edit args for a verdict. Only confirmed and
 * byline-other produce plan edits; url-dead rows go to
 * flag-legacy-web-search-rows.js (fabricatedEntry is set-true only there, a
 * plan may only clear it), and unread / no-signal rows stay for --scrape.
 * Values carry urls and names only, never review text.
 * @param {string} key "<show>/<file>.json"
 * @param {object} row
 * @param {{verdict:string, evidenceUrl:string|null, note:string}} v
 * @returns {string[]}
 */
function planEdits(key, row, v) {
  const clean = (s) => String(s).replace(/[\r\n]+/g, ' ').slice(0, 400);
  if (v.verdict === 'confirmed' && v.evidenceUrl) {
    return [
      `${key}:crossOutletVerifiedNote=${clean(`BRO-5259: ${v.note} at ${v.evidenceUrl}`)}`,
      `${key}:crossOutletVerified=true`,
    ];
  }
  if (v.verdict === 'byline-other' && v.evidenceUrl) {
    return [
      `${key}:wrongAttribution=true`,
      `${key}:wrongAttributionReason=${clean(`BRO-5259: web-search row; ${v.note} (${v.evidenceUrl})`)}`,
    ];
  }
  return [];
}

/** Would flag-legacy-web-search-rows.js flag this row given a probe status? */
function deadUrlPatch(row, statusLive) {
  return legacyWebSearchFlagPatch(row, { probeStatus: statusLive == null ? null : statusLive });
}

module.exports = { isSweepCandidate, criticPattern, classifyEvidence, planEdits, deadUrlPatch, SUMMARY_MAX_CHARS, SKIP_FLAGS };
