'use strict';
/**
 * Shape and copy rules for structuredTips.seating.seatNotes (BRO-8057). Pure.
 * The writer refuses notes that fail; tests/unit/seat-notes.test.mjs pins the
 * rules and the live-data check runs them over data/theater-metadata.json.
 */

const { HAZARD_TYPES, cleanRowRange, rowSet, copyProblems } = require('./seat-adjudication');
const { BANNED_CLAIM_PATTERNS } = require('./theater-tips-validators');
const { NOTE_TYPES, MAX_NOTES, LEVEL_LABEL, publishableSeatNotes, latestVerified, noteSources } = require('./seat-notes-publish');

// A claim that names a count of sources must cite at least that many hosts (BRO-8057 ship-check).
const COUNT_WORDS = { two: 2, both: 2, three: 3, four: 4, several: 3, multiple: 2 };
const COUNTED_SOURCES = /\b(two|both|three|four|several|multiple)\s+(?:seat\s+)?(guides|sources|reviewers|reviews|sites)\b/i;

const SIDES = new Set(['center', 'left', 'right', 'sides']);
// Pages a note may cite. Anything else (an arbitrary page a model surfaced) is refused.
const SOURCE_HOSTS = new Set([
  'seatplan.com', 'tickpick.com', 'headout.com', 'aviewfrommyseat.com', 'rateyourseats.com',
  'nytix.com', 'reddit.com', 'old.reddit.com', 'broadwayworld.com', 'forum.broadwayworld.com', 'broadwaydirect.com',
  'telecharge.com', 'ticketmaster.com', 'seatgeek.com', 'theatermania.com', 'playbill.com',
]);
// House notes only (owner-approved plan v4): a claim about one production's
// set or staging is not a fact about the seat, and goes stale when it closes.
const PRODUCTION_WORDS = /\b(the set|set piece|scenery|catwalk|elephant|windmill|on-?stage seating|lighting rig|the production|this production|the show's|staging|projections?|cast members?)\b/i;
const CLAIM_MIN = 20;
const CLAIM_MAX = 240;
const SHORT_MIN = 12;
const SHORT_MAX = 70;

function hostOf(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return null;
    return u.hostname.replace(/^www\./, '');
  } catch { return null; }
}

/**
 * @param {string} theater
 * @param {object[]} notes
 * @param {{showTitles?: string[]}} opts  every Broadway show title; house notes may name none
 * @returns {string[]} problems, empty when fine
 */
function validateSeatNotes(theater, notes, { showTitles = [] } = {}) {
  const p = [];
  if (!Array.isArray(notes)) return [`${theater}: seatNotes is not an array`];
  if (notes.length > MAX_NOTES) p.push(`${theater}: ${notes.length} seat notes, max ${MAX_NOTES}`);
  // Judged as of the newest check, so an old value note expiring later is not a data error.
  if (notes.length && !publishableSeatNotes(notes, { today: new Date(latestVerified(notes) || 0) }).length) {
    p.push(`${theater}: seat notes do not clear the bar (>=2, with a watch-out or value); store none instead`);
  }
  notes.forEach((n, i) => {
    const at = `${theater} / seatNotes[${i}]`;
    if (!n || typeof n !== 'object') { p.push(`${at}: not an object`); return; }
    if (!NOTE_TYPES.includes(n.type)) p.push(`${at}: bad type ${n.type}`);
    if (!LEVEL_LABEL[n.level]) p.push(`${at}: bad level ${n.level}`);
    if (n.side !== undefined && !SIDES.has(n.side)) p.push(`${at}: bad side ${n.side}`);
    if (n.rows !== undefined && cleanRowRange(n.rows) !== n.rows) p.push(`${at}: rows is not a plain row or range: ${n.rows}`);
    if (n.hazard !== undefined && (!HAZARD_TYPES.has(n.hazard) || n.type !== 'watch-out')) p.push(`${at}: hazard only on watch-out, from the known list`);
    const claim = String(n.claim || '');
    if (claim.length < CLAIM_MIN || claim.length > CLAIM_MAX) p.push(`${at}: claim length ${claim.length} outside ${CLAIM_MIN}-${CLAIM_MAX}`);
    if (PRODUCTION_WORDS.test(claim)) p.push(`${at}: names a production or set piece (house notes only)`);
    const counted = claim.match(COUNTED_SOURCES);
    if (counted && noteSources(n).length < COUNT_WORDS[counted[1].toLowerCase()]) {
      p.push(`${at}: claim says "${counted[0]}" but cites ${noteSources(n).length} source(s)`);
    }
    // Owner 2026-11-22: the Center Orchestra is the top price tier. "Cheaper than
    // premium" is not good value, so a value note there is refused outright.
    if (n.type === 'value' && n.level === 'orchestra' && (!n.side || n.side === 'center')) {
      p.push(`${at}: value note on the Center Orchestra (top price tier; cheaper than premium is not good value)`);
    }
    for (const c of copyProblems(claim, { forbiddenTitles: showTitles })) p.push(`${at}: ${c}`);
    for (const b of BANNED_CLAIM_PATTERNS) if (b.pattern.test(claim)) p.push(`${at}: ${b.reason}`);
    // The closed card shows a watch-out and a value note as one-line headlines.
    if (n.short === undefined) {
      if (n.type === 'watch-out' || n.type === 'value') p.push(`${at}: watch-out and value notes need a short headline`);
    } else {
      const short = String(n.short);
      if (short.length < SHORT_MIN || short.length > SHORT_MAX) p.push(`${at}: short headline length ${short.length} outside ${SHORT_MIN}-${SHORT_MAX}`);
      if (/[.!]$/.test(short)) p.push(`${at}: short headline ends with punctuation (the card adds it)`);
      if (PRODUCTION_WORDS.test(short)) p.push(`${at}: short headline names a production or set piece`);
      for (const c of copyProblems(short, { forbiddenTitles: showTitles })) p.push(`${at}: short headline: ${c}`);
      for (const b of BANNED_CLAIM_PATTERNS) if (b.pattern.test(short)) p.push(`${at}: short headline: ${b.reason}`);
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(n.verifiedAt || ''))) p.push(`${at}: verifiedAt must be YYYY-MM-DD`);
    const ev = Array.isArray(n.evidence) ? n.evidence : [];
    if (!ev.length) p.push(`${at}: no evidence (unsourced)`);
    for (const e of ev) {
      const h = e && hostOf(e.url);
      if (!h) p.push(`${at}: evidence url must be https: ${e && e.url}`);
      else if (!SOURCE_HOSTS.has(h)) p.push(`${at}: evidence host not allowed: ${h}`);
      if (!e || !/^[0-9a-f]{8,64}$/.test(String(e.quoteHash || ''))) p.push(`${at}: evidence missing quoteHash`);
      if (!e || !/^\d{4}-\d{2}-\d{2}/.test(String(e.fetchedAt || ''))) p.push(`${at}: evidence missing fetchedAt`);
    }
  });
  // A watch-out and a value note on overlapping rows of the same block contradict each other.
  for (let i = 0; i < notes.length; i++) {
    for (let j = i + 1; j < notes.length; j++) {
      const a = notes[i], b = notes[j];
      // No side means the whole level, so it can collide with any side.
      if (!a || !b || a.level !== b.level || (a.side && b.side && a.side !== b.side)) continue;
      const types = new Set([a.type, b.type]);
      if (!(types.has('watch-out') && types.has('value'))) continue;
      const ra = a.rows ? rowSet(a.rows) : null, rb = b.rows ? rowSet(b.rows) : null;
      const overlap = !ra || !rb || [...ra].some((r) => rb.has(r));
      if (overlap) p.push(`${theater}: watch-out and value notes overlap (seatNotes[${i}] / seatNotes[${j}])`);
    }
  }
  return p;
}

module.exports = { validateSeatNotes, SOURCE_HOSTS, PRODUCTION_WORDS };
