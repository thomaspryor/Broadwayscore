'use strict';

/**
 * Retired show-id registry (2026 data audit, Sprint 0 / S0-T2).
 *
 * A show id that has been deliberately deleted from shows.json must never
 * come back. Three paths could resurrect one, and each consults this
 * registry:
 *   - discovery (scripts/discover-new-shows.js) minting the same id again
 *     from the same listing — `matchesRetired()` at the top of its
 *     candidate loop (S0-T3);
 *   - push-core-data's post-rebase reconciliation re-adding a "remote-only"
 *     show when the base snapshot lacks it — `reconcileShowsJson(...,
 *     retiredIds)` in scripts/lib/reconcile-shows-fields.js (S0-T4);
 *   - validate-data.js warning when a retired id is present (S0-T5).
 *
 * Two files, BOTH core data (CLAUDE.md §11 — private repo, gitignored here,
 * resolved via data/ exactly like shows.json; synced by push-core-data's
 * CORE_FILES and restored by checkout-core-data's *.json copy):
 *   data/retired-show-ids.json     — JSON array of
 *                                    {id, reason, retiredAt, title, venue}
 *   data/deleted-shows.json — JSON array of the full archived rows
 *                                    (the shows.json entry as it was deleted)
 *
 * `title`/`venue` on a registry entry are recorded ONLY when the retirement
 * passes `blockTitleVenue: true` — for junk rows (panels, festivals, phantom
 * "?tab=dates" listings) that must never come back under ANY id: discovery
 * then refuses a re-discovered listing even when the minted id differs (a
 * different id-year, a re-slugged title). The default writes `title: null,
 * venue: null`, so `matchesRetired()` can only match that entry by id.
 * Duplicates and merges MUST be retired id-only: the kept row shares the
 * retired row's title+venue, so a title+venue block would refuse the kept
 * production's own listing on re-discovery and, years later, a same-title
 * revival at the same house. Entries without title/venue (older,
 * hand-written, or the default) match by id alone.
 *
 * Paths: the exported constants are the canonical repo locations. Tests (and
 * only tests) point the functions elsewhere via the RETIRED_IDS_PATH /
 * RETIRED_ARCHIVE_PATH environment variables or the per-call `paths`
 * options; production callers never pass them.
 */

const fs = require('fs');
const path = require('path');
const { foldDiacritics } = require('./title-match');

const REPO_ROOT = path.join(__dirname, '..', '..');
const RETIRED_IDS_PATH = path.join(REPO_ROOT, 'data', 'retired-show-ids.json');
const ARCHIVE_PATH = path.join(REPO_ROOT, 'data', 'deleted-shows.json');

function resolveListPath(opts) {
  return (opts && opts.listPath) || process.env.RETIRED_IDS_PATH || RETIRED_IDS_PATH;
}

function resolveArchivePath(opts) {
  return (opts && opts.archivePath) || process.env.RETIRED_ARCHIVE_PATH || ARCHIVE_PATH;
}

function readJsonArray(filePath, label) {
  if (!fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, 'utf8');
  if (raw.trim() === '') return [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`${label} is not valid JSON (${filePath}): ${e.message}`);
  }
  if (!Array.isArray(parsed)) {
    // A malformed registry must be loud: silently treating it as empty is
    // exactly how a retired id would slip back in.
    throw new Error(`${label} must be a JSON array (${filePath}), got ${parsed === null ? 'null' : typeof parsed}`);
  }
  return parsed;
}

// Where a write to `filePath` must land. rename() onto a symlink REPLACES
// the symlink with a regular file, orphaning the real target — and local
// checkouts have both registry files symlinked into the private core-data
// clone (scripts/setup-local-data.sh SYMLINK_FILES, like shows.json), so a
// write over the link would strand the retirement in a gitignored data/ copy
// that never reaches the core-data repo. Follow the link (even a dangling one:
// a clone that has not seeded the file yet) and write the target. Same fix as
// scripts/lib/atomic-shows-write.js.
function resolveWriteTarget(filePath) {
  try {
    return fs.realpathSync(filePath);
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  let link = null;
  try {
    if (fs.lstatSync(filePath).isSymbolicLink()) link = fs.readlinkSync(filePath);
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  if (link === null) return filePath;
  return resolveWriteTarget(path.resolve(path.dirname(filePath), link));
}

// Atomic write (tmp + rename) so a crash mid-write cannot leave a truncated
// registry that the next reader would then throw on (or, worse, read as []).
function writeJsonArray(filePath, arr) {
  const target = resolveWriteTarget(filePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(arr, null, 2) + '\n');
  fs.renameSync(tmp, target);
}

/**
 * Read the registry from disk (always fresh — no cache).
 * @returns {Array<{id: string, reason: string, retiredAt: string, title?: string, venue?: string}>}
 *   [] when the file does not exist yet.
 */
function loadRetiredIds(opts) {
  const entries = readJsonArray(resolveListPath(opts), 'retired-show-ids registry');
  return entries.filter((e) => e && typeof e.id === 'string' && e.id.length > 0);
}

// Cache keyed by resolved path so a test pointing at a temp file never sees
// (or poisons) the real registry's cache.
const cache = new Map();

function cachedEntries(opts) {
  const listPath = resolveListPath(opts);
  if (!cache.has(listPath)) cache.set(listPath, loadRetiredIds({ listPath }));
  return cache.get(listPath);
}

function _resetCache() {
  cache.clear();
}

/**
 * @param {string} id
 * @returns {boolean} true when `id` is in the registry (cached load).
 */
function isRetiredId(id, opts) {
  if (typeof id !== 'string' || !id) return false;
  return cachedEntries(opts).some((e) => e.id === id);
}

// Comparison key for title/venue matching: fold diacritics, lowercase,
// "&" -> "and", drop everything but [a-z0-9], collapse whitespace. Same
// folding deduplication.js's slugify() applies when minting the id, so the
// title a retired listing would mint from and the archived title compare
// equal regardless of casing/punctuation drift between source scrapes.
function normalizeKey(value) {
  if (value === null || value === undefined) return '';
  return foldDiacritics(String(value))
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Discovery predicate (S0-T3): does this candidate match a retired entry?
 * Matches on the id the candidate would mint, OR on exact normalized
 * title+venue equality with a retired entry that recorded both (only a
 * `blockTitleVenue: true` retirement does). Empty title/venue on either side
 * never matches (the default retirement, and a legacy entry without them,
 * is id-only).
 *
 * @param {{id?: string, title?: string, venue?: string}} candidate
 * @param {Array<{id: string, title?: string, venue?: string}>} [entries]
 *   in-memory registry entries (tests); defaults to the cached on-disk list.
 * @returns {null | {id: string, matchedBy: 'id' | 'title+venue'}} the
 *   retired entry hit, or null when the candidate is clear.
 */
function matchesRetired(candidate, entries) {
  if (!candidate) return null;
  const list = Array.isArray(entries) ? entries : cachedEntries();
  if (list.length === 0) return null;

  const candidateId = typeof candidate.id === 'string' ? candidate.id : '';
  const candidateTitle = normalizeKey(candidate.title);
  const candidateVenue = normalizeKey(candidate.venue);

  for (const entry of list) {
    if (!entry || typeof entry.id !== 'string' || !entry.id) continue;
    if (candidateId && entry.id === candidateId) {
      return { id: entry.id, matchedBy: 'id' };
    }
    if (!candidateTitle || !candidateVenue) continue;
    const entryTitle = normalizeKey(entry.title);
    const entryVenue = normalizeKey(entry.venue);
    if (entryTitle && entryVenue && entryTitle === candidateTitle && entryVenue === candidateVenue) {
      return { id: entry.id, matchedBy: 'title+venue' };
    }
  }
  return null;
}

/**
 * Retire an id: append `{id, reason, retiredAt, title, venue}` to the
 * registry and the full `archivedRow` to the archive. Creates both files if
 * absent. Refuses (throws) when the id is already retired — a second
 * retirement means two sessions deleted the same row, which is worth
 * stopping on, not papering over.
 *
 * `title`/`venue` are copied from the row ONLY with `blockTitleVenue: true`
 * (a junk row that must never return under any id — the row must then carry
 * both, or the block could never fire and the call throws). The default
 * writes nulls, so the entry matches by id alone: the only safe form for a
 * duplicate/merge, whose kept row shares the title+venue (module docstring).
 *
 * @param {string} id
 * @param {{reason: string, archivedRow: object, blockTitleVenue?: boolean,
 *          now?: Date|string, listPath?: string, archivePath?: string}} options
 * @returns {{entry: object, listPath: string, archivePath: string}}
 */
function retireId(id, options) {
  const opts = options || {};
  if (typeof id !== 'string' || !id.trim()) {
    throw new Error('retireId: id must be a non-empty string');
  }
  if (typeof opts.reason !== 'string' || !opts.reason.trim()) {
    throw new Error(`retireId(${id}): a non-empty reason is required (audit breadcrumb)`);
  }
  if (!opts.archivedRow || typeof opts.archivedRow !== 'object' || Array.isArray(opts.archivedRow)) {
    throw new Error(`retireId(${id}): archivedRow must be the deleted shows.json row (object)`);
  }
  if (opts.blockTitleVenue !== undefined && typeof opts.blockTitleVenue !== 'boolean') {
    throw new Error(`retireId(${id}): blockTitleVenue must be a boolean when given, got ${typeof opts.blockTitleVenue}`);
  }
  const blockTitleVenue = opts.blockTitleVenue === true;
  const rowTitle = typeof opts.archivedRow.title === 'string' && opts.archivedRow.title.trim() ? opts.archivedRow.title : null;
  const rowVenue = typeof opts.archivedRow.venue === 'string' && opts.archivedRow.venue.trim() ? opts.archivedRow.venue : null;
  if (blockTitleVenue && (rowTitle === null || rowVenue === null)) {
    throw new Error(`retireId(${id}): blockTitleVenue needs both title and venue on the archived row (matchesRetired only ever matches on the pair) — retire id-only instead`);
  }

  const listPath = resolveListPath(opts);
  const archivePath = resolveArchivePath(opts);

  const entries = loadRetiredIds({ listPath });
  if (entries.some((e) => e.id === id)) {
    throw new Error(`retireId(${id}): already retired — refusing to retire twice`);
  }

  const now = opts.now instanceof Date ? opts.now : (opts.now ? new Date(opts.now) : new Date());
  if (isNaN(now.getTime())) {
    throw new Error(`retireId(${id}): invalid now value ${JSON.stringify(opts.now)}`);
  }

  const row = opts.archivedRow;
  // venue-write-guard-ok: the registry copies title/venue VERBATIM from an already
  // written shows.json row (which passed sanitizeVenueForWrite when it was saved) so
  // that matchesRetired can compare the same normalized pair later; this file never
  // writes a venue into shows.json.
  const entry = {
    id,
    reason: opts.reason.trim(),
    retiredAt: now.toISOString(),
    title: blockTitleVenue ? rowTitle : null,
    venue: blockTitleVenue ? rowVenue : null,
  };

  const archive = readJsonArray(archivePath, 'deleted-shows archive');
  archive.push(row);
  entries.push(entry);

  // Archive first: if the registry write fails after the archive write, the
  // worst case is a duplicate archive row on retry (harmless); the reverse
  // order could leave a retired id with no archived row.
  writeJsonArray(archivePath, archive);
  writeJsonArray(listPath, entries);
  cache.set(listPath, entries);

  return { entry, listPath, archivePath };
}

/**
 * Undo a retireId() whose shows.json removal then failed to save (the
 * retire-show plan action, BRO-4398): drop `id` from the registry and the
 * archive. Only for that rollback; a real un-retirement is a human call.
 * @returns {boolean} whether an entry was removed
 */
function unretireId(id, opts = {}) {
  const listPath = resolveListPath(opts);
  const archivePath = resolveArchivePath(opts);
  let removed = false;
  for (const p of [listPath, archivePath]) {
    let arr;
    try { arr = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { continue; }
    if (!Array.isArray(arr)) continue;
    const next = arr.filter(e => !(e && e.id === id));
    if (next.length === arr.length) continue;
    writeJsonArray(p, next); // symlink-safe, like retireId's own writes
    removed = true;
  }
  _resetCache();
  return removed;
}

module.exports = {
  RETIRED_IDS_PATH,
  ARCHIVE_PATH,
  loadRetiredIds,
  isRetiredId,
  retireId,
  unretireId,
  matchesRetired,
  _resetCache,
};
