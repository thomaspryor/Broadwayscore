/**
 * Brief posts (BRO-6368): one-off posts the owner asks for, built from a template.
 * Pure rules shared by the session CLI (brief.js) and the workflow (run.js --brief):
 * which pairs a template accepts, the facts it states, the manifest hash, dedupe,
 * and when the post may go out. No network, no browser; unit-tested in
 * scripts/social-autopost.test.mjs.
 *
 * Flow: brief.js --preview builds the card and captions, stores manifest.json in
 * Supabase under its hash and prints it for the owner. brief.js --post stores the
 * owner's words and dispatches social-autopost.yml with only the hash; run.js
 * re-reads the manifest, re-hashes it, re-checks every fact and posts it.
 */

const crypto = require('crypto');
const C = require('./config');
const { foldDiacritics } = require('../lib/title-match');
const { buildCompareCaptions, validateHook, strayNumbers, productionLabel, CITY, LIMITS } = require('./captions');

const TEMPLATES = ['compare'];
const HASH_RE = /^[0-9a-f]{12}$/;
const DAY_MS = 864e5;
const MIN_MS = 60e3;
const SO_FAR_DAYS = 14; // a production that opened less than this long ago gets "so far"
const PAIR_DEDUPE_DAYS = 30;
const MAX_SLOT_DAYS = 3; // a brief post is refused past this: Buffer keeps its numbers fixed, so they must still be true when it goes out

/** JSON with sorted keys, so the same manifest always hashes the same. */
function stableStringify(v) {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}

function hashManifest(manifest) {
  return crypto.createHash('sha256').update(stableStringify(manifest)).digest('hex').slice(0, 12);
}

function pairKey(ids) {
  return [...ids].sort().join('+');
}

function startDate(show) {
  return String(show.openingDate || show.previewsStartDate || '').slice(0, 10);
}

const normTitle = t => foldDiacritics(String(t || '')).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * Compare template: the same title in New York and London. Returns {older, newer}
 * (by opening date, else previews date) or throws with a one-line reason.
 */
function orderCompare(a, b) {
  if (!a || !b) throw new Error('compare needs two shows that exist in shows.json');
  if (a.id === b.id) throw new Error('compare needs two different productions');
  for (const s of [a, b]) if (!CITY[s.category]) throw new Error(`${s.id}: compare covers Broadway, Off-Broadway, West End and Off-West End only (got ${s.category})`);
  if (normTitle(a.title) !== normTitle(b.title)) throw new Error(`compare needs the same title in both cities ("${a.title}" vs "${b.title}")`);
  if (CITY[a.category] === CITY[b.category]) throw new Error(`compare needs one New York and one London production (both are in ${CITY[a.category]})`);
  if (!startDate(a) || !startDate(b)) throw new Error('compare needs an opening or previews date for both productions');
  return startDate(a) <= startDate(b) ? { older: a, newer: b } : { older: b, newer: a };
}

function isSoFar(show, now) {
  if (!show.openingDate) return false;
  const opened = Date.parse(`${String(show.openingDate).slice(0, 10)}T00:00:00Z`);
  return Number.isFinite(opened) && now - opened < SO_FAR_DAYS * DAY_MS;
}

/** The facts a compare post states, per show id: rounded badge score and review count. */
function factsOf(descs) {
  return Object.fromEntries(descs.map(d => [d.show.id, { score: d.score, reviewCount: d.reviewCount }]));
}

/** The only numbers a caption may carry: the facts, the gap, each production's year and digits in the title. */
function allowedNumbers(shows, facts, delta) {
  return [...Object.values(facts).flatMap(f => [f.score, f.reviewCount]), delta,
    ...shows.map(s => startDate(s).slice(0, 4)), ...shows.flatMap(s => String(s.title || '').match(/\d+/g) || [])];
}

/** Facts that differ between the manifest and the site now, as readable lines. */
function factChanges(was, now) {
  const out = [];
  for (const [id, f] of Object.entries(was || {})) {
    const cur = now[id];
    if (!cur) { out.push(`${id}: no longer has a Critic Score`); continue; }
    for (const k of ['score', 'reviewCount']) if (f[k] !== cur[k]) out.push(`${id}: ${k} was ${f[k]}, is now ${cur[k]}`);
  }
  return out;
}

/**
 * Everything a compare post shows, from two run.js describe() results.
 * Throws when the hook breaks the rules or a caption carries a number that is not a fact.
 */
function buildCompare({ descA, descB, hook = '', now }) {
  const { older: olderShow } = orderCompare(descA.show, descB.show);
  const [older, newer] = olderShow === descA.show ? [descA, descB] : [descB, descA];
  const hookProblem = validateHook(hook);
  if (hookProblem) throw new Error(hookProblem);
  const side = d => ({ show: d.show, score: d.score, reviewCount: d.reviewCount, soFar: isSoFar(d.show, now) });
  const p = { newer: side(newer), older: side(older), hook: hook ? hook.trim() : '' };
  const captions = buildCompareCaptions(p);
  const delta = Math.abs(newer.score - older.score);
  const facts = factsOf([older, newer]);
  const allowed = allowedNumbers([older.show, newer.show], facts, delta);
  for (const [net, text] of Object.entries(captions)) {
    const stray = strayNumbers(text, allowed);
    if (stray.length) throw new Error(`${net} caption carries number(s) that are not facts: ${stray.join(', ')}`);
    if (text.includes('\u2014')) throw new Error(`${net} caption has an em dash`);
    const len = [...(net === 'twitter' ? text.replace(/https?:\/\/\S+/g, 'x'.repeat(23)) : text)].length; // X counts every link as 23
    if (LIMITS[net] && len > LIMITS[net]) throw new Error(`${net} caption is ${len} characters, over its ${LIMITS[net]} limit`);
  }
  const card = {
    title: newer.show.title, market: newer.show.category, delta,
    sides: [older, newer].map(d => ({ market: d.show.category, label: productionLabel(d.show), score: d.score, tierId: d.tierId, reviewCount: d.reviewCount, soFar: isSoFar(d.show, now) })),
  };
  return { older, newer, captions, card, delta, facts };
}

/** Ledger entries that block this brief: the same hash ever, or the same pair in 30 days. */
function briefConflicts(ledger, { hash, pair }, now) {
  const posts = (ledger && ledger.posts) || [];
  const sameHash = posts.find(p => p.type === 'brief' && p.hash === hash) || null;
  // An automatic London comparison (BRO-6373) for the pair also blocks a brief, whatever its age.
  const samePair = posts.find(p => p.type === 'london-compare' && p.pair === pair)
    || posts.find(p => p.type === 'brief' && p.hash !== hash && p.pair === pair
    && now - Date.parse(p.dueAt || p.date || 0) < PAIR_DEDUPE_DAYS * DAY_MS) || null;
  return { sameHash, samePair };
}

/**
 * When a brief post goes out: the first time from now+10 min that is inside the
 * daytime window (in `tz`, the newer production's market), STAGGER_MINUTES from
 * every post in `taken`, and on a local day that none of `shows` ({tz, busy:Set of
 * YYYY-MM-DD}) already has a post. `earliest` (ms) holds the search back to a known
 * slot, e.g. a London comparison's morning after. Null when no such time exists within MAX_SLOT_DAYS.
 * select.js supplies the window helpers (passed in to keep this module pure).
 */
function pickBriefSlot({ now, earliest = 0, tz, shows, taken, inWindow, nextWindowSlot, zonedTime, localDay }) {
  const gap = C.STAGGER_MINUTES * MIN_MS;
  const nextDay = (t) => {
    const d = new Date(`${localDay(t, tz)}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 1);
    return zonedTime(d.toISOString().slice(0, 10), C.SCORE_POST_WINDOW.start, tz).getTime();
  };
  let t = nextWindowSlot(Math.max(earliest, now + 10 * MIN_MS), tz);
  for (let guard = 0; guard < 200 && t - now <= MAX_SLOT_DAYS * DAY_MS; guard++) {
    if (!inWindow(t, tz)) { t = nextWindowSlot(t, tz); continue; }
    if (shows.some(s => s.busy.has(localDay(t, s.tz)))) { t = nextDay(t); continue; }
    const clash = taken.filter(x => Math.abs(x - t) < gap);
    if (clash.length) { t = Math.max(...clash) + gap; continue; }
    return t;
  }
  return null;
}

module.exports = {
  TEMPLATES, HASH_RE, PAIR_DEDUPE_DAYS, SO_FAR_DAYS, MAX_SLOT_DAYS,
  stableStringify, hashManifest, pairKey, orderCompare, isSoFar, factsOf, allowedNumbers, factChanges, buildCompare, briefConflicts, pickBriefSlot,
};
