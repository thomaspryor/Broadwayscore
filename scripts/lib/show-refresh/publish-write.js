'use strict';
/**
 * BRO-8214 (BRO-8056 v14-final §1.5 step 6-8, phase 3a): the publisher's
 * write step. Takes a plan from planPublish and the HEAD slices, and:
 *   1. re-reads kill and home with the service client (authoritative, uncached);
 *      killed -> stop before any write. home unreadable or malformed -> stop.
 *   2. uploads each target slice to show/<id>/<hash>.json unless the same bytes
 *      are already there (objects are content-addressed and immutable, so a
 *      re-run uploads nothing). A different body under the same hash is a hard
 *      error. Held shows are never uploaded.
 *   3. writes home only when {manifestId, shows, pending} differs from the
 *      stored home (re-runs with nothing new change nothing), as a
 *      compare-and-swap on home.generation. 0 rows = another writer won
 *      (cas-lost): nothing is overwritten. kill is re-checked right before it.
 *
 * Every step before the CAS leaves the old pointer in place when it throws:
 * the reader only follows home, and orphan objects are harmless. An error after
 * a CAS that matched has err.pointerSwapped = true (the new pointer is live).
 */
const store = require('./store');
const { OUTCOMES } = require('./publish-plan');

const HOME_SCHEMA = 1;
const WRITE_OUTCOMES = Object.freeze({
  PUBLISHED: 'published',
  UNCHANGED: 'home-unchanged',
});

function homeCore(h) {
  return { manifestId: h.manifestId ?? null, shows: h.shows || {}, pending: h.pending || {} };
}

/** True when the stored home already says what nextHome says. */
function homeMatches(prev, next) {
  return store.canonical(homeCore(prev)) === store.canonical(homeCore(next));
}

async function readKillState(state) {
  const r = await store.readJsonObject(state, store.PATHS.kill);
  return store.effectiveKill(r);
}

/**
 * Read home for writing. Seeds the placeholder row when absent (insert-only,
 * never overwrites). Returns { value } or throws.
 */
async function readHomeForWrite(state) {
  let r = await store.readJsonObject(state, store.PATHS.home);
  if (r.state === 'missing') {
    await state.insertIfAbsent(store.PATHS.home, JSON.stringify(store.HOME_PLACEHOLDER));
    r = await store.readJsonObject(state, store.PATHS.home);
  }
  if (r.state !== 'ok') throw new Error(`home unreadable (${r.state}${r.error ? `: ${r.error}` : ''})`);
  const v = r.value;
  if (!v || typeof v !== 'object' || !Number.isInteger(v.generation) || v.generation < 0) {
    throw new Error('home malformed: no integer generation');
  }
  return v;
}

/**
 * @param {object} o
 * @param {object} o.storage  writer Storage client (get/put)
 * @param {object} o.state    writer state-table client (get/insertIfAbsent/putIfField)
 * @param {object} o.plan     planPublish result
 * @param {object} o.manifest the build manifest (shows[id].held is re-checked)
 * @param {(id: string) => {slice: object, hash: string, held: boolean} | undefined} o.sliceFor
 * @param {number|null} [o.expectGeneration] home.generation the plan was made from
 *   (null = home was absent). A different generation now means another run
 *   wrote since planning: stop as cas-lost before any upload.
 * @param {number} o.now
 * @returns {Promise<{outcome: string, uploaded: string[], existing: string[], homeWritten: boolean, generation: number|null, changedIds: string[], log: string[]}>}
 */
async function writePublish({ storage, state, plan, manifest, sliceFor, expectGeneration, now = Date.now() }) {
  const log = [];
  const result = (outcome, extra = {}) => ({ outcome, uploaded: [], existing: [], homeWritten: false, generation: null, changedIds: [], log, ...extra });
  if (!plan || !plan.nextHome) return result(plan ? plan.outcome : OUTCOMES.MANIFEST_UNUSABLE);

  const kill = await readKillState(state);
  if (kill.killed) { log.push(`killed before writes: ${kill.reason || ''}`); return result(OUTCOMES.KILLED); }

  const prev = await readHomeForWrite(state);
  if (expectGeneration !== undefined && prev.generation !== (expectGeneration ?? store.HOME_PLACEHOLDER.generation)) {
    log.push(`home moved since planning (generation ${expectGeneration} -> ${prev.generation}): not writing`);
    return result(OUTCOMES.CAS_LOST);
  }

  // Uploads: every target whose object is not already stored byte-for-byte.
  const uploaded = [];
  const existing = [];
  for (const t of plan.targets) {
    const s = sliceFor(t.id);
    if (!s || !s.slice) throw new Error(`no HEAD slice for target ${t.id}`);
    if (s.held || (manifest.shows[t.id] && manifest.shows[t.id].held)) throw new Error(`refusing to upload held show ${t.id}`);
    if (s.hash !== t.hash) throw new Error(`slice hash for ${t.id} moved since planning`);
    const text = JSON.stringify(s.slice);
    const objPath = store.showObjectPath(t.id, t.hash);
    const cur = await storage.get(objPath, { cacheBust: now });
    if (cur.status === 200) {
      if (cur.text !== text) throw new Error(`stored ${objPath} differs from HEAD slice with the same hash`);
      existing.push(t.id);
      continue;
    }
    if (!store.isObjectMissing(cur)) throw new Error(`cannot check ${objPath}: status ${cur.status}`);
    await store.putShowObject(storage, t.id, t.hash, text);
    uploaded.push(t.id);
  }

  const next = {
    schema: HOME_SCHEMA,
    manifestId: plan.nextHome.manifestId,
    coreSha: manifest.coreSha ?? null,
    generation: prev.generation + 1,
    publishedAt: new Date(now).toISOString(),
    shows: plan.nextHome.shows,
    pending: plan.nextHome.pending,
    // Preserve complete rollback pointers atomically with the new home.
    // Strip nested history so the row remains bounded.
    previousGenerations: [
      (({ previousGenerations, ...home }) => home)(prev),
      ...(Array.isArray(prev.previousGenerations) ? prev.previousGenerations : []),
    ].slice(0, 2),
  };
  const prevShows = prev.manifestId === next.manifestId ? prev.shows || {} : {};
  const changedIds = Object.keys({ ...prevShows, ...next.shows })
    .filter((id) => (prevShows[id] && prevShows[id].hash) !== (next.shows[id] && next.shows[id].hash)).sort();

  if (homeMatches(prev, next)) {
    log.push(`home unchanged at generation ${prev.generation}`);
    return result(WRITE_OUTCOMES.UNCHANGED, { uploaded, existing, generation: prev.generation });
  }

  // Narrow the window: a kill flipped during the uploads still stops the swap.
  const kill2 = await readKillState(state);
  if (kill2.killed) { log.push('killed during uploads: home not written'); return result(OUTCOMES.KILLED, { uploaded, existing }); }

  const rows = await state.putIfField(store.PATHS.home, JSON.stringify(next), 'generation', prev.generation);
  if (rows === 0) {
    log.push(`home CAS lost at generation ${prev.generation}: another run wrote first`);
    return result(OUTCOMES.CAS_LOST, { uploaded, existing });
  }
  // The CAS matched a row, so this run's pointer was written. A read-back that
  // shows a LATER generation means another run swapped after us (not an error).
  // Errors from here on carry pointerSwapped: the old pointer is NOT in place.
  let back;
  try { back = await store.readJsonObject(state, store.PATHS.home); } catch (e) {
    throw Object.assign(new Error(`home swapped to generation ${next.generation} but read-back failed: ${e instanceof Error ? e.message : e}`), { pointerSwapped: true });
  }
  const backGen = back.state === 'ok' && back.value ? back.value.generation : null;
  if (Number.isInteger(backGen) && backGen > next.generation) {
    log.push(`home generation ${prev.generation} -> ${next.generation}; another run has since moved it to ${backGen}`);
  } else if (back.state !== 'ok' || backGen !== next.generation || !homeMatches(back.value, next)) {
    throw Object.assign(new Error(`home swapped to generation ${next.generation} but read-back does not match (${back.state}, generation ${backGen})`), { pointerSwapped: true });
  } else {
    log.push(`home generation ${prev.generation} -> ${next.generation}`);
  }
  return result(WRITE_OUTCOMES.PUBLISHED, { uploaded, existing, homeWritten: true, generation: next.generation, changedIds });
}

module.exports = { writePublish, homeMatches, readHomeForWrite, WRITE_OUTCOMES, HOME_SCHEMA };
