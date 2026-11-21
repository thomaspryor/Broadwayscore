'use strict';
/**
 * Full-size poster originals for the social cards (BRO-6393).
 *
 * The site's own poster files are small (cards render them at 112-176 CSS px,
 * so many recent shows have a 160-200 px file), and a 1080x1350 social card
 * needs a portrait poster at least MIN_POSTER_WIDTH wide. Never upscale: the
 * 2026 cards were blurry because they stretched site posters.
 *
 * data/full-size-posters.json holds, per show, the URL of a large original
 * that passed the size rule and the Gemini art check:
 *   { "<showId>": { url, source, width, height, verifiedAt } ,
 *     "_tried": { "<showId>": "YYYY-MM-DD" } }   // searched, nothing found
 * It is written only by `fetch-show-images-auto.js --full-size-posters` and
 * read by scripts/social-autopost/art.js. It never changes the site's files.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const FULL_SIZE_POSTERS_PATH = path.join(ROOT, 'data', 'full-size-posters.json');
const MIN_POSTER_WIDTH = 440; // the card shows it 480 px wide: at most a 9% stretch, invisible
const POSTER_RATIO = { min: 0.6, max: 0.72 }; // width / height; 2:3 is 0.667
const FETCH_TIMEOUT_MS = 20000;
const RETRY_AFTER_DAYS = 3;
const DAY_MS = 86400000;

/** Original-resolution URL: Contentful serves the uploaded master when given no transform params. */
function originalUrl(url) {
  if (!url) return null;
  try {
    const u = new URL(url.startsWith('//') ? `https:${url}` : url);
    if (u.hostname === 'images.ctfassets.net') return `${u.origin}${u.pathname}`;
    return u.toString();
  } catch { return null; }
}

/** Is a measured image usable as the card's poster? `minWidth` follows how wide the layout shows it. */
function isUsablePoster({ width, height, orientation } = {}, minWidth = MIN_POSTER_WIDTH) {
  if (!width || !height) return false;
  if (orientation >= 5) [width, height] = [height, width]; // EXIF 5-8: displayed rotated 90 degrees
  const r = width / height;
  return width >= minWidth && r >= POSTER_RATIO.min && r <= POSTER_RATIO.max;
}

/** verifyImage result -> {ok, reason}. Only a positive match passes. */
function artVerdict(r) {
  if (!r || r.skipped) return { ok: false, reason: 'not verified (no GEMINI_API_KEY)' };
  if (r.match === true) return { ok: true, reason: 'match' };
  return { ok: false, reason: `${r.confidence || 'unknown'}: ${String(r.description || (r.issues || []).join(',')).slice(0, 160)}` };
}

// venue-write-guard-ok: show.venue is only read here (vision-check context), never written back
/** Gemini vision check shared with the site's image pipeline (scripts/lib/verify-image.js). */
async function verifyPosterArt(show, buf, { rateLimiter } = {}) {
  const verify = require('./verify-image');
  const r = await verify.verifyImage(buf, show.title, {
    market: show.category, venue: show.venue, openingDate: show.openingDate,
    creatives: verify.creativesForVerify(show), mimeType: 'image/png', rateLimiter,
  });
  return artVerdict(r);
}

function loadFullSizePosters(file = FULL_SIZE_POSTERS_PATH) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {
    if (e.code === 'ENOENT') return {};
    throw e; // a corrupt file must not be read as {} and then overwritten
  }
}

/** For readers (the social cards): a corrupt file must not stop a post, so read it as empty. */
function loadFullSizePostersSafe(file = FULL_SIZE_POSTERS_PATH) {
  try { return loadFullSizePosters(file); } catch (e) {
    console.warn(`full-size-posters.json unreadable, ignoring it: ${e.message}`);
    return {};
  }
}

function saveFullSizePosters(map, file = FULL_SIZE_POSTERS_PATH) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(map, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

/** Recorded full-size poster for a show, or null. */
function fullSizePosterFor(showId, map) {
  const e = map && showId !== '_tried' ? map[showId] : null;
  return e && typeof e.url === 'string' ? e : null;
}

/** Was this show searched without success recently enough to skip it today? */
function recentlyTried(showId, map, today) {
  const d = map && map._tried && map._tried[showId];
  if (!d) return false;
  return (Date.parse(today) - Date.parse(d)) < RETRY_AFTER_DAYS * DAY_MS;
}

/**
 * Poster candidates art.js tries, best first: a recorded full-size original,
 * the image-sources original, TodayTix's poster for the show's id, then the
 * site's own copy.
 */
function posterCandidates(show, { sources = {}, fullSize = {}, todaytixIds = {} } = {}) {
  const out = [];
  const big = fullSizePosterFor(show.id, fullSize);
  if (big) out.push({ url: big.url });
  const src = sources[show.id] || {};
  if (src.poster && !/^manual:/.test(src.poster)) out.push({ url: originalUrl(src.poster) });
  const ttId = show.todaytixId || (todaytixIds[show.id] && todaytixIds[show.id].id);
  if (ttId) out.push({ todaytixId: ttId, title: show.title });
  const local = show.images && show.images.poster;
  if (local && local.startsWith('/')) out.push({ file: path.join(ROOT, 'public', local) });
  return out.filter((c) => c.url !== null);
}

/** Loose title match, so a recycled TodayTix id cannot supply another show's poster (BRO-6242). */
function sameTitle(a, b) {
  const { foldDiacritics } = require('./title-match');
  const norm = (t) => foldDiacritics(String(t || '')).toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, ' ').replace(/\b(the|a|an)\b/g, ' ').replace(/\s+/g, ' ').trim();
  const x = norm(a), y = norm(b);
  return !!x && !!y && (x.includes(y) || y.includes(x));
}

/** TodayTix's poster URL for a show id (public API, the same one fetch-show-images-auto.js uses); null unless its name matches `title`. */
async function todaytixPosterUrl(id, title) {
  try {
    const res = await fetch(`https://api.todaytix.com/api/v2/shows/${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) return null;
    const data = (await res.json()).data || {};
    if (!sameTitle(data.name || data.displayName, title)) return null;
    const media = data.posterMedia;
    return media && media.imageUrl ? originalUrl(media.imageUrl) : null;
  } catch { return null; }
}

/** Bytes for a candidate ({url} | {todaytixId} | {file}), or null. Sets c.url for TodayTix. */
async function loadPosterBuffer(c) {
  if (c.file) return fs.existsSync(c.file) ? fs.readFileSync(c.file) : null;
  if (c.todaytixId) {
    c.url = await todaytixPosterUrl(c.todaytixId, c.title);
    if (!c.url) return null;
  }
  try {
    const res = await fetch(c.url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BroadwayScorecard/1.0)' } });
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch { return null; }
}

/** Show ids the social ledger is holding for want of a poster (`_meta.waitingForPoster`, any shape). */
function waitingForPosterIds(ledger) {
  const w = ledger && ledger._meta && ledger._meta.waitingForPoster;
  if (!w) return [];
  if (Array.isArray(w)) return w.map((x) => (typeof x === 'string' ? x : x && (x.showId || x.id))).filter(Boolean);
  if (typeof w === 'object') return Object.keys(w);
  return [];
}

/**
 * Shows to search, in the order BRO-6393 asks for: shows the social ledger
 * holds, then shows opening in the next `aheadDays` days (soonest first), then
 * shows that opened in the last `behindDays` days (newest first).
 */
function orderShowsForPosterSearch(shows, { today, waiting = [], aheadDays = 14, behindDays = 90 }) {
  const t = Date.parse(today);
  const waitSet = new Set(waiting);
  const held = [];
  const upcoming = [];
  const recent = [];
  for (const s of shows || []) {
    if (!s || !s.id) continue;
    if (waitSet.has(s.id)) { held.push(s); continue; }
    const o = Date.parse(s.openingDate || '');
    if (Number.isNaN(o)) continue;
    if (o > t && o <= t + aheadDays * DAY_MS) upcoming.push(s);
    else if (o <= t && o >= t - behindDays * DAY_MS) recent.push(s);
  }
  const by = (dir) => (a, b) => dir * (Date.parse(a.openingDate) - Date.parse(b.openingDate));
  return [...held, ...upcoming.sort(by(1)), ...recent.sort(by(-1))];
}

/** Is this URL just a site's home page (an officialUrl that is really the venue)? */
function isSiteRoot(url) {
  try { return /^\/?$/.test(new URL(url).pathname); } catch { return false; }
}

const STOP = new Set(['the', 'a', 'an', 'and', 'of', 'in', 'on', 'at', 'to', 'for', 'with', 'musical', 'play']);

/** Distinctive lowercase words of a title. */
function titleTokens(title) {
  return String(title || '').toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/['‘’]/g, '')
    .split(/[^a-z0-9]+/)
    .filter((w) => w && !STOP.has(w));
}

/**
 * The show's own page linked from a venue page: a same-site link whose path
 * holds every distinctive word of the title (the venue's other shows never
 * do). Shortest path wins. Returns an absolute URL or null.
 */
function findShowLink(html, baseUrl, title) {
  const tokens = titleTokens(title);
  if (tokens.length === 0) return null;
  let base;
  try { base = new URL(baseUrl); } catch { return null; }
  const host = base.hostname.replace(/^www\./, '');
  let best = null;
  for (const m of String(html || '').matchAll(/<a\b[^>]*\bhref\s*=\s*["']([^"'#]+)["']/gi)) {
    let u;
    try { u = new URL(m[1].replace(/&amp;/g, '&'), base); } catch { continue; }
    if (!/^https?:$/.test(u.protocol) || u.hostname.replace(/^www\./, '') !== host) continue;
    if (isSiteRoot(u.toString())) continue;
    const words = new Set(decodeURIComponent(u.pathname).toLowerCase().split(/[^a-z0-9]+/));
    if (!tokens.every((w) => words.has(w))) continue;
    if (!best || u.pathname.length < best.pathname.length) best = u;
  }
  return best ? best.toString() : null;
}

module.exports = {
  FULL_SIZE_POSTERS_PATH,
  MIN_POSTER_WIDTH,
  POSTER_RATIO,
  originalUrl,
  isUsablePoster,
  artVerdict,
  verifyPosterArt,
  loadFullSizePosters,
  saveFullSizePosters,
  loadFullSizePostersSafe,
  fullSizePosterFor,
  recentlyTried,
  posterCandidates,
  sameTitle,
  todaytixPosterUrl,
  loadPosterBuffer,
  waitingForPosterIds,
  orderShowsForPosterSearch,
  isSiteRoot,
  titleTokens,
  findShowLink,
};
