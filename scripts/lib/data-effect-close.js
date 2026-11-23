'use strict';
/**
 * data-effect-close.js (BRO-8079): the Done gate checked process, not results.
 *
 * BRO-7930 ("_pending intake drain promotes 0 (6,838 waiting) + 313 limbo files
 * neither scored nor rejected") closed Done on `VERIFY: node --test ...` while
 * the queue its title names never moved (6,838 -> 6,786 a day later, last drain
 * "Promoted: 0"). A unit test proves the code does what its author meant; it
 * says nothing about the count the card is about.
 *
 * Two checks, both PURE (no I/O):
 *
 *  1. checkDataEffect: a card whose title or "## Acceptance criteria" names a
 *     data count (a number of waiting/missing/stuck things, "promotes 0",
 *     "% coverage", a queue/backlog size) may close Done only with an
 *     `EFFECT: <before> -> <after>` line that names numbers on both sides and
 *     the command that measured them. Otherwise it belongs in Paused with a
 *     RECHECK-AFTER stamp, which scripts/autonomous-acceptance-recheck.js
 *     re-measures once the date passes. Escape for a false positive:
 *     `NO-DATA-EFFECT: <reason>`.
 *
 *  2. checkSampleAudit: a worker Outcome that reports a classification / settle
 *     rate on real data ("98% settled/junk/duplicate") must carry a
 *     `SAMPLE-AUDIT:` block listing at least 20 sampled urls. BRO-8065 reported
 *     98% settled; a 25-stub sample found real reviews settled wrongly.
 */

const MIN_SAMPLE = 20;

// A number followed by the kind of thing a data card counts. STRONG nouns say the count is a
// backlog that should move (BLOCKING); WEAK ones (shows, reviews, files...) are common in ordinary
// titles ("Top 10 shows page", "Fix 404 on show pages"), so they only WARN (ship-check finding).
const STRONG_NOUN = String.raw`(?:waiting|stuck|stranded|limbo|missing|unscored|unmatched|uncollected|undated|unguarded|pending|orphan(?:ed|s)?|backlog|queued|stubs?|gaps?)`;
const WEAK_NOUN = String.raw`(?:files?|reviews?|urls?|entries|records|shows?|outlets?|critics?)`;
// Not a count: "top 10", "next 15", "v2", HTTP status codes ("404 on", "500 error").
const NUM = String.raw`(?<![\w#.-])(?<!\b(?:top|next|first|last|version|v|node|bro|pr|step|part|phase|sprint|s)\s?)(?!(?:[45]\d\d)\s+(?:on|error|errors|page|pages|for|from|when)\b)\d[\d,]*(?:\.\d+)?`;
const STRONG_COUNT_RE = new RegExp(String.raw`${NUM}\s+(?:[a-z_-]+\s+){0,2}?${STRONG_NOUN}\b`, 'i');
const WEAK_COUNT_RE = new RegExp(String.raw`${NUM}\s+(?:[a-z_-]+\s+){0,1}?${WEAK_NOUN}\b`, 'i');
// "promotes 0", "drained 12", "scores 0 of 40"
const VERB_COUNT_RE = /\b(?:promot(?:es|ed|ing)?|drain(?:s|ed|ing)?|scor(?:es|ed)|ingest(?:s|ed)|recover(?:s|ed)|settl(?:es|ed)|reject(?:s|ed))\s+(?:only\s+)?\d[\d,]*\b/i;
// "% coverage", "coverage 80%", "73% of shows"
const PCT_RE = /\b\d{1,3}(?:\.\d+)?\s*%\s*(?:of\s+\w+|coverage|covered|complete|missing|settled|scored)|\bcoverage\b[^.\n]{0,30}\d{1,3}(?:\.\d+)?\s*%/i;
// "queue unmoved", "backlog growing", "queue size"
const QUEUE_RE = /\b(?:queue|backlog)\s+(?:unmoved|stuck|growing|grew|size|depth|never (?:moved|drains?))\b/i;

// Things that look like counts but are about code or process, not data.
const NOT_DATA_RE = /\b\d[\d,]*(?:\.\d+)?\s*%?\s+(?:of\s+)?(?:tests?|files? changed|lines?|commits?|workflows?|steps?|calls?|times|minutes?|hours?|days?|seconds?|ms|sessions?|tabs?|workspaces?|jobs?|runs?|reviewers?)\b/gi;

function acceptanceSection(description) {
  const m = /^#{1,4}\s*acceptance criteria\s*$/im.exec(String(description || ''));
  if (!m) return '';
  const rest = String(description).slice(m.index + m[0].length);
  const next = /^#{1,4}\s+\S/m.exec(rest);
  return next ? rest.slice(0, next.index) : rest;
}

/** PURE. {phrase, strong} for the phrase that makes this a data-count card, or null. */
function dataCountMatch({ title = '', description = '' } = {}) {
  const text = [String(title || ''), acceptanceSection(description)].join('\n').replace(NOT_DATA_RE, ' ');
  for (const re of [VERB_COUNT_RE, QUEUE_RE, STRONG_COUNT_RE]) {
    const m = re.exec(text);
    if (m) return { phrase: m[0].trim(), strong: true };
  }
  for (const re of [PCT_RE, WEAK_COUNT_RE]) {
    const m = re.exec(text);
    if (m) return { phrase: m[0].trim(), strong: false };
  }
  return null;
}

/** PURE. Which phrase (if any) makes this a data-count card? */
function dataCountPhrase(args) {
  const m = dataCountMatch(args);
  return m ? m.phrase : null;
}

const LINE_RE = (name) => new RegExp(String.raw`^[ \t>*_-]*${name}(?:\*\*|__)?[ \t]*:(?:\*\*|__)?[ \t]*(.+)$`, 'gim');
function lastValue(texts, name) {
  let val = null;
  for (const t of texts) for (const m of String(t || '').matchAll(LINE_RE(name))) if (m[1].trim()) val = m[1].trim();
  return val;
}

// Arrows only: "from 2026-11-21 to 2026-11-22" is a date span, not a measurement (ship-check finding).
const ARROW_RE = /(\d[\d,.]*\s*%?)[^\d\n]{0,40}?(?:->|→|=>|⟶)\s*[^\d\n]{0,25}?(\d[\d,.]*\s*%?)/;
const DATE_RE = /\b\d{4}-\d{2}-\d{2}(?:T[\d:.]+Z?)?\b/g;
// A command: a backtick span that runs something, or a bare command word with an argument.
const CMD_RE = /`\s*(?:node|npm|npx|python3?|sqlite3|jq|gh|curl|bash|sh|wc|grep|find|ls|cat|scripts\/)[^`]*`|\b(?:node|npm|npx|python3?|sqlite3|jq|gh|curl|bash|wc|grep)\s+\S+/;
const num = (x) => Number(String(x).replace(/[,%\s]/g, ''));

/** PURE. Is this EFFECT value a measured before -> after with the command that measured it? */
function effectIsMeasured(value) {
  const v = String(value || '');
  const notes = [];
  const arrow = ARROW_RE.exec(v.replace(DATE_RE, ' '));
  if (!arrow) notes.push('name the number before and after, as "<before> -> <after>"');
  // BRO-7930's own numbers (6,838 -> 6,838) are a measurement that the fix did nothing.
  else if (num(arrow[1]) === num(arrow[2])) notes.push(`the count did not move (${arrow[1].trim()} -> ${arrow[2].trim()}): the card is not done; leave it Paused with RECHECK-AFTER or keep working`);
  if (!CMD_RE.test(v)) notes.push('name the command that measured it, in backticks');
  let pending = false;
  try { pending = require('./root-cause-close.js').isPendingEffect(v); } catch { /* fail open on the pending check only */ }
  if (pending) notes.push('it says the numbers are pending: measure them now, or leave the card Paused with RECHECK-AFTER');
  return { ok: notes.length === 0, notes };
}

/**
 * PURE. texts oldest first (description, earlier comments, close comment last).
 * Returns null when the card is not a data-count card (or carries NO-DATA-EFFECT),
 * else { ok, phrase, effect, notes }.
 */
function checkDataEffect({ title = '', description = '', texts = [] } = {}) {
  const match = dataCountMatch({ title, description });
  if (!match) return null;
  const { phrase, strong } = match;
  const all = [description, ...texts];
  const bypass = lastValue(all, 'NO-DATA-EFFECT');
  if (bypass && bypass.length >= 10) return null;
  // EFFECT lines on the description are the card author's wish, not a measurement: comments only.
  const effect = lastValue(texts, 'EFFECT');
  if (!effect) return { ok: false, phrase, strong, effect: null, notes: ['no EFFECT: line on the close'] };
  const m = effectIsMeasured(effect);
  return { ok: m.ok, phrase, strong, effect, notes: m.notes };
}

// "98% settled/junk/duplicate", "92.5% classified correctly", "settle rate 97%"
const RATE_CLAIM_RE = /\b\d{1,3}(?:\.\d+)?\s*%\s*(?:of\s+[\w-]+(?:\s+[\w-]+)?\s+)?(?:(?:were|are|was|is|got|get)\s+)?(?:settled|junk|duplicates?|classified|reclassified|rejected|promoted|valid|invalid|wrong(?:ly)?|correct(?:ly)?|false[- ]positives?|matched|resolved|recovered|real|genuine|accurate|precision|recall|accuracy)\b|\b(?:settle|classification|reject(?:ion)?|match|accuracy|precision|false[- ]positive)\s+rate\b[^.\n]{0,20}\d{1,3}(?:\.\d+)?\s*%/i;
const URL_TOKEN_RE = /\b(?:https?:\/\/)?(?:[a-z0-9-]+\.)+[a-z]{2,}\/[^\s)\]>'"`,]+/gi;

const AUDIT_HEAD_RE = /^[ \t>*_-]*SAMPLE-AUDIT(?:\*\*|__)?[ \t]*:(.*)$/im;
// The audit line must say how many of the sample were wrong ("25 sampled, 3 wrong", "0 wrong").
const WRONG_COUNT_RE = /\b\d+\s*(?:\/\s*\d+\s*)?(?:were\s+)?(?:wrong|incorrect|errors?|mis[a-z]*|bad|false[- ]positives?)\b/i;

/** PURE. The newest SAMPLE-AUDIT block: {head, urls}. The block runs to the next FIELD: line or blank-line paragraph. */
function sampleAuditBlock(texts) {
  let found = null;
  for (const t of texts) {
    const s = String(t || '');
    const m = AUDIT_HEAD_RE.exec(s);
    if (!m) continue;
    const rest = s.slice(m.index + m[0].length);
    const end = rest.search(/^[ \t]*[A-Z][A-Z-]{2,}:|\n[ \t]*\n(?![ \t]*(?:[-*]|\d+[.)])\s)/m);
    const body = `${m[1]}\n${end < 0 ? rest : rest.slice(0, end)}`;
    const urls = [...new Set((body.match(URL_TOKEN_RE) || []).map((u) => u.replace(/^https?:\/\//i, '').replace(/[.;:]+$/, '').toLowerCase()))];
    found = { head: m[1].trim(), urls };
  }
  return found;
}

function sampleAuditUrls(texts) {
  const b = sampleAuditBlock(texts);
  return b ? b.urls : [];
}

/**
 * PURE. texts = comments only (oldest first, close comment last): the worker's Outcome,
 * not the card description that may quote an earlier rate as the incident.
 * Returns null when no rate is claimed, else { ok, claim, sampled, notes }.
 */
function checkSampleAudit({ texts = [], minSample = MIN_SAMPLE } = {}) {
  let claim = null;
  for (const t of texts) {
    const m = RATE_CLAIM_RE.exec(String(t || ''));
    if (m) claim = m[0].trim();
  }
  if (!claim) return null;
  const all = texts;
  const bypass = lastValue(all, 'NO-SAMPLE-AUDIT');
  if (bypass && bypass.length >= 10) return null;
  const block = sampleAuditBlock(texts);
  const urls = block ? block.urls : [];
  const notes = [];
  if (urls.length < minSample) notes.push(`a SAMPLE-AUDIT: block lists ${urls.length} url(s); it needs at least ${minSample} randomly sampled urls, each checked by hand`);
  if (block && !WRONG_COUNT_RE.test(block.head)) notes.push('the SAMPLE-AUDIT: line must say how many of the sample were wrong, e.g. "SAMPLE-AUDIT: 25 random settled stubs, 2 wrong"');
  return { ok: notes.length === 0, claim, sampled: urls.length, notes };
}

function dataEffectMessage(identifier, r) {
  return `${identifier || 'This card'} is about a data count ("${r.phrase}"), and a passing test does not show that count moved. ` +
    `Done needs an EFFECT line on the close comment, measured just now, e.g.\n` +
    '    EFFECT: _pending queue 6,838 -> 412, measured by `node scripts/<the count command>`\n' +
    (r.notes.length ? `Problem: ${r.notes.join('; ')}.\n` : '') +
    'If the count can only move later (next cron, next drain), leave the card Paused with RECHECK-AFTER: YYYY-MM-DD and a VERIFY command ' +
    'that measures the count (scripts/autonomous-acceptance-recheck.js re-runs it once the date passes). ' +
    'Not actually a data card? Add NO-DATA-EFFECT: <reason>.';
}

function sampleAuditMessage(identifier, r) {
  return `${identifier || 'This card'}'s Outcome reports a rate on real data ("${r.claim}") without a random-sample audit. ` +
    `Add a comment block starting "SAMPLE-AUDIT: <N> sampled, <K> wrong" that lists at least ${MIN_SAMPLE} randomly sampled urls with what each one really was ` +
    `(found ${r.sampled}; ${r.notes.join('; ')}). Self-reported rates were wrong before: BRO-8065 said 98% settled and a 25-stub sample found real reviews settled wrongly. ` +
    'Not a rate on real data? Add NO-SAMPLE-AUDIT: <reason>.';
}

module.exports = {
  MIN_SAMPLE,
  dataCountPhrase,
  dataCountMatch,
  effectIsMeasured,
  checkDataEffect,
  checkSampleAudit,
  sampleAuditUrls,
  dataEffectMessage,
  sampleAuditMessage,
};
