'use strict';
/**
 * Is a shows.json synopsis story, or something a scraper saved by mistake?
 * (BRO-5063). Two tiers:
 *
 *   hard: wikitext debris or audience-address pitch copy. The same patterns
 *         make isValidSynopsis reject a candidate, so a row here was saved
 *         before the rule existed or by a writer that skips the validator.
 *   soft: a sentence among the first four that nonStoryReason (the TodayTix
 *         cleaner's rules, scripts/lib/todaytix-page-identity.js) calls
 *         non-story. Advisory only: those rules also fire on some real plot
 *         (a press-style quote inside a story sentence), so a soft hit is a
 *         row to read, not a row to rewrite.
 *
 * Production news ("directed by", "premiered") is left out of soft: it is in
 * hundreds of Broadway synopses that also tell the story.
 *
 * Pure, no I/O. scripts/lib/synopsis-story-audit.test.mjs.
 */

const { WIKITEXT_DEBRIS_RE, isAudiencePitch, BULLET_LIST_RE, isTruncatedSynopsis } = require('./synopsis-validation');
// Initials and titles ("Buddy Young Jr.", "F. Murray Abraham") end in a full
// stop that does not end a sentence; same list the TodayTix cleaner uses.
const { ABBREV_DOT_RE } = require('./todaytix-page-identity');
// Stand-ins for end punctuation that must not split, restored afterwards.
const HOLD = { '.': '\u2024', '!': '\u01C3', '?': '\u0294' };
const RESTORE = new Map(Object.entries(HOLD).map(([k, v]) => [v, k]));
const SOFT_EXEMPT = new Set(['production-news']);
const MAX_REJOIN = 3;

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Sentences of a synopsis. Splits only where end punctuation is followed by
 * whitespace and a capital, digit or opening quote, so "J., George" and
 * "(D.C.), American" stay whole; the show's own title ("Rock 'N Roll! The
 * First 5,000 Years", "Schmigadoon!") is never split.
 */
function storySentences(text, title) {
  let s = String(text || '').replace(/\s+/g, ' ').trim();
  if (!s) return [];
  const t = String(title || '').trim();
  if (t && /[.!?]/.test(t)) {
    s = s.replace(new RegExp(escapeRe(t), 'g'), m => m.replace(/[.!?]/g, c => HOLD[c]));
  }
  s = s.replace(ABBREV_DOT_RE, `$1${HOLD['.']}`);
  const pieces = s
    .split(/(?<=[.!?]["'”’)]?)\s+(?=["'“‘(]?[A-Z0-9])/)
    .map(x => x.replace(/[\u2024\u01C3\u0294]/g, c => RESTORE.get(c)).trim())
    .filter(Boolean);
  // Dialogue ('exclaims, "Alright! I understand!" before hurrying off') is
  // one sentence: rejoin pieces while a double quote is still open, at most
  // MAX_REJOIN times, so a stray inch mark (12" record) cannot swallow the rest.
  const out = [];
  let joined = 0;
  for (const p of pieces) {
    const prev = out[out.length - 1];
    if (prev !== undefined && joined < MAX_REJOIN && (prev.match(/["\u201C\u201D]/g) || []).length % 2 === 1) {
      out[out.length - 1] = `${prev} ${p}`;
      joined++;
    } else {
      out.push(p);
      joined = 0;
    }
  }
  return out;
}

/**
 * @param {{synopsis?: string|null, title?: string}} show
 * @param {(sentence: string) => string|null} nonStoryReason
 * @returns {{hard: string[], soft: {reason: string, sentence: string}[]}}
 */
function synopsisStoryProblems(show, nonStoryReason) {
  const text = show && show.synopsis;
  if (typeof text !== 'string' || !text.trim()) return { hard: [], soft: [] };
  const hard = [];
  if (WIKITEXT_DEBRIS_RE.test(text)) hard.push('wikitext-debris');
  if (isAudiencePitch(text)) hard.push('audience-pitch');
  if (BULLET_LIST_RE.test(text)) hard.push('bullet-list');
  if (isTruncatedSynopsis(text)) hard.push('truncated-ellipsis');
  const soft = [];
  for (const sentence of storySentences(text, show.title).slice(0, 4)) {
    const reason = nonStoryReason(sentence);
    if (reason && !SOFT_EXEMPT.has(reason)) soft.push({ reason, sentence });
  }
  return { hard, soft };
}

module.exports = { storySentences, synopsisStoryProblems };
