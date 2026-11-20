'use strict';
// BRO-7803: the publish procedure with all I/O injected, so the real function
// runs in node --test and in the simulated opening night against a local server.
//
//   plan  = [{ showId, view, reviews }]         (already computed by the caller)
//   Order: upload payloads -> read each back and compare -> write pointer LAST.
//   A failed upload or verify never advances the pointer for that show.

const { buildPayload, payloadPath, shouldPublish, mergePointer } = require('./core');

async function readJson(storage, path, cacheBust) {
  const r = await storage.get(path, { cacheBust });
  if (r.status !== 200) return null;
  try { return JSON.parse(r.text); } catch { return null; }
}

async function publish({ storage, plan, rev, flagged = new Set(), safe = true, allowDecrease = false, live = {}, now = Date.now(), dryRun = false, log = () => {} }) {
  const prev = await readJson(storage, 'p.json', now);
  const prevShows = (prev && prev.shows) || {};
  const updates = {};
  const results = [];

  for (const item of plan) {
    const built = buildPayload({ showId: item.showId, view: item.view, reviews: item.reviews, rev });
    const prevEntry = prevShows[item.showId];
    const decision = shouldPublish({
      prevEntry, prevReviewCount: prevEntry && prevEntry.rc,
      next: { c: built.c, view: item.view },
      flagged: flagged.has(item.showId), safe, allowDecrease,
    });
    if (!decision.publish) { results.push({ showId: item.showId, status: 'skipped', reason: decision.reason }); continue; }
    if (dryRun) { results.push({ showId: item.showId, status: 'dry-run', v: built.v }); continue; }
    try {
      const path = payloadPath(item.showId, built.v);
      await storage.put(path, built.text, { cacheSeconds: 31536000 });
      const back = await storage.get(path);
      if (back.status !== 200 || back.text !== built.text) throw new Error(`verify mismatch for ${path} (status ${back.status})`);
      updates[item.showId] = { v: built.v, c: built.c, rev, n: built.n, rc: item.view.reviewCount };
      results.push({ showId: item.showId, status: 'uploaded', v: built.v, n: built.n });
    } catch (e) {
      results.push({ showId: item.showId, status: 'failed', reason: String(e.message || e) });
    }
  }

  let pointerWritten = false;
  if (Object.keys(updates).length) {
    // Single-writer discipline without a lock: re-read right before writing and
    // merge onto whatever is there now (max-rev merge is commutative), so two
    // overlapping publishers cannot drop each other's entries.
    const latest = (await readJson(storage, 'p.json', now + 2)) || prev;
    const next = mergePointer({ prev: latest, updates, now, live });
    await storage.put('p.json', JSON.stringify(next), { cacheSeconds: 20 });
    const back = await readJson(storage, 'p.json', now + 1);
    if (!back || back.seq !== next.seq) throw new Error('pointer verify failed');
    pointerWritten = true;
  }
  log(`published ${results.filter((r) => r.status === 'uploaded').length}/${plan.length}`);
  return { results, pointerWritten };
}

/** Takedown: tombstone a show (rev bumped, view marked TBD, no reviews) and delete old payloads. */
async function purge({ storage, showId, rev, now = Date.now() }) {
  const prev = await readJson(storage, 'p.json', now);
  const old = prev && prev.shows && prev.shows[showId];
  const built = buildPayload({
    showId, rev, tombstone: true,
    view: { score: null, reviewCount: 0, tier1Count: 0, tier2Count: 0, showTBD: true, reviewsRemaining: 0, noReviewsExpected: false, criticsTakeMode: 'none', reviewArrival: null },
    reviews: [],
  });
  const path = payloadPath(showId, built.v);
  await storage.put(path, built.text, { cacheSeconds: 31536000 });
  const next = mergePointer({ prev, updates: { [showId]: { v: built.v, c: built.c, rev, n: built.n, rc: 0, t: 1 } }, now });
  await storage.put('p.json', JSON.stringify(next), { cacheSeconds: 20 });
  if (old && old.v && old.v !== built.v) await storage.remove(payloadPath(showId, old.v));
  return { purged: showId, v: built.v };
}

module.exports = { publish, purge, readJson };
