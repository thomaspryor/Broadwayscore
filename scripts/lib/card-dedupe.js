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
  return source ? String(source).replace(/\s+/g, '-') : 'unknown';
}

function sourceFooter(source, kind) {
  return `${FOOTER_PREFIX}${source}${kind ? ` (kind: ${kind})` : ''}`;
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

module.exports = {
  NEAR_DUP_MIN_SCORE, NEAR_DUP_MIN_TOKENS, FLOOD_THRESHOLD, FLOOD_WINDOW_MS, ALERT_ROUTER_MARKER, ROLLUP_TITLE_PREFIX,
  titleCore, titleTokens, distinctiveParts, titleKind, jaccard, findNearDuplicate, hasPerCardContract,
  inferCardSource, sourceFooter, parseSourceFooter, rollupTitle, sameKindCards, countSameKind, rollupEnforced,
};
