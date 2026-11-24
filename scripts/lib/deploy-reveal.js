'use strict';
/**
 * deploy-reveal.js (BRO-8236): does a commit range contain an opening-night
 * "reveal", i.e. something a visitor would see that must ship right now?
 *
 * Urgent deploy triggers (opening-night poller, rebuild-fast) used to ship on
 * every HEAD move, ~200 prod deploys/day, because every rebuild rewrites
 * public/data/shows/*.json with sub-integer score drift and quote churn. The
 * deploy gate now asks this module first: a reveal keeps "ship now"; anything
 * else is judged as a routine trigger (45-min min interval + deferred retry,
 * 3h backstop).
 *
 * A reveal is any of:
 *   - a CODE_PATHS change (site code), or a changed NYT Critic's Picks list
 *     (data/nyt-critics-picks.json `urls`; its _meta timestamp churns every run)
 *   - for a show in its opening window (public/opening-night-status.json
 *     `shows` + `upcoming`, either side of the range), a
 *     public/data/shows/<id>.json whose review projection changed: displayed
 *     (rounded) critic score, review count, bucket counts, or the set of reviews
 *     (keyed by URL) with their score and verdict. Quote text, sub-integer score
 *     drift and a regenerated critics' take summary (cn) are ignored: they ride
 *     the routine deploy (replay: 20 of 76 opening-window ranges in 48h were
 *     cn-text-only). An added or deleted file that has
 *     reviews counts.
 *
 * Catalog-wide score churn on shows outside the opening window is routine: the
 * owner allows other pages to lag up to the 3h backstop.
 *
 * Every uncertainty fails OPEN (reveal = true): unknown baseline, git errors,
 * unparsable JSON, a missing/unreadable opening-night status file (then every
 * show counts as opening), or more than MAX_SHOW_FILES changed show files (a full
 * regeneration is not worth reading file by file).
 */
const { spawnSync } = require('child_process');

const SHOW_DIR = 'public/data/shows/';
const NYT_PICKS = 'data/nyt-critics-picks.json';
const REVEAL_DATA_FILES = [NYT_PICKS];
const STATUS_FILE = 'public/opening-night-status.json';
const MAX_SHOW_FILES = 600;

/** Pure: the visitor-visible review state of one public show JSON (string, comparable). */
function reviewProjection(json) {
  if (!json || typeof json !== 'object') return null;
  const rv = Array.isArray(json.rv) ? json.rv : [];
  const reviews = rv
    .map((r) => [String(r.u || `${r.o || ''}|${r.cn || ''}`), r.s ?? null, r.v ?? null])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return JSON.stringify({
    cs: typeof json.cs === 'number' ? Math.round(json.cs) : null,
    rc: json.rc ?? null,
    bd: json.bd ?? null,
    rv: reviews,
  });
}

/** Pure: show ids in the opening window from opening-night-status.json text, or null if unreadable. */
function openingIdsFrom(statusText) {
  if (statusText == null) return null;
  try {
    const j = JSON.parse(statusText);
    if (!Array.isArray(j.shows)) return null;
    return [...j.shows, ...(Array.isArray(j.upcoming) ? j.upcoming : [])].map((s) => s && s.id).filter(Boolean);
  } catch {
    return null;
  }
}

function hasReviews(json) {
  return !!json && Array.isArray(json.rv) && json.rv.length > 0;
}

const showIdOf = (f) => f.slice(SHOW_DIR.length, -'.json'.length);

/** Pure: NYT picks changed in a visible way (the url list), fail open on bad JSON. */
function nytPicksChanged(pair) {
  if (!pair) return true;
  try {
    const urls = (t) => (t == null ? null : JSON.stringify(JSON.parse(t).urls ?? null));
    return urls(pair.before) !== urls(pair.after);
  } catch {
    return true;
  }
}

/**
 * Pure: classify changed files. `read(path) -> {before, after}` returns raw
 * file text (null when absent on that side). `openingIds` is the list of show
 * ids in the opening window, or null (unknown: every show counts). Returns
 * { reveal: boolean, reason: string, file: string|null }.
 */
function classifyReveal(files, read, { codePaths = [], maxShowFiles = MAX_SHOW_FILES, openingIds = null } = {}) {
  const isCode = (f) => codePaths.some((p) => (p.endsWith('/') ? f.startsWith(p) : f === p));
  for (const f of files) {
    if (isCode(f)) return { reveal: true, reason: 'code', file: f };
  }
  if (files.includes(NYT_PICKS)) {
    let pair;
    try { pair = read(NYT_PICKS); } catch { pair = null; }
    if (nytPicksChanged(pair)) return { reveal: true, reason: 'nyt-picks', file: NYT_PICKS };
  }
  const opening = openingIds ? new Set(openingIds) : null;
  const allShows = files.filter((f) => f.startsWith(SHOW_DIR) && f.endsWith('.json'));
  const shows = opening ? allShows.filter((f) => opening.has(showIdOf(f))) : allShows;
  if (shows.length > maxShowFiles) return { reveal: true, reason: `too-many-show-files(${shows.length})`, file: null };
  for (const f of shows) {
    let pair;
    try { pair = read(f); } catch { return { reveal: true, reason: 'read-error', file: f }; }
    if (!pair) return { reveal: true, reason: 'read-error', file: f };
    let before = null;
    let after = null;
    try {
      before = pair.before == null ? null : JSON.parse(pair.before);
      after = pair.after == null ? null : JSON.parse(pair.after);
    } catch {
      return { reveal: true, reason: 'parse-error', file: f };
    }
    if (before == null || after == null) {
      if (hasReviews(before) || hasReviews(after)) return { reveal: true, reason: before == null ? 'show-added' : 'show-deleted', file: f };
      continue;
    }
    if (reviewProjection(before) !== reviewProjection(after)) return { reveal: true, reason: 'reviews-changed', file: f };
  }
  const scope = opening ? `${shows.length}/${allShows.length} opening` : `${shows.length}`;
  return { reveal: false, reason: allShows.length ? `no-visible-change(${scope} show files)` : 'no-reveal-paths', file: null };
}

/**
 * Pure: should this trigger keep ship-now semantics?
 * - not urgent -> routine
 * - always-ship source (opening-night-reveal, urgent) -> urgent
 * - baseline unknown or == HEAD -> unchanged (urgent); the existing data-dirty
 *   handling in decide() covers a private-only data advance
 * - otherwise urgent only on a reveal (classification error = reveal)
 */
function resolveUrgency({ urgent, alwaysShip, baselineSha, headSha, reveal }) {
  if (!urgent) return { urgent: false, why: 'routine-trigger' };
  if (alwaysShip) return { urgent: true, why: 'always-ship-source' };
  if (!baselineSha || baselineSha === headSha) return { urgent: true, why: 'no-range' };
  if (!reveal || reveal.reveal) return { urgent: true, why: `reveal:${reveal ? reveal.reason : 'unknown'}` };
  return { urgent: false, why: `no-reveal:${reveal.reason}` };
}

// ---- git side (not pure) ----

function gitOut(args, opts = {}) {
  const r = spawnSync('git', args, { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024, timeout: 120000, ...opts });
  if (r.status !== 0) throw new Error(`git ${args[0]} failed: ${(r.stderr || '').trim().slice(0, 200)}`);
  return r.stdout;
}

/** Read many blobs in one `git cat-file --batch` call. Returns Map spec -> text|null. */
function catFileBatch(specs) {
  const out = new Map();
  if (!specs.length) return out;
  const r = spawnSync('git', ['cat-file', '--batch'], { input: specs.join('\n') + '\n', maxBuffer: 1024 * 1024 * 1024, timeout: 120000 });
  if (r.status !== 0) throw new Error('git cat-file --batch failed');
  const buf = r.stdout;
  let pos = 0;
  for (const spec of specs) {
    const nl = buf.indexOf(10, pos);
    if (nl < 0) throw new Error('cat-file: truncated output');
    const header = buf.slice(pos, nl).toString('utf8');
    pos = nl + 1;
    if (header.endsWith(' missing')) { out.set(spec, null); continue; }
    const size = Number(header.split(' ')[2]);
    if (!Number.isFinite(size)) throw new Error(`cat-file: bad header ${header}`);
    out.set(spec, buf.slice(pos, pos + size).toString('utf8'));
    pos += size + 1;
  }
  return out;
}

/** Classify base..head in the current repo. Never throws: errors fail open. */
function classifyRange(base, head, { codePaths = [] } = {}) {
  try {
    const files = gitOut(['diff', '--name-only', '--no-renames', base, head]).split('\n').filter(Boolean);
    // Status + NYT picks always read (small), so the show-file cap below never hides them.
    const status = catFileBatch([STATUS_FILE, NYT_PICKS].flatMap((f) => [`${base}:${f}`, `${head}:${f}`]));
    const idsBase = openingIdsFrom(status.get(`${base}:${STATUS_FILE}`));
    const idsHead = openingIdsFrom(status.get(`${head}:${STATUS_FILE}`));
    // Either side unreadable -> unknown window -> every show counts (fail open).
    const openingIds = idsBase && idsHead ? [...idsBase, ...idsHead] : null;
    const opening = openingIds ? new Set(openingIds) : null;
    const wanted = files.filter((f) => f.startsWith(SHOW_DIR) && f.endsWith('.json') && (!opening || opening.has(showIdOf(f))));
    let blobs = status;
    if (wanted.length && wanted.length <= MAX_SHOW_FILES) {
      blobs = new Map([...status, ...catFileBatch(wanted.flatMap((f) => [`${base}:${f}`, `${head}:${f}`]))]);
    }
    const read = (f) => ({ before: blobs.get(`${base}:${f}`) ?? null, after: blobs.get(`${head}:${f}`) ?? null });
    return { ...classifyReveal(files, read, { codePaths, openingIds }), changed: files.length };
  } catch (e) {
    return { reveal: true, reason: `classify-error: ${String(e.message || e).slice(0, 120)}`, file: null, changed: null };
  }
}

module.exports = { reviewProjection, classifyReveal, openingIdsFrom, nytPicksChanged, resolveUrgency, classifyRange, catFileBatch, MAX_SHOW_FILES, REVEAL_DATA_FILES };

// CLI: `node scripts/lib/deploy-reveal.js <base> <head>` prints reveal=true|false
// and reason=..., one per line (GITHUB_OUTPUT-ready). Used by the opening-night
// poller to classify its own commit. Always exits 0; errors print reveal=true.
if (require.main === module) {
  const [base, head] = process.argv.slice(2);
  let r;
  if (!base || !head) r = { reveal: true, reason: 'usage: <base> <head>', file: null };
  else r = classifyRange(base, head, { codePaths: require('./should-deploy-gate.js').CODE_PATHS });
  const reason = `${r.reason}${r.file ? ' ' + r.file : ''}`.replace(/[\r\n]/g, ' ');
  process.stdout.write(`reveal=${r.reveal}\nreason=${reason}\n`);
}
