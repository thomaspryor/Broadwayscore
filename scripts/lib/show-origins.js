'use strict';
/**
 * Show origins (BRO-5842): how a Broadway production got to Broadway (its
 * route) and what it is based on (its source). Pure helpers shared by
 * scripts/classify-show-origins.js (writes data/show-origins.json) and the
 * tests. src/lib/show-origins.ts mirrors the code lists for the page.
 */

const { isBroadwayCategory } = require('./venue-classification');

/** Earlier staged runs a production can have before Broadway, in the order they usually happen. */
const PATH_STAGES = ['regional-us', 'off-broadway', 'london', 'international'];

/** What a production is based on. */
const SOURCE_TYPES = ['film', 'tv', 'book', 'play', 'music-catalog', 'other', 'original'];

const CONFIDENCE = ['high', 'medium', 'low'];

/** An original work's story: about real people or events, or made up (BRO-5871). */
const ORIGINAL_KINDS = ['true-story', 'invented'];

/** Season 2000-01 onward (seasons start July 1, as in the Season Report). */
const FIRST_OPENING_DATE = '2000-07-01';

/**
 * Broadway productions in scope: opened, in previews or announced (upcoming) from FIRST_OPENING_DATE on.
 * @param {object[]} shows - shows.json rows
 * @returns {object[]}
 */
function inScopeShows(shows) {
  return shows.filter((s) => isBroadwayCategory(s)
    && s.openingDate && s.openingDate >= FIRST_OPENING_DATE
    && !s.cancelledBeforeOpening && !s.tourOf);
}

/** Days a show may be open before a missing origin record is an error (the labeling job runs weekly). */
const ORIGIN_GRACE_DAYS = 10;

/**
 * In-scope shows that are open/closed/in previews, opened at least
 * ORIGIN_GRACE_DAYS ago, and have no origin record (BRO-5867).
 * @param {object[]} shows - shows.json rows
 * @param {Record<string, object>} origins - data/show-origins.json `shows`
 * @param {string} today - YYYY-MM-DD
 * @returns {object[]}
 */
function showsMissingOrigin(shows, origins, today) {
  const cutoff = new Date(Date.parse(today) - ORIGIN_GRACE_DAYS * 86400000).toISOString().slice(0, 10);
  return inScopeShows(shows).filter((s) => ['open', 'closed', 'previews'].includes(s.status)
    && s.openingDate <= cutoff && !(origins || {})[s.id]);
}

function isHttpUrl(u) {
  return typeof u === 'string' && /^https?:\/\/[^\s]+\.[^\s]+/.test(u);
}

/** Comparable form of a URL: no scheme, www, query, fragment or trailing slash. */
function urlKey(u) {
  let s = String(u);
  try { s = decodeURI(s); } catch { /* keep as is */ }
  return s.toLowerCase().replace(/^https?:\/\/(www\.)?/, '').replace(/[?#].*$/, '').replace(/\/+$/, '');
}

/**
 * Check and normalize one model answer. Returns {record} or {error}.
 * Stages keep the model's order (the order they happened), duplicates dropped.
 * When `seen` (URLs the web search returned) is given, only evidence found
 * there is kept, so a made-up URL can't pass as a citation.
 * @param {object} raw
 * @param {string[]} [seen]
 * @returns {{record?: object, error?: string}}
 */
function normalizeOrigin(raw, seen) {
  if (!raw || typeof raw !== 'object') return { error: 'not an object' };
  if (!Array.isArray(raw.path)) return { error: 'path is not an array' };
  const path = [];
  for (const p of raw.path) {
    const code = String(p).trim().toLowerCase();
    if (!PATH_STAGES.includes(code)) return { error: `unknown path stage "${p}"` };
    if (!path.includes(code)) path.push(code);
  }
  const source = String(raw.source || '').trim().toLowerCase();
  if (!SOURCE_TYPES.includes(source)) return { error: `unknown source "${raw.source}"` };
  const confidence = CONFIDENCE.includes(raw.confidence) ? raw.confidence : 'low';
  const seenKeys = seen ? new Set(seen.map(urlKey)) : null;
  const evidence = (Array.isArray(raw.evidence) ? raw.evidence : [raw.evidence])
    .filter(isHttpUrl).filter((u) => !seenKeys || seenKeys.has(urlKey(u))).slice(0, 3);
  if (!evidence.length) return { error: seenKeys ? 'no evidence url the search returned' : 'no evidence url' };
  const sourceTitle = source === 'original' ? null : (raw.sourceTitle ? String(raw.sourceTitle).slice(0, 160) : null);
  return {
    record: {
      path,
      pathNote: raw.pathNote ? String(raw.pathNote).slice(0, 240) : null,
      source,
      sourceTitle,
      confidence,
      evidence,
    },
  };
}

// Places that mark a stage outside the US. A pathNote naming one while the
// codes leave that stage out means the model mis-coded a stop it found.
const UK_PLACES = /\b(London|West End|National Theatre|Donmar|Almeida|Royal Court|Old Vic|Young Vic|Chichester|Edinburgh|Manchester|Menier|Bridge Theatre|Hampstead|Glasgow|Birmingham|Bristol|Leeds|Liverpool|Norwich|Bath|Stratford-upon-Avon|Royal Shakespeare|Cambridge Arts|Kiln|Sheffield)\b/i;
const INTL_PLACES = /\b(Toronto|Edmonton|Vancouver|Montreal|Calgary|Ottawa|Stratford Festival|Canada|Sydney|Melbourne|Australia|Seoul|Korea|Tokyo|Japan|Berlin|Germany|Vienna|Austria|Hamburg|Paris|France|Dublin|Ireland|Amsterdam|Netherlands|Stockholm|Sweden|Copenhagen|Oslo|Tel Aviv|Israel|Mexico|Johannesburg|Cape Town|South Africa|Auckland|New Zealand|Madrid|Spain|Milan|Italy)\b/i;

/**
 * Stages the pathNote names but the codes miss. Edinburgh, Cambridge and
 * Stratford are ambiguous with US/Canadian places, so only the qualified
 * forms count (Cambridge Arts, Stratford-upon-Avon).
 * @param {{path: string[], pathNote: string|null}} rec
 * @returns {string[]}
 */
function pathNoteConflicts(rec) {
  const note = rec.pathNote || '';
  const out = [];
  if (UK_PLACES.test(note) && !rec.path.includes('london')) out.push('london');
  if (INTL_PLACES.test(note) && !rec.path.includes('international')) out.push('international');
  return out;
}

/**
 * A second opinion's labels only (no evidence needed): {record: {path, source}} or {error}.
 * @param {object} raw
 */
function normalizeCheck(raw) {
  const n = normalizeOrigin(raw && { ...raw, evidence: ['https://placeholder.invalid/'] });
  if (n.error) return n;
  return { record: { path: n.record.path, source: n.record.source } };
}

/** Same stops (any order) and the same source display bucket. */
function originsAgree(a, b) {
  const pa = [...a.path].sort().join(',');
  const pb = [...b.path].sort().join(',');
  return pa === pb && sourceBucket(a.source) === sourceBucket(b.source);
}

/** Display bucket for a route: "direct", one stage, or "multiple". */
function pathBucket(path) {
  if (!path.length) return 'direct';
  return path.length === 1 ? path[0] : 'multiple';
}

/** Display bucket for a source: film and TV together, play and other together. */
function sourceBucket(source) {
  if (source === 'film' || source === 'tv') return 'screen';
  if (source === 'play' || source === 'other') return 'other';
  return source; // book, music-catalog, original
}

module.exports = {
  PATH_STAGES,
  SOURCE_TYPES,
  CONFIDENCE,
  ORIGINAL_KINDS,
  FIRST_OPENING_DATE,
  inScopeShows,
  showsMissingOrigin,
  ORIGIN_GRACE_DAYS,
  normalizeOrigin,
  urlKey,
  pathNoteConflicts,
  normalizeCheck,
  originsAgree,
  pathBucket,
  sourceBucket,
};
