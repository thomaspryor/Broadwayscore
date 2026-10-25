/**
 * validate-data.js's retired-id check (Sprint 0 / S0-T5), extracted so the
 * unit test exercises the real decision function with an injected registry
 * (CLAUDE.md §15 — never copy logic into a test).
 *
 * Contract this codes against — scripts/lib/retired-show-ids.js (S0-T2):
 *   module.exports = { RETIRED_IDS_PATH, loadRetiredIds, isRetiredId, retireId }
 *   loadRetiredIds() -> Array<{ id, reason, retiredAt }>; a missing file is [].
 *
 * The require is lazy and a MISSING MODULE is treated exactly like a missing
 * file — an empty registry — so this check never depends on that module
 * landing first (or on it staying). Anything else that goes wrong while
 * loading (the module's own dependency missing, a corrupt registry, a
 * non-array return) is surfaced as `error` for the caller to warn about,
 * still with an empty list: the registry being unreadable must be loud, but
 * it must not turn validate-data.js red on its own.
 */

'use strict';

const RETIRED_IDS_MODULE = './retired-show-ids';

/**
 * True only when `err` is Node's "cannot find module" for the registry module
 * ITSELF. Judged off the message's first line, not the whole message: for a
 * present module whose own dependency is missing, the require stack in the
 * later lines names retired-show-ids.js too, and that case must NOT read as
 * "registry absent".
 */
function isRegistryModuleMissing(err) {
  if (!err || err.code !== 'MODULE_NOT_FOUND' || typeof err.message !== 'string') return false;
  return err.message.split('\n')[0].includes(`'${RETIRED_IDS_MODULE}'`);
}

/** Coerce whatever the registry returned into [{ id, reason, retiredAt }], dropping junk. */
function normalizeRetiredList(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const entry of list) {
    if (typeof entry === 'string' && entry) {
      out.push({ id: entry, reason: null, retiredAt: null });
    } else if (entry && typeof entry === 'object' && typeof entry.id === 'string' && entry.id) {
      out.push({
        id: entry.id,
        reason: typeof entry.reason === 'string' && entry.reason ? entry.reason : null,
        retiredAt: entry.retiredAt == null ? null : entry.retiredAt,
      });
    }
  }
  return out;
}

/**
 * Load the retired-id registry without ever throwing.
 *
 * @param {object} [opts]
 * @param {(id: string) => any} [opts.requireFn=require] - Injected by tests
 *   to simulate the module being absent, broken, or present.
 * @returns {{ retired: Array<{id, reason, retiredAt}>, error: string|null, source: string }}
 *   `source` is one of 'registry' | 'module-absent' | 'module-error' | 'registry-error'.
 */
function loadRetiredIdsSafe({ requireFn = require } = {}) {
  let mod;
  try {
    mod = requireFn(RETIRED_IDS_MODULE);
  } catch (err) {
    if (isRegistryModuleMissing(err)) return { retired: [], error: null, source: 'module-absent' };
    return { retired: [], error: `require('${RETIRED_IDS_MODULE}') failed: ${err && err.message}`, source: 'module-error' };
  }
  if (!mod || typeof mod.loadRetiredIds !== 'function') {
    return { retired: [], error: `${RETIRED_IDS_MODULE} exports no loadRetiredIds()`, source: 'module-error' };
  }
  let list;
  try {
    list = mod.loadRetiredIds();
  } catch (err) {
    return { retired: [], error: `loadRetiredIds() threw: ${err && err.message}`, source: 'registry-error' };
  }
  if (!Array.isArray(list)) {
    return { retired: [], error: `loadRetiredIds() returned ${list === null ? 'null' : typeof list}, not an array`, source: 'registry-error' };
  }
  return { retired: normalizeRetiredList(list), error: null, source: 'registry' };
}

/**
 * Pure decision: which shows carry a retired id.
 *
 * `_devOnly` rows are skipped, mirroring validateNoDuplicates — they
 * intentionally clone real ids for Express E2E testing and would otherwise
 * double-report a retired real show.
 *
 * @returns {Array<{ id: string, title: string|null, reason: string|null, retiredAt: any }>}
 *   One hit per matching show, in shows.json order.
 */
function findRetiredIdsInShows(shows, retired) {
  const byId = new Map();
  for (const entry of normalizeRetiredList(retired)) {
    if (!byId.has(entry.id)) byId.set(entry.id, entry);
  }
  const hits = [];
  if (byId.size === 0) return hits;
  for (const show of Array.isArray(shows) ? shows : []) {
    if (!show || show._devOnly || typeof show.id !== 'string') continue;
    const entry = byId.get(show.id);
    if (!entry) continue;
    hits.push({ id: show.id, title: show.title == null ? null : show.title, reason: entry.reason, retiredAt: entry.retiredAt });
  }
  return hits;
}

/** The operator-facing WARN text — the contract CI logs and the digest grep for. */
function formatRetiredIdWarning(hit) {
  return `Retired id present: ${hit.id} (${hit.reason || 'no reason recorded'})`;
}

/**
 * Run the check and report through the caller's warn/ok sinks. One WARN line
 * per retired id present; an ok line when none. Never an error.
 *
 * @returns the hits, for callers that want them.
 */
function checkRetiredIds(shows, retired, { warn, ok } = {}) {
  const hits = findRetiredIdsInShows(shows, retired);
  for (const hit of hits) {
    if (warn) warn(formatRetiredIdWarning(hit));
  }
  if (hits.length === 0 && ok) {
    ok(`No retired ids present in shows.json (registry: ${normalizeRetiredList(retired).length} retired id(s))`);
  }
  return hits;
}

module.exports = {
  RETIRED_IDS_MODULE,
  isRegistryModuleMissing,
  normalizeRetiredList,
  loadRetiredIdsSafe,
  findRetiredIdsInShows,
  formatRetiredIdWarning,
  checkRetiredIds,
};
