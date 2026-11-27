'use strict';
/**
 * sb-market-gate.js: keep ScrapingBee (the last, priciest paid tier) for Broadway
 * and out of the other markets' background retries (BRO-8323).
 *
 * Owner rule (2026-11-25): Broadway openings stay fast and comprehensive; other
 * markets (West End, Off-Broadway, off-West-End, regional, tour) may take 6 to 8
 * hours. ScrapingBee is a flat monthly pack with no rollover, so every credit a
 * non-Broadway show burns can push Broadway into a dry pack late in the cycle.
 *
 * Two cuts, both Broadway-neutral by construction (category === 'broadway' and
 * any show we cannot classify are never touched, so every failure mode keeps
 * today's behaviour):
 *
 *   1. SERP rung. A non-Broadway show's SERP chain skips ScrapingBee. It is the
 *      third rung (Scrapingdog, then Bright Data, then ScrapingBee) and a re-ask
 *      costs 25 credits. BRO-7531 measured 0 finds in ~750 such re-asks on
 *      Off-Broadway/off-West-End.
 *   2. JS search render. A non-Broadway show's paid JS site-search render of the
 *      same outlet host runs at most once per gap (default 30 min). The poller
 *      re-renders the same outlet page every tick; a review that lands between
 *      two renders is found on the next one; the replay bounds the added delay inside the
 *      6 to 8 hour budget.
 *
 * Kill switches: SB_MARKET_GATE_DISABLED=1 (both), SB_RENDER_GAP_HOURS=0 (cut 2).
 */

const fs = require('fs');
const path = require('path');

// 0.5h: replay of the 2026-11 ledger (scripts/sb-market-gate-replay.js) shows worst-case added
// delay 6.2h at 0.5h, but 13.9h at 1h and 17.4h at 3h, past the 6 to 8h budget for other markets.
const DEFAULT_RENDER_GAP_HOURS = 0.5;
const DEFAULT_SHOWS_PATH = path.join(__dirname, '..', '..', 'data', 'shows.json');
// 3h of ledger at the 2026-11 peak (~10MB/day) is ~1.3MB; read well past that.
const LEDGER_TAIL_BYTES = 6 * 1024 * 1024;

// Allowlist of the markets that are gated (never a test for Broadway itself).
// Only these are ever gated. Anything else (broadway, null, a category added later) is untouched.
const GATED_CATEGORIES = new Set(['off-broadway', 'west-end', 'off-west-end', 'regional', 'tour']);

let _showsPath = DEFAULT_SHOWS_PATH;
let _categoryById = null;

function gateDisabled(env = process.env) {
  return env.SB_MARKET_GATE_DISABLED === '1';
}

// These are London-specific aggregators, including their archive/API calls
// that do not belong to a single show. The Stage also covers other markets.
function skipSbAggregator(url, env = process.env) {
  if (gateDisabled(env)) return false;
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
    return new Set(['theatre.reviews', 'westendtheatre.com', 'londonboxoffice.co.uk']).has(host);
  } catch (_) { return false; }
}

function _loadCategories() {
  if (_categoryById) return _categoryById;
  const map = new Map();
  try {
    const d = JSON.parse(fs.readFileSync(_showsPath, 'utf8'));
    for (const s of (d.shows || d)) if (s && s.id) map.set(s.id, s.category || null);
  } catch (_) { /* unreadable: empty map => every lookup is null => fail open */ }
  _categoryById = map;
  return map;
}

/** Category for a show id, or null when unknown (callers treat null as "not safe to gate"). */
function categoryForShowId(showId) {
  if (!showId) return null;
  const c = _loadCategories().get(showId);
  return c === undefined ? null : c;
}

/**
 * Pure: should ScrapingBee be dropped from this show's SERP chain?
 * True only for a show we positively know is not Broadway.
 */
function skipSbSerpForCategory(category, env = process.env) {
  if (gateDisabled(env)) return false;
  return GATED_CATEGORIES.has(category); // unknown or missing category fails open
}

/** Skip set for the SERP chain, from the show the current call is spending for. */
function sbSerpMarketSkips(showId, env = process.env) {
  const skips = new Set();
  if (skipSbSerpForCategory(categoryForShowId(showId), env)) skips.add('scrapingbee');
  return skips;
}

/** Gap in ms between paid JS renders of one host for one non-Broadway show (0 = off). */
function renderGapMs(env = process.env) {
  if (gateDisabled(env)) return 0;
  const raw = env.SB_RENDER_GAP_HOURS;
  if (raw === undefined || raw === null || String(raw).trim() === '') return DEFAULT_RENDER_GAP_HOURS * 3600 * 1000;
  const h = Number(raw);
  return Number.isFinite(h) && h > 0 ? h * 3600 * 1000 : 0;
}

/**
 * Pure: should this JS render be skipped because the same show+host was rendered
 * inside the gap? `lastRenderMs` is the newest ledger row's time (null = none).
 */
function renderGapDecision({ category, lastRenderMs, nowMs = Date.now(), env = process.env }) {
  const gap = renderGapMs(env);
  if (!gap) return { skip: false, reason: 'gap-off' };
  if (!GATED_CATEGORIES.has(category)) return { skip: false, reason: category ? 'not-gated-category' : 'unclassified' };
  if (!Number.isFinite(lastRenderMs)) return { skip: false, reason: 'no-prior-render' };
  const age = nowMs - lastRenderMs;
  // A future timestamp (clock skew) is not evidence of a recent render: render.
  if (age < 0 || age >= gap) return { skip: false, reason: 'gap-elapsed' };
  return { skip: true, reason: 'rendered-within-gap', ageMs: age, gapMs: gap };
}

const _normHost = (h) => String(h || '').toLowerCase().replace(/^www\./, '');

// One tail read builds an index of newest successful SB render per show|host; reused for
// INDEX_TTL_MS so a poller tick that checks many outlets reads the ledger once, not per outlet.
const INDEX_TTL_MS = 15 * 1000;
let _index = null; // { path, builtAt, tailBytes, map: Map<showId, Map<host, ms>> }

function _buildIndex(ledgerPath, tailBytes) {
  const map = new Map();
  let fd;
  try {
    fd = fs.openSync(ledgerPath, 'r');
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - tailBytes);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString('utf8').split('\n');
    if (start > 0) lines.shift(); // first line may be cut mid-row
    for (const line of lines) {
      if (!line || line.indexOf('"scrapingbee"') === -1) continue;
      let r;
      try { r = JSON.parse(line); } catch (_) { continue; }
      // A failed render (401/429/timeout) found nothing, so it must not suppress the next try.
      if (r.provider !== 'scrapingbee' || r.fn !== 'render' || r.success !== true || !r.showId || !r.host) continue;
      const t = Date.parse(r.ts);
      if (!Number.isFinite(t)) continue;
      const h = _normHost(r.host);
      let m = map.get(r.showId);
      if (!m) map.set(r.showId, (m = new Map()));
      if (!(m.get(h) >= t)) m.set(h, t);
    }
  } catch (_) {
    return new Map(); // unreadable ledger: empty index => every check fails open
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch (_) { /* ignore */ } }
  }
  return map;
}

/**
 * Newest successful ScrapingBee render row for (showId, host) in the tail of the ledger, as
 * epoch ms, or null. Reads only the tail (the ledger is 30MB+), once per INDEX_TTL_MS.
 * Host match ignores a leading www. and accepts a subdomain of the outlet domain.
 */
function lastSbRenderMs(ledgerPath, showId, host, { tailBytes = LEDGER_TAIL_BYTES, nowMs = Date.now() } = {}) {
  if (!ledgerPath || !showId || !host) return null;
  if (!_index || _index.path !== ledgerPath || _index.tailBytes !== tailBytes || nowMs - _index.builtAt >= INDEX_TTL_MS || nowMs < _index.builtAt) {
    _index = { path: ledgerPath, tailBytes, builtAt: nowMs, map: _buildIndex(ledgerPath, tailBytes) };
  }
  const m = _index.map.get(showId);
  if (!m) return null;
  const want = _normHost(host);
  let newest = null;
  for (const [h, t] of m) {
    if (h === want || h.endsWith('.' + want)) { if (newest === null || t > newest) newest = t; }
  }
  return newest;
}

function _resetIndexForTests() { _index = null; }

/** Test-only: point the category lookup at a fixture (falsy restores the real file). */
function _setShowsPathForTests(p) {
  _showsPath = p || DEFAULT_SHOWS_PATH;
  _categoryById = null;
}

module.exports = {
  skipSbAggregator,
  DEFAULT_RENDER_GAP_HOURS,
  categoryForShowId,
  skipSbSerpForCategory,
  sbSerpMarketSkips,
  renderGapMs,
  renderGapDecision,
  lastSbRenderMs,
  _setShowsPathForTests,
  _resetIndexForTests,
};
