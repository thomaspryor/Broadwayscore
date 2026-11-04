'use strict';

/**
 * printed-byline-conflict.js: does the article's own printed byline name a
 * DIFFERENT critic than the one the file is credited to?
 *
 * WHY THIS EXISTS (BRO-6940, 2026-11-04). Waiting for Lefty's New York Stage
 * Review text opens "November 2, 2026 8:59 pm Waiting for Lefty: No, No,
 * Odets! By Michael Sommers ★★☆☆☆" but the file was credited to Frank Scheck.
 * Per-critic SERP discovery (gather-reviews.js, source `serp-discovery-per-
 * critic`) queries "<outlet> <show> <critic>" and takes the outlet's top URL,
 * which can be a colleague's review of the same show; the critic name is the
 * QUERY, not evidence. collect-review-texts.js has a byline cross-check, but
 * extractByline() only accepts "By Name" at the start of a LINE, and NYSR
 * text is one line with the title ahead of the byline, so it never fired (and
 * even when it fires it only flags the text as wrong-author; it never
 * re-credits the review to the person who wrote it).
 *
 * This module is the evidence check that was missing. Pure functions, no I/O.
 *
 * Precision rules (a wrong rename is worse than a missed one):
 *  - The credited critic is attested in the head ("By <credited>", any
 *    co-byline order) -> no conflict.
 *  - The printed name must follow a byline marker (BYLINE_MARKERS) and not a
 *    production-credit verb ("directed by"), reusing byline-attestation.js.
 *  - Auto-correctable ("known") only when the printed name is a critic we
 *    already know writes for THIS outlet (registry defaultCritics, or a
 *    corpus-derived list the audit passes in). Any other printed name is
 *    "unlisted": reported for a human, never auto-applied.
 */

const { normalizeForAttestation, BYLINE_MARKERS, precededByCreditVerb } = require('./byline-attestation');
const { isPlausiblePersonName } = require('./byline-recovery');
const { foldDiacritics } = require('./title-match');

// The byline sits in the first screenful of every outlet we scrape. Past this,
// "by <name>" is prose, a related-articles rail or a credits block.
const HEAD_CHARS = 600;

const PLACEHOLDER_RE = /^(unknown|unnamed|staff|anonymous|n\/a|none)$/i;

function isPlaceholderName(name) {
  return !name || PLACEHOLDER_RE.test(String(name).trim());
}

function _tokens(name) {
  const n = normalizeForAttestation(name);
  const t = n ? n.split(' ') : [];
  // A scraped "by ALEXIS PAPALIA" is the same person as "Alexis Papalia".
  if (t.length > 2 && t[0] === 'by') t.shift();
  // Drop bare initials: "F. Kathleen Foley" is "Kathleen Foley" (only when a real name remains).
  const noInitials = t.filter((x) => x.length > 1);
  return noInitials.length >= 2 ? noInitials : t;
}

function _editDistance(a, b) {
  if (a === b) return 0;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}

/**
 * Same person, tolerant of the variants scrapers and aggregators produce:
 *  - nickname/initial first names ("Mike"/"Michael" Sommers, "J. Green"/"Jesse Green"):
 *    same last token AND first tokens sharing a 2-letter prefix, or a bare initial
 *  - a truncated or extended name ("Brian Scott" / "Brian Scott Lipton"): one
 *    token list is a prefix of the other
 *  - a one-or-two-letter typo in the surname ("Feinberg"/"Fienberg") with the
 *    same first name
 * Single-token names never match (too weak to call anything the same person).
 */
function sameCritic(a, b) {
  const ta = _tokens(a);
  const tb = _tokens(b);
  if (ta.length < 2 || tb.length < 2) return false;
  const [short, long] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
  if (short.every((t, i) => t === long[i])) return true;
  // "Stafford Hagwood" / "Rod Stafford Hagwood", "Scott Lipton" / "Brian Scott Lipton": a dropped first name.
  if (short.every((t, i) => t === long[long.length - short.length + i])) return true;
  const la = ta[ta.length - 1];
  const lb = tb[tb.length - 1];
  const fa = ta[0];
  const fb = tb[0];
  if (la === lb) {
    if (fa === fb) return true;
    if (fa.length === 1 || fb.length === 1) return fa[0] === fb[0];
    return fa.slice(0, 2) === fb.slice(0, 2);
  }
  return fa === fb && Math.min(la.length, lb.length) >= 5 && _editDistance(la, lb) <= 2;
}

/**
 * Index (in the space-padded normalized head) of the first byline-marked
 * occurrence of `name`, or -1. Mirrors isBylineAttestedInText but returns the
 * position so callers can order candidates.
 */
function firstBylineIndex(paddedHead, name) {
  const n = normalizeForAttestation(name);
  if (!n || n.split(' ').length < 2) return -1;
  let best = -1;
  for (const marker of BYLINE_MARKERS) {
    const needle = ` ${marker} ${n} `;
    let from = 0;
    for (;;) {
      const at = paddedHead.indexOf(needle, from);
      if (at === -1) break;
      if (!(marker === 'by' && precededByCreditVerb(paddedHead, at, marker))) {
        if (best === -1 || at < best) best = at;
        break;
      }
      from = at + 1;
    }
  }
  return best;
}


// A byline reads "By X", "Written by X", "Reviewed by X", "Review by X", "Theater Review by X", "by\nX",
// "Posted on <date> by X", or a bare "by X |" opening the text. Prose that merely names a critic
// ("reviewed for the Observer by Clare Brennan", "( reviewed by Kimzyn Campbell )", "a review posted
// written by JK Clarke") is lowercase mid-sentence. The normalized check ignores case, so this confirms
// the printed name against the RAW head: the marker must be capitalised or sit on its own line.
const RAW_MARKER_BEFORE_NAME_RE = new RegExp(
  '(?:' +
    '(?:^|[^A-Za-z(])(?:By|BY|Written [Bb]y|Written By|Reviewed [Bb]y|Reviewed By|Review [Bb]y|Review By|Theat(?:er|re) Review [Bb]y|Words [Bb]y)' +
    '|(?:^|\\n)\\s*by' +
    '|^\\s*by' +
    '|Posted[^.\\n]{0,60}\\bby' +
  ')\\s*:?\\s*$'
);

function _rawBylineConfirmed(rawHead, name) {
  const folded = foldDiacritics(String(rawHead)).replace(/[’‘ʼ]/g, "'");
  const toks = foldDiacritics(String(name)).replace(/[’‘ʼ]/g, "'").split(/\s+/).filter(Boolean)
    .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (toks.length < 2) return false;
  const nameRe = new RegExp('(?<![A-Za-z])' + toks.join('[\\s.]*') + '(?![a-z])', 'ig');
  let m;
  while ((m = nameRe.exec(folded))) {
    const before = folded.slice(Math.max(0, m.index - 70), m.index);
    if (RAW_MARKER_BEFORE_NAME_RE.test(before)) return true;
  }
  return false;
}

function _paddedHead(fullText) {
  return ` ${normalizeForAttestation(String(fullText).slice(0, HEAD_CHARS))} `;
}

/**
 * Is the credited critic printed as a byline in the article head?
 * @param {string} criticName
 * @param {string} fullText
 * @returns {boolean}
 */
function creditedCriticPrinted(criticName, fullText) {
  if (isPlaceholderName(criticName) || !fullText) return false;
  const head = _paddedHead(fullText);
  if (firstBylineIndex(head, criticName) !== -1) return true;
  // Scrapes glue the byline to the next element ("By Brian Scott LiptonWith so much..."), so the
  // strict token-boundary match above misses it. This looser match can only SUPPRESS a conflict
  // (it may over-match "Sam Well"/"Sam Wells"), which is the safe direction for a rename check.
  const n = normalizeForAttestation(criticName);
  if (!n || n.split(' ').length < 2) return false;
  return BYLINE_MARKERS.some((m) => head.includes(` ${m} ${n}`));
}

/**
 * "Known" conflict: the head prints a byline naming a critic from `knownCritics` (the outlet's
 * critics) who is not the credited critic, and the credited critic is not printed there at all.
 *
 * @param {object} args
 * @param {string} args.criticName credited critic (placeholder names return null: see findPrintedKnownByline)
 * @param {string} args.fullText   article text
 * @param {string[]} args.knownCritics critics known to write for this outlet
 * @returns {{ printedName: string, kind: 'known' } | null}
 */
function findPrintedBylineConflict({ criticName, fullText, knownCritics }) {
  if (isPlaceholderName(criticName)) return null;
  // A one-word credit ("Kathryn", "Seana": Theatre and Tonic's guest reviewers) can
  // never be attested in the text (byline-attestation rule 3), so its absence proves nothing.
  if (_tokens(criticName).length < 2) return null;
  if (creditedCriticPrinted(criticName, fullText)) return null;
  return _firstPrintedKnown({ fullText, knownCritics, creditedName: criticName });
}

/**
 * The same evidence for a file with NO usable credit ("Unknown", "Staff"): the head prints a byline
 * naming a critic known at the outlet. Used to fill unnamed files (fill, not conflict).
 * @returns {{ printedName: string, kind: 'known' } | null}
 */
function findPrintedKnownByline({ fullText, knownCritics }) {
  return _firstPrintedKnown({ fullText, knownCritics, creditedName: null });
}

function _firstPrintedKnown({ fullText, knownCritics, creditedName }) {
  if (!fullText || typeof fullText !== 'string' || fullText.length < 50) return null;
  if (!Array.isArray(knownCritics) || knownCritics.length === 0) return null;
  // Tag and listing pages ("Displaying all articles tagged...") print one byline per teaser in the head.
  // The first one is not the author of anything on the page, so two printed bylines means no verdict.
  if (looksLikeListingHead(fullText)) return null;
  const head = _paddedHead(fullText);
  const rawHead = String(fullText).slice(0, HEAD_CHARS);
  let best = null;
  for (const k of knownCritics) {
    // Real people only: "THR Staff", "The Recs EM" are masthead labels, not bylines to re-credit to.
    if (isPlaceholderName(k) || !isPlausiblePersonName(k)) continue;
    if (creditedName && sameCritic(k, creditedName)) continue;
    const at = firstBylineIndex(head, k);
    if (at === -1) continue;
    if (!_rawBylineConfirmed(rawHead, k)) continue;
    if (!best || at < best.at) best = { name: k, at };
  }
  return best ? { printedName: best.name, kind: 'known' } : null;
}

// Words that end a printed name when the scrape glues the next element on
// ("By Michael Sommers A rowdy meeting", "... Sommers Published ...").
const NAME_STOP = new Set([
  'a', 'an', 'the', 'in', 'on', 'at', 'of', 'for', 'and', 'with', 'published', 'posted', 'updated',
  'deputy', 'senior', 'staff', 'editor', 'critic', 'writer', 'reporter', 'special', 'photo',
  'photos', 'photography', 'review', 'reviews', 'reviewed', 'theatre', 'theater', 'it', 'there',
  'this', 'that', 'when', 'what', 'how', 'why', 'is', 'was', 'as',
]);

const CAP_TOKEN = "\\p{Lu}[\\p{L}'’.-]+";
const HEADER_BYLINE_RE = new RegExp(
  "(?:^|[\\s!?.:|\"”'’)\\]])(?:By|BY|Review by|Reviewed by|Theat(?:er|re) Review by)\\s*:?\\s+(" +
    CAP_TOKEN + "(?:\\s+(?:van|von|der|de|le|da|di|del|la)\\s+" + CAP_TOKEN + "|\\s+" + CAP_TOKEN + "){1,3})",
  'u'
);

/**
 * True when the head prints "By <Name>" twice or more (the same writer or different ones): a listing, tag
 * or roundup page rather than one article. A byline repeated inside 600 characters is one teaser per
 * article, and a co-review set out as two bylines also lands here, which is the safe direction (no verdict).
 * @param {string} fullText
 * @returns {boolean}
 */
function looksLikeListingHead(fullText) {
  if (!fullText || typeof fullText !== 'string') return false;
  const head = fullText.slice(0, HEAD_CHARS);
  const re = new RegExp(HEADER_BYLINE_RE.source, 'gu');
  const names = [];
  let m;
  while ((m = re.exec(head))) {
    const kept = [];
    for (const tok of m[1].trim().split(/\s+/)) {
      if (NAME_STOP.has(tok.toLowerCase().replace(/[.,]/g, ''))) break;
      kept.push(tok);
      if (kept.length === 3) break;
    }
    if (kept.length < 2) continue;
    names.push(kept.join(' '));
    if (names.length >= 2) return true;
  }
  return false;
}

/**
 * Best-effort printed byline from the head for "unlisted" triage: the first
 * "By <Name>" (any layout, mid-line included) that is not a credit verb
 * construction. Returns a 2-3 token name or null. Never used to auto-apply.
 * @param {string} fullText
 * @returns {string|null}
 */
function extractHeaderByline(fullText) {
  if (!fullText || typeof fullText !== 'string') return null;
  const head = fullText.slice(0, HEAD_CHARS);
  const m = HEADER_BYLINE_RE.exec(head);
  if (!m) return null;
  const raw = m[1].trim().split(/\s+/);
  const kept = [];
  for (const tok of raw) {
    if (NAME_STOP.has(tok.toLowerCase().replace(/[.,]/g, ''))) break;
    kept.push(tok);
    if (kept.length === 3) break;
  }
  if (kept.length < 2) return null;
  return kept.join(' ');
}

/**
 * Printed byline unlisted at the outlet: head prints "By <Name>" that is not
 * the credited critic and not a known colleague. For reports only.
 * @returns {{ printedName: string, kind: 'unlisted' } | null}
 */
function findUnlistedPrintedByline({ criticName, fullText, knownCritics }) {
  if (isPlaceholderName(criticName) || !fullText || _tokens(criticName).length < 2) return null;
  const printed = extractHeaderByline(fullText);
  if (!printed) return null;
  if (sameCritic(printed, criticName)) return null;
  if (creditedCriticPrinted(criticName, fullText)) return null;
  const head = _paddedHead(fullText);
  const idx = head.indexOf(` ${normalizeForAttestation(printed)} `);
  if (idx !== -1 && precededByCreditVerb(head, idx - 3, 'by')) return null;
  const known = (knownCritics || []).find((k) => sameCritic(k, printed));
  return { printedName: known || printed, kind: 'unlisted', knownColleague: !!known };
}

/**
 * Index of known critics per outlet from the outlet registry:
 * outletId -> string[] of defaultCritics/defaultCritic names.
 * @param {object} registry parsed data/outlet-registry.json
 * @returns {Map<string, string[]>}
 */
function buildKnownCriticsIndex(registry) {
  const out = new Map();
  const outlets = (registry && registry.outlets) || {};
  for (const [id, o] of Object.entries(outlets)) {
    const names = new Set();
    for (const n of (Array.isArray(o.defaultCritics) ? o.defaultCritics : [])) if (!isPlaceholderName(n)) names.add(n);
    if (!isPlaceholderName(o.defaultCritic)) names.add(o.defaultCritic);
    if (names.size) out.set(id, [...names]);
  }
  return out;
}

// Outlets whose pages list editors or several critics (Verdict roundups, forum-style threads, nav-chrome
// heads). A printed name there is not the author, so an unnamed file is never filled from it.
const NO_FILL_OUTLETS = new Set(['playbill', 'broadwayworld', 'around-the-town-chicago', 'stagebuddy', 'chicagotribune', 'londontheatredirect']);

/** Critic names the registry lists for an outlet (`buildKnownCriticsIndex` result), [] when none. */
function knownCriticsForOutlet(index, outletId) {
  if (!index || typeof index.get !== 'function') return [];
  const names = index.get(outletId);
  return names ? [...names] : [];
}

/**
 * The collect pipeline's whole decision (collect-review-texts.js step 1B-v) as one pure function, so the
 * test runs the same code the pipeline does. Null = leave the credit alone.
 *
 * @param {object} a
 * @param {string} a.criticName  stored credit ('' / 'Unknown' / a name)
 * @param {string} a.outletId    normalized outlet id
 * @param {string} a.fullText    cleaned article text
 * @param {string[]} a.knownCritics critics the registry lists for the outlet
 * @param {boolean} [a.locked]   criticNameManual or _locked: a human set the credit, never override it
 * @param {boolean} [a.excluded] roundup, wrong show/production or duplicate file: not a review to re-credit
 * @returns {{ printedName: string, unnamed: boolean } | null}
 */
function decidePrintedByline({ criticName, outletId, fullText, knownCritics, locked, excluded }) {
  if (locked || excluded || !fullText || !Array.isArray(knownCritics) || knownCritics.length === 0) return null;
  const unnamed = isPlaceholderName(criticName);
  if (unnamed && NO_FILL_OUTLETS.has(outletId)) return null;
  const hit = unnamed
    ? findPrintedKnownByline({ fullText, knownCritics })
    : findPrintedBylineConflict({ criticName, fullText, knownCritics });
  return hit ? { printedName: hit.printedName, unnamed } : null;
}

module.exports = {
  decidePrintedByline,
  looksLikeListingHead,
  NO_FILL_OUTLETS,
  knownCriticsForOutlet,
  HEAD_CHARS,
  isPlaceholderName,
  sameCritic,
  creditedCriticPrinted,
  findPrintedBylineConflict,
  findPrintedKnownByline,
  findUnlistedPrintedByline,
  extractHeaderByline,
  buildKnownCriticsIndex,
};
