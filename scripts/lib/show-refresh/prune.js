'use strict';
/**
 * BRO-8397 (parent BRO-8056): prune old show-refresh slices.
 *
 * Slices are immutable objects show/<id>/<hash>.json, uploaded by the publisher
 * and never deleted, so the bucket only grows. This deletes the ones that no
 * home generation the store still remembers points to: the current home plus
 * up to keepGenerations of home.previousGenerations (publish-write keeps the
 * last 2 there for rollback), including their pending.expect hashes.
 *
 * Safety:
 *   - DRY-RUN by default (lists what it would delete, deletes nothing). The CLI
 *     deletes only with SHOW_REFRESH_PRUNE_DELETE=true.
 *   - kill switch on (or kill row unreadable) => nothing is deleted.
 *   - home unreadable or malformed => nothing is deleted.
 *   - objects younger than minAgeMs are kept: a publisher may have uploaded a
 *     slice and not yet swapped the pointer to it.
 *   - names it does not recognise, and objects with no created time, are kept.
 *   - home is re-read right before deleting; if it moved, nothing is deleted.
 *   - at most maxDeletes per run.
 *   - runs at most once per minIntervalMs (prune-last-run.json in the private bucket).
 * Residual race: a publisher that reuses an old stored slice (same hash) between
 * the re-read and the delete points home at a missing object. The reader then
 * renders the build's data for that show (base-error), and the next publish run
 * (every 10 min) re-uploads it, since writePublish re-checks every target.
 *
 *   node scripts/lib/show-refresh/prune.js [--force]   (dry-run unless SHOW_REFRESH_PRUNE_DELETE=true)
 */
const store = require('./store');

const DEFAULT_KEEP_GENERATIONS = 2;
const DEFAULT_MIN_AGE_MS = 48 * 3600 * 1000;
const DEFAULT_MIN_INTERVAL_MS = 20 * 3600 * 1000;
const DEFAULT_MAX_DELETES = 500;
const DELETE_CHUNK = 100;
const PAGE = 1000;
const MAX_FOLDERS = 5000;

/** Pure: slice paths the current home and its last keepGenerations predecessors point to. */
function referencedSlicePaths(home, keepGenerations = DEFAULT_KEEP_GENERATIONS) {
  const out = new Set();
  if (!home || typeof home !== 'object') return out;
  const prev = Array.isArray(home.previousGenerations) ? home.previousGenerations : [];
  const keepN = Math.max(0, Math.floor(Number(keepGenerations) || 0));
  for (const g of [home, ...prev.slice(0, keepN)]) {
    if (!g || typeof g !== 'object') continue;
    const add = (id, hash) => {
      if (store.ID_RE.test(String(id)) && store.HASH_RE.test(String(hash))) out.add(store.showObjectPath(id, hash));
    };
    for (const [id, e] of Object.entries(g.shows || {})) add(id, e && e.hash);
    for (const [id, p] of Object.entries(g.pending || {})) add(id, p && p.expect);
  }
  return out;
}

/** Pure: a home the prune may trust (an object with an integer generation). */
function usableHome(read) {
  return read && read.state === 'ok' && read.value && typeof read.value === 'object'
    && Number.isInteger(read.value.generation) && read.value.generation >= 0
    && read.value.shows && typeof read.value.shows === 'object' && !Array.isArray(read.value.shows);
}

/**
 * Pure: split stored objects into keep / delete.
 * @param {{objects: Array<{path: string, createdAt: number|null}>, referenced: Set<string>, now: number, minAgeMs?: number, maxDeletes?: number}} o
 */
function planPrune({ objects, referenced, now, minAgeMs = DEFAULT_MIN_AGE_MS, maxDeletes = DEFAULT_MAX_DELETES }) {
  const out = { referenced: [], young: [], unknown: [], toDelete: [], overCap: [] };
  for (const o of objects) {
    if (!store.SLICE_PATH_RE.test(o.path)) { out.unknown.push(o.path); continue; }
    if (referenced.has(o.path)) { out.referenced.push(o.path); continue; }
    if (!Number.isFinite(o.createdAt)) { out.unknown.push(o.path); continue; }
    if (now - o.createdAt < minAgeMs) { out.young.push(o.path); continue; }
    (out.toDelete.length < maxDeletes ? out.toDelete : out.overCap).push(o.path);
  }
  return out;
}

/** Pure: is the daily prune due? Unreadable stamp => not due (never on doubt). */
function pruneDue(lastRunRead, now, minIntervalMs = DEFAULT_MIN_INTERVAL_MS) {
  if (!lastRunRead || lastRunRead.state === 'missing') return { due: true, why: 'never run' };
  if (lastRunRead.state !== 'ok') return { due: false, why: `last-run unreadable (${lastRunRead.error || lastRunRead.state})` };
  const at = Date.parse(lastRunRead.value && lastRunRead.value.at);
  if (!Number.isFinite(at)) return { due: true, why: 'last-run has no time' };
  if (now - at < minIntervalMs) return { due: false, why: `ran ${Math.round((now - at) / 60000)} min ago` };
  return { due: true, why: 'interval passed' };
}

/** Every object under show/ as { path, createdAt }. Throws on any listing error. */
async function listSlices(storage, { maxFolders = MAX_FOLDERS } = {}) {
  const pageAll = async (prefix) => {
    const rows = [];
    for (let offset = 0; ; offset += PAGE) {
      const page = await storage.list(prefix, { limit: PAGE, offset });
      rows.push(...page);
      if (page.length < PAGE) return rows;
    }
  };
  const folders = (await pageAll('show')).filter((e) => e && e.id == null && e.name);
  if (folders.length > maxFolders) throw new Error(`${folders.length} show folders exceeds ${maxFolders}`);
  const objects = [];
  for (const f of folders) {
    for (const e of await pageAll(`show/${f.name}`)) {
      if (!e || e.id == null || !e.name) continue;
      objects.push({ path: `show/${f.name}/${e.name}`, createdAt: Math.max(Date.parse(e.created_at) || 0, Date.parse(e.updated_at) || 0) || NaN });
    }
  }
  return objects;
}

/**
 * List, plan and (unless dryRun) delete. Never deletes on doubt.
 * @returns {Promise<{ran: boolean, why: string, dryRun: boolean, deleted: string[], plan?: object, generation?: number}>}
 */
async function pruneSlices({
  storage, state, now = Date.now(), dryRun = true, force = false,
  keepGenerations = DEFAULT_KEEP_GENERATIONS, minAgeMs = DEFAULT_MIN_AGE_MS,
  minIntervalMs = DEFAULT_MIN_INTERVAL_MS, maxDeletes = DEFAULT_MAX_DELETES,
}) {
  const base = { dryRun, deleted: [] };
  if (!force) {
    const due = pruneDue(await store.readJsonObject(storage, store.PATHS.pruneLastRun), now, minIntervalMs);
    if (!due.due) return { ...base, ran: false, why: `not due: ${due.why}` };
  }
  // The kill row stops every store write, this delete included (fails closed:
  // a missing or unreadable kill row counts as killed, store.effectiveKill).
  const kill = store.effectiveKill(await store.readJsonObject(state, store.PATHS.kill));
  if (kill.killed) return { ...base, ran: false, why: `kill switch on (${kill.reason})` };
  const home = await store.readJsonObject(state, store.PATHS.home);
  if (!usableHome(home)) return { ...base, ran: false, why: `home not usable (${home.state}${home.error ? `: ${home.error}` : ''})` };
  const objects = await listSlices(storage);
  const plan = planPrune({ objects, referenced: referencedSlicePaths(home.value, keepGenerations), now, minAgeMs, maxDeletes });
  const deleted = [];
  let why = dryRun ? 'dry-run' : 'nothing to delete';
  if (!dryRun && plan.toDelete.length) {
    const again = await store.readJsonObject(state, store.PATHS.home);
    if (!usableHome(again) || again.value.generation !== home.value.generation || again.value.manifestId !== home.value.manifestId) {
      return { ...base, ran: true, why: 'home moved during the prune; nothing deleted', plan, generation: home.value.generation };
    }
    const stillRef = referencedSlicePaths(again.value, keepGenerations);
    const targets = plan.toDelete.filter((p) => !stillRef.has(p));
    for (let i = 0; i < targets.length; i += DELETE_CHUNK) {
      const chunk = targets.slice(i, i + DELETE_CHUNK);
      await storage.removeMany(chunk);
      deleted.push(...chunk);
    }
    why = `deleted ${deleted.length}`;
  }
  try {
    await store.putMutable(storage, store.PATHS.pruneLastRun, { schema: 1, at: new Date(now).toISOString(), dryRun, generation: home.value.generation, candidates: plan.toDelete.length, deleted: deleted.length });
  } catch (e) {
    why += `; last-run stamp not saved (${e instanceof Error ? e.message : e})`;
  }
  return { ...base, ran: true, why, deleted, plan, generation: home.value.generation };
}

async function main(argv = process.argv.slice(2), env = process.env) {
  const dryRun = env.SHOW_REFRESH_PRUNE_DELETE !== 'true';
  const force = argv.includes('--force');
  const r = await pruneSlices({ storage: store.storeFromEnv(env, { timeoutMs: 20000 }), state: store.stateFromEnv(env, { timeoutMs: 10000 }), dryRun, force });
  const p = r.plan;
  console.log(`[prune-show-refresh] ${dryRun ? 'dry-run' : 'delete'} ran=${r.ran} ${r.why}` +
    (p ? ` referenced=${p.referenced.length} young=${p.young.length} unknown=${p.unknown.length} candidates=${p.toDelete.length} overCap=${p.overCap.length} generation=${r.generation}` : ''));
  if (p && p.toDelete.length) console.log(`[prune-show-refresh] ${dryRun ? 'would delete' : 'candidates'} (first 50): ${p.toDelete.slice(0, 50).join(' ')}`);
  return 0;
}

module.exports = {
  DEFAULT_KEEP_GENERATIONS, DEFAULT_MIN_AGE_MS, DEFAULT_MIN_INTERVAL_MS, DEFAULT_MAX_DELETES,
  referencedSlicePaths, usableHome, planPrune, pruneDue, listSlices, pruneSlices, main,
};

if (require.main === module) {
  main().then((code) => { process.exitCode = code; }, (e) => {
    console.error(`::warning::[prune-show-refresh] failed: ${e instanceof Error ? e.message : e}`);
    process.exitCode = 1;
  });
}
