/**
 * card-dedupe.js — PURE rules the card front door (linear-issue-create.js)
 * applies before filing (BRO-5488).
 *
 * Why: inflow (~40-110 cards/day, 549 in the 7 days to 2026-10-16) roughly
 * equalled completion, so the board never shrank. The front door only caught
 * exact-title copies (reuseOpenTwin, BRO-4956), so every filer deduped on its
 * own or not at all, and nothing recorded WHO filed a card.
 *
 * Three rules live here, all pure (no network) so tests and the replay script
 * (scripts/linear-dedupe-sweep.js) run the exact production logic:
 *   - inferCardSource / sourceFooter: every new card says who filed it, so the
 *     morning digest can show inflow by source (board-numbers.js).
 *   - findNearDuplicate: a reworded repeat of an open card ("Opening-night
 *     reviews dropped" repeats, "BSC Rebuild: 49 reviews dropped"
 *     vs "41 reviews dropped") is noted on that card instead of filed again.
 *   - titleKind: the same-kind key a flood is grouped by ("Review gap — "X"
 *     missing 6 cited review(s)" and "... "Y" missing 1 ..." share a kind).
 *
 * Tuned on a live replay of 550 cards (2026-10-09..16): at NEAR_DUP_MIN_SCORE
 * 0.85 with equal distinctive parts every match was a true repeat, and every
 * pair between 0.6 and 0.85 was a different subject ("Fish: 4 roundup-listed
 * reviews" vs "Triumph: 1 ..."), so the bar sits above that band.
 */

'use strict';

const { tokenizeTitle } = require('./audit-card-relevance.js');
const { foldDiacritics } = require('./title-match.js');
const { AUTOFIX_FILED_MARKER } = require('./autofix-filed-marker.js');

const NEAR_DUP_MIN_SCORE = 0.85;
const NEAR_DUP_MIN_TOKENS = 3;
// A source+kind filed this many times in 24h is a flood (card: "more than N, e.g. 3").
const FLOOD_THRESHOLD = 3;
const FLOOD_WINDOW_MS = 24 * 3600 * 1000;
const { AUTO_FILED_MARKER: ALERT_ROUTER_MARKER } = require('./linear-drain-parked.js');

const FOOTER_PREFIX = 'Filed by: ';
const FOOTER_RE = /^Filed by: ([^\s(]+)(?: \(kind: ([^)]*)\))?\s*$/m;
const ROLLUP_TITLE_PREFIX = 'Rollup (';

const FILE_REF_RE = /[\w./-]+\.(?:js|mjs|cjs|ts|tsx|yml|yaml|json|sh|md)\b/g;

function fold(s) {
  return foldDiacritics(String(s || ''))
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"');
}

// The part of a title that says what the card is about: drops a "P0:".."P3:"
// tier prefix and the "BSC Daily:" filer prefix, which every card of that
// filer shares and so says nothing about the subject.
function titleCore(title) {
  return fold(title)
    .replace(/^\s*p[0-3]\s*:\s*/, '')
    .replace(/^\s*(?:\p{Extended_Pictographic}\s*)*bsc daily\s*:\s*/u, '')
    .trim();
}

// tokenizeTitle (diacritic-folded, stopwords, len>=3) minus pure numbers, so
// counts and dates ("49 reviews", "2026-10-15") never make a repeat look new.
function words(s) {
  return tokenizeTitle(s).filter((w) => !/^\d+$/.test(w));
}

/** Token set used for near-duplicate scoring. File paths count as one token each. */
function titleTokens(title) {
  const core = titleCore(title);
  const out = new Set(words(core));
  for (const f of core.match(FILE_REF_RE) || []) out.add(f);
  return out;
}

/**
 * The parts of a title that name a specific subject: quoted strings, a
 * parenthetical, file paths, BRO refs, dates. Two titles are only near-duplicates
 * when these are EQUAL, so "Review gap — "The Wiz"" never matches "... "Tru"",
 * and "main test.yml red: ... — "test A"" never matches "... "test B"".
 */
function distinctiveParts(title) {
  const core = titleCore(title);
  const parts = new Set();
  for (const m of core.matchAll(/"([^"]+)"/g)) parts.add(`q:${words(m[1]).join(' ') || m[1].trim()}`);
  for (const m of core.matchAll(/\(([^)]+)\)/g)) {
    const w = words(m[1]).join(' ');
    if (w) parts.add(`p:${w}`);
  }
  for (const f of core.match(FILE_REF_RE) || []) parts.add(`f:${f}`);
  for (const b of core.match(/\bbro-\d+\b/g) || []) parts.add(`b:${b}`);
  // A date names the day a card is about: "Opening-night watch 2026-10-09" is
  // one log card per night by design (resolved-alert-card-sweep.js LOG_TITLE_RE
  // closes them by that date), so another night is never a repeat.
  for (const day of core.match(/\b\d{4}-\d{2}-\d{2}\b/g) || []) parts.add(`d:${day}`);
  // Every other number that is not a count names a subject too: "PR #9182",
  // "v2", "P0", "Phase 3", "404", "14:00", "2026". Counts are masked first;
  // the whole title is read, since titleCore drops a "P0:" prefix.
  for (const n of countFreeTitle(title).match(/[\w.:\/-]*\d[\w.:\/-]*/g) || []) parts.add(`n:${n.replace(/[.:\/-]+$/, '')}`);
  return parts;
}

/**
 * Same-kind key for flood grouping: the title without its subject (quoted
 * strings, parentheticals, numbers, dates) and without a leading "Subject:"
 * segment when at least 3 words follow it ("Fish: 4 roundup-listed review(s)
 * still not captured" -> "roundup listed review still captured").
 */
function titleKind(title) {
  let t = titleCore(title).replace(/"[^"]*"/g, ' ').replace(/\([^)]*\)/g, ' ');
  const i = t.indexOf(': ');
  if (i > 0 && words(t.slice(i + 2)).length >= 3) t = t.slice(i + 2);
  return [...new Set(words(t))].slice(0, 8).join(' ');
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

function sameSet(a, b) {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

/**
 * Best open card that this title repeats, or null.
 * @param {string} title
 * @param {Array<{identifier:string,title:string}>} openCards
 * @param {(card:object)=>boolean} [serves] extra filter (linear-issue-create's twinServes)
 * @returns {{card:object, score:number}|null}
 */
function findNearDuplicate(title, openCards, serves = () => true) {
  const tokens = titleTokens(title);
  if (tokens.size < NEAR_DUP_MIN_TOKENS) return null;
  const parts = distinctiveParts(title);
  let best = null;
  for (const card of openCards || []) {
    if (!card || !card.title || String(card.title).startsWith(ROLLUP_TITLE_PREFIX)) continue;
    const other = titleTokens(card.title);
    if (other.size < NEAR_DUP_MIN_TOKENS || !sameSet(parts, distinctiveParts(card.title))) continue;
    const score = jaccard(tokens, other);
    if (score >= NEAR_DUP_MIN_SCORE && (!best || score > best.score) && serves(card)) best = { card, score };
  }
  return best;
}

/**
 * The title with its counts masked ("21 review(s)" -> "# review(s)") and
 * every other number kept, so two titles equal here are the same row whose
 * count moved. Used for the exact-title twin rule (reuseTwin callers, opt-outs
 * included: digest-autofix rows like "Star-band detector: 21 review(s)").
 */
function countFreeTitle(title) {
  // Only a count: a standalone number right after ": " that leads a word
  // ("queue: 1 p0", "rebuild: 49 reviews"), or after a verb before a plural
  // ("dropped 21 reviews", "missing 1 cited review(s)", "fix 3 broken links").
  // Never "#123", "v2", "p0", "phase 2", "http 403 errors", "node 20 builds",
  // "error: 500", a time, a date, a BRO ref or a year.
  const t = fold(title).trim().replace(/\s+/g, ' ');
  return t.replace(/(?<![#\w.:,\/-])\d{1,6}(?![\w.:,\/-])/g, (m, at) => {
    if (/^(?:19|20)\d\d$/.test(m)) return m;
    const before = t.slice(0, at);
    const after = t.slice(at + m.length);
    if (/: $/.test(before)) return COUNT_AFTER_COLON_RE.test(after) ? '#' : m;
    return (!before || COUNT_LEAD_RE.test(before)) && COUNT_NOUN_RE.test(after) ? '#' : m;
  });
}
const STOP = '(?:on|in|at|for|to|of|the|and|or|is|was|from|by|with)';
// ": N <word>" where the word is not a stopword ("error: 500 from x" is a code).
const COUNT_AFTER_COLON_RE = new RegExp(`^ (?!${STOP}\\b)[a-z(]`);
// The word before a count: a verb ("dropped", "missing") or a quantity lead.
const COUNT_LEAD_RE = /(?:\b(?:\w+(?:ed|ing)|fix|has|have|had|with|over|under|only|about|all|top|last|first|and|lost|found|new|stale|open|got)) $/;
// " [one non-stopword] <plural or (s)>" after a number.
const COUNT_NOUN_RE = new RegExp(`^ (?:(?!${STOP}\\b)[a-z]+ )?(?!(?:is|was|has|this|its|yes|us|as)\\b)[a-z]+(?:\\(s\\)|s\\b)`);

/** An open card whose title differs from `title` only in its counts, or null. */
function findCountOnlyTwin(title, openCards, serves = () => true) {
  const key = countFreeTitle(title);
  if (!/#/.test(key)) return null;
  for (const card of openCards || []) {
    if (!card || !card.title || String(card.title).startsWith(ROLLUP_TITLE_PREFIX)) continue;
    if (countFreeTitle(card.title) === key && serves(card)) return card;
  }
  return null;
}

/**
 * BRO-6081: a title with standalone counts collapsed to '#', for matching a
 * health row whose title carries a live number ("(2194/1750 reqs)", "1 review(s)")
 * to yesterday's card. Numbers that name something stay: inside a word or slug
 * (web_unlocker2, hay-fever-2026, P0, T1), in a date (2026-10-24), after '#'
 * (card #794) and "batch N" (each fold batch is its own card).
 */
function numberFreeTitle(title) {
  return String(title || '').replace(/(?<![\w#.:-])(?<!batch )\d+(?![\w.:-])/gi, '#');
}

/** True when a body carries a filer marker whose downstream code keys on THIS card. */
function hasPerCardContract(description) {
  const d = String(description || '');
  return d.includes(AUTOFIX_FILED_MARKER) || d.includes(ALERT_ROUTER_MARKER);
}

/**
 * Who filed a card. Title and body rules win over the caller's claim, so the
 * canary stays "e2e-canary" even though it files through the alert router.
 * A footer already on the body (a re-read card) wins over everything.
 */
function inferCardSource({ title = '', description = '', source } = {}) {
  const footer = FOOTER_RE.exec(String(description || ''));
  if (footer) return footer[1];
  const t = String(title || '');
  if (/^\[E2E Canary\]/i.test(t)) return 'e2e-canary';
  if (t.startsWith(ROLLUP_TITLE_PREFIX)) return 'rollup';
  if (/^(?:\p{Extended_Pictographic}\s*)*BSC Daily:/iu.test(t) || String(description || '').includes(AUTOFIX_FILED_MARKER)) return 'digest-autofix';
  if (/^(?:P[0-3]\s*:\s*)?main (?:[\w.-]+ )?red:/i.test(t)) return 'ci-red';
  if (String(description || '').includes(ALERT_ROUTER_MARKER)) return 'alert-router';
  return normalizeSource(source) || 'unknown';
}

// Footer-safe source: FOOTER_RE stops at whitespace and "(", so workflow names
// like "Daily Digest (score drift)" become "Daily-Digest-score-drift".
function normalizeSource(source) {
  return String(source || '').replace(/[\s()]+/g, '-').replace(/-+$/, '').replace(/-{2,}/g, '-');
}

function sourceFooter(source, kind) {
  return `${FOOTER_PREFIX}${normalizeSource(source)}${kind ? ` (kind: ${kind})` : ''}`;
}

function parseSourceFooter(description) {
  const m = FOOTER_RE.exec(String(description || ''));
  return m ? { source: m[1], kind: m[2] || '' } : null;
}

function rollupTitle(source, kind) {
  return `${ROLLUP_TITLE_PREFIX}${source}): ${kind || 'misc'}`;
}

/**
 * How many of `recent` (cards with title/description/createdAt) share this
 * filing's source and kind inside the flood window ending at `nowMs`.
 */
function sameKindCards({ source, kind, recent, nowMs = Date.now() }) {
  const out = [];
  for (const c of recent || []) {
    const at = Date.parse(c.createdAt || '');
    if (!Number.isFinite(at) || nowMs - at > FLOOD_WINDOW_MS || at > nowMs) continue;
    if (String(c.title || '').startsWith(ROLLUP_TITLE_PREFIX)) continue;
    const f = parseSourceFooter(c.description);
    const cs = f ? f.source : inferCardSource(c);
    const ck = f && f.kind ? f.kind : titleKind(c.title);
    if (cs === source && ck === kind) out.push(c);
  }
  return out;
}

function countSameKind(args) {
  return sameKindCards(args).length;
}

/**
 * Sources whose flood is folded into one rollup card. Only filers that do
 * nothing with the returned card but log it (the date audits and other
 * workflow scripts that file through linear-brain.js). The alert router,
 * digest-autofix and the canary key per-card state on the card they get back,
 * so they are never rolled up here: their floods are only counted (digest
 * "Flooding" line) and fixed at the filer (BRO-5486 for digest-autofix).
 */
function rollupEnforced({ source, description }) {
  return /^workflow:/.test(String(source || '')) && !hasPerCardContract(description);
}

/**
 * The ONLY callers allowed to skip the near-duplicate and rollup rules, each
 * with why. Every other filer gets them by default (BRO-5488, owner ask: fix
 * duplicates and floods for every filer). linear-issue-create.js throws on a
 * name not listed here, and linear-issue-create.test.mjs checks the repo's
 * call sites against this list, so a new filer cannot skip the front door
 * silently. Floods from these filers are fixed at the filer (BRO-5486,
 * BRO-5493) and stay visible on the digest's Floods line.
 */
const DEDUPE_OPT_OUTS = Object.freeze({
  'alert-router': 'owner-alert-router dedupes per conditionKey and keys its ledger, START-NOW and dispatch-at-filing markers on the card it gets back',
  'digest-autofix': 'digest-autofix dedupes per digest row and dispatches the card it gets back (grouping fixed at the filer by BRO-5486)',
  'auto-fix-first': 'auto-fix-first files dispatch cards keyed by its own key line (lookupCards) and comments on the card it gets back',
  'posthog-friction': 'posthog-friction-analyzer dedupes by the fhash in the card description, and auto-fix-friction-card.js picks cards by that fhash and priority, so a finding must stay its own card',
  'press-night-digest': 'produce-press-night-digest-snapshot.js finds its card per show-night by the press-night-card-key line (any state) and comments new misses on it, so a near-match on another show of the same night must not swallow it',
  'sentry-triage': 'triage-sentry.js dedupes by the sentry-issue line in the card (any state), and two different Sentry errors often share most title words, so a near-match must not swallow a distinct error (BRO-5593)',
  rollup: 'the rollup card itself; running the rules on it would recurse',
});

module.exports = {
  DEDUPE_OPT_OUTS,
  NEAR_DUP_MIN_SCORE, NEAR_DUP_MIN_TOKENS, FLOOD_THRESHOLD, FLOOD_WINDOW_MS, ALERT_ROUTER_MARKER, ROLLUP_TITLE_PREFIX, FOOTER_RE,
  titleCore, titleTokens, countFreeTitle, findCountOnlyTwin, distinctiveParts, titleKind, jaccard, findNearDuplicate, hasPerCardContract,
  numberFreeTitle, inferCardSource, normalizeSource, sourceFooter, parseSourceFooter, rollupTitle, sameKindCards, countSameKind, rollupEnforced,
};
