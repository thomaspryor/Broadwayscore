'use strict';
/**
 * BRO-8410: retry and drain failed show-refresh revalidations.
 *
 * After a publish moves the home pointer, the writer asks the site to
 * re-render the changed shows' pages. That call can fail (non-2xx, timeout).
 * With the reader on, a published slice would then sit unserved until the
 * page's ISR window. So a failed batch is queued in the private Storage object
 * revalidate-pending.json (service role only; no table migration) and the next
 * run (the 10-minute backstop) retries it alongside its own slugs.
 *
 * Caps: an entry is dropped, with a warning, after MAX_ATTEMPTS failed tries
 * or MAX_AGE_MS since its first failure (the ISR window then heals the page).
 * Never throws and never fails the run. No secret = skipped, queue untouched
 * (reader-off behaviour is unchanged).
 */
const store = require('./store');

const MAX_ATTEMPTS = 6;
const MAX_AGE_MS = 6 * 60 * 60 * 1000;
const MAX_ENTRIES = 500;

function emptyQueue() { return { schema: 1, entries: {} }; }

/** Tolerant parse of the stored object: bad shape = empty, bad entries dropped. */
function parseQueue(value) {
  const q = emptyQueue();
  const e = value && typeof value === 'object' && value.entries && typeof value.entries === 'object' ? value.entries : {};
  for (const [slug, v] of Object.entries(e)) {
    if (!v || typeof v !== 'object' || !Number.isFinite(v.firstFailedAt)) continue;
    q.entries[slug] = { firstFailedAt: v.firstFailedAt, attempts: Number.isInteger(v.attempts) && v.attempts > 0 ? v.attempts : 1, lastError: String(v.lastError || '').slice(0, 200) };
  }
  return q;
}

/** Split queued entries into ones still worth retrying and ones over a cap. */
function splitQueue(queue, now) {
  const retry = [];
  const expired = [];
  for (const [slug, v] of Object.entries(queue.entries)) {
    (v.attempts >= MAX_ATTEMPTS || now - v.firstFailedAt > MAX_AGE_MS ? expired : retry).push(slug);
  }
  return { retry, expired };
}

/**
 * Pure: the queue after a batch attempt. ok = every attempted slug is cleared;
 * otherwise each gets attempts+1 (new ones start at 1). Expired entries are
 * always dropped. Returns { queue, pending, abandoned }.
 */
function settle({ queue, attempted, ok, error = '', now }) {
  const { expired } = splitQueue(queue, now);
  const next = emptyQueue();
  for (const [slug, v] of Object.entries(queue.entries)) if (!expired.includes(slug)) next.entries[slug] = { ...v };
  for (const slug of attempted) {
    if (ok) { delete next.entries[slug]; continue; }
    const prev = next.entries[slug];
    next.entries[slug] = { firstFailedAt: prev ? prev.firstFailedAt : now, attempts: (prev ? prev.attempts : 0) + 1, lastError: String(error).slice(0, 200) };
  }
  // A failed final attempt that reaches the cap is abandoned now, not carried to the next run.
  const abandoned = [...expired];
  for (const [slug, v] of Object.entries(next.entries)) {
    if (v.attempts >= MAX_ATTEMPTS || now - v.firstFailedAt > MAX_AGE_MS) { abandoned.push(slug); delete next.entries[slug]; }
  }
  const keys = Object.keys(next.entries);
  if (keys.length > MAX_ENTRIES) for (const slug of keys.slice(MAX_ENTRIES)) { abandoned.push(slug); delete next.entries[slug]; }
  return { queue: next, pending: Object.keys(next.entries), abandoned };
}

/** One batch call to the site's revalidate route. Never throws. */
async function postRevalidate(env, slugs, fetchImpl = fetch) {
  const base = env.SHOW_REFRESH_SITE || 'https://broadwayscorecard.com';
  try {
    const res = await fetchImpl(new URL('/api/show-refresh/revalidate', base).toString(), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-show-refresh-secret': env.SHOW_REFRESH_REVALIDATE_SECRET },
      body: JSON.stringify({ slugs, home: true }),
      signal: AbortSignal.timeout(60000),
    });
    const msg = `HTTP ${res.status} for ${slugs.length} show(s)`;
    if (!res.ok) console.log(`::warning::show-refresh revalidate ${msg}`);
    return { ok: res.ok, msg };
  } catch (e) {
    const msg = `failed: ${e instanceof Error ? e.message : e}`;
    console.log(`::warning::show-refresh revalidate ${msg}`);
    return { ok: false, msg };
  }
}

/**
 * Revalidate this run's changed slugs plus anything queued from earlier runs,
 * then persist the queue. storage = the writer Storage client (null = no queue
 * store, behaves as before the queue existed). Returns { message, ... } for the report.
 */
async function revalidateWithQueue({ env, storage, newSlugs = [], now = Date.now(), fetchImpl = fetch }) {
  const out = { message: '', retried: [], pending: [], abandoned: [], queueNote: 'no queue store' };
  if (!(env.SHOW_REFRESH_REVALIDATE_SECRET || '')) { out.message = 'skipped (SHOW_REFRESH_REVALIDATE_SECRET unset)'; return out; }
  let queue = emptyQueue();
  let queueReadable = false;
  if (storage) {
    const r = await store.readJsonObject(storage, store.PATHS.revalidatePending);
    if (r.state === 'ok') { queue = parseQueue(r.value); queueReadable = true; out.queueNote = 'read'; }
    else if (r.state === 'missing') { queueReadable = true; out.queueNote = 'empty'; }
    else out.queueNote = `read failed (${r.error}); queue left untouched`;
  }
  const { retry } = splitQueue(queue, now);
  out.retried = retry.filter((s) => !newSlugs.includes(s));
  const slugs = [...new Set([...out.retried, ...newSlugs])];
  if (!slugs.length && !Object.keys(queue.entries).length) { out.message = 'skipped (no slugs)'; return out; }
  let res = { ok: true, msg: 'nothing to send' };
  if (slugs.length) res = await postRevalidate(env, slugs, fetchImpl);
  out.message = out.retried.length ? `${res.msg} (${out.retried.length} retried from queue)` : res.msg;
  const settled = settle({ queue, attempted: slugs, ok: res.ok, error: res.msg, now });
  out.pending = settled.pending;
  out.abandoned = settled.abandoned;
  if (settled.abandoned.length) console.log(`::warning::show-refresh revalidate gave up on ${settled.abandoned.length} show(s) after ${MAX_ATTEMPTS} tries or ${MAX_AGE_MS / 3600000}h (ISR will refresh them): ${settled.abandoned.slice(0, 20).join(', ')}`);
  if (settled.pending.length) console.log(`::warning::show-refresh revalidate queue has ${settled.pending.length} pending show(s): ${settled.pending.slice(0, 20).join(', ')}`);
  const changed = JSON.stringify(settled.queue) !== JSON.stringify(queue);
  if (storage && queueReadable && changed) {
    try { await store.putMutable(storage, store.PATHS.revalidatePending, settled.queue); out.queueNote += '; saved'; }
    catch (e) { out.queueNote += `; save failed: ${e instanceof Error ? e.message : e}`; console.log(`::warning::show-refresh revalidate queue not saved (${out.queueNote})`); }
  }
  return out;
}

module.exports = { MAX_ATTEMPTS, MAX_AGE_MS, emptyQueue, parseQueue, splitQueue, settle, postRevalidate, revalidateWithQueue };
