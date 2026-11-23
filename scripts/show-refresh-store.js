#!/usr/bin/env node
'use strict';
/**
 * BRO-8056: operate the show-refresh store (Storage bucket + state table).
 *
 *   --status                     bucket visibility, kill state, home generation
 *   --setup                      create the private bucket, seed the kill + home rows
 *   --kill --reason="..."        set kill killed:true (the reader renders the build)
 *   --unkill --reason="..."      set killed:false
 *   --selftest                   prove the reader's path on the real store (plan row 15):
 *                                a state-row overwrite is seen through the anon key,
 *                                anon reads kill/home and a fresh show/ slice, and anon
 *                                can neither read internal objects nor write or delete
 *                                anything. Gate before any reader is switched on.
 *
 * Needs SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL) and SUPABASE_SERVICE_ROLE_KEY;
 * --status and --selftest also need NEXT_PUBLIC_SUPABASE_ANON_KEY (reader view).
 * Exit 0 ok, 1 failure, 2 usage.
 */
require('./lib/cli-help').exitOnHelp(module);
const store = require('./lib/show-refresh/store');
const { putVerified } = require('./lib/live-score/storage');

// Slice probes live under show/_selftest/ (ID_RE never starts with '_', so no
// show id collides), one fresh name per run; the internal probe sits under
// flagged/, which anon must not read.
const SELFTEST_SLICE_DIR = 'show/_selftest';
const SELFTEST_INTERNAL_PATH = 'flagged/_selftest.json';
const SELFTEST_BUDGET_MS = 5000;

function parseArgs(argv) {
  const o = {};
  for (const a of argv) {
    const m = a.match(/^--([a-z-]+)(?:=([\s\S]*))?$/);
    if (!m) throw new Error(`unknown argument ${a}`);
    o[m[1]] = m[2] === undefined ? true : m[2];
  }
  return o;
}

/**
 * Healthy = bucket exists and is private, kill.json is a valid kill object
 * (boolean killed) and home.json a schema-1 object, as seen by BOTH the writer
 * (service key) and the reader (anon key). A readable but malformed file is
 * reported as state 'malformed', not 'ok'. A dropped RLS policy or rotated
 * anon key shows up as reader state 'missing' (the reader then renders the
 * build everywhere), so it fails --status instead of passing silently.
 */
function statusHealthy(st) {
  return st.bucket !== 'missing' && st.public === false && st.kill.state === 'ok' && st.home.state === 'ok'
    && (!st.reader || (st.reader.kill === 'ok' && st.reader.home === 'ok' && !st.reader.stale));
}

const validKill = (v) => Boolean(v) && typeof v === 'object' && typeof v.killed === 'boolean';
const validHome = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v) && v.schema === 1 && typeof v.shows === 'object' && v.shows !== null;
const shape = (read, valid) => (read.state === 'ok' && !valid(read.value) ? 'malformed' : read.state);

/** ctx = { storage, state } (writer) ; reader = { storage, state } (anon) or null. */
async function status(ctx, reader) {
  const meta = await ctx.storage.getBucket();
  const kill = await store.readJsonObject(ctx.state, store.PATHS.kill);
  const home = await store.readJsonObject(ctx.state, store.PATHS.home);
  const eff = store.effectiveKill(kill);
  const out = {
    bucket: meta ? ctx.storage.bucket : 'missing',
    public: meta ? meta.public : null,
    kill: { state: shape(kill, validKill), killed: eff.killed, reason: eff.reason, seq: kill.value && kill.value.seq, at: kill.value && kill.value.at },
    home: { state: shape(home, validHome), generation: home.value && home.value.generation, shows: home.value && home.value.shows ? Object.keys(home.value.shows).length : null },
  };
  if (reader) {
    const rk = await store.readJsonObject(reader.state, store.PATHS.kill);
    const rh = await store.readJsonObject(reader.state, store.PATHS.home);
    out.reader = { kill: shape(rk, validKill), home: shape(rh, validHome) };
    // The site reads with the anon key: it must see the same kill and home as the
    // writer, or a kill written here is not what visitors get.
    const stale = [];
    if (out.reader.kill === 'ok' && out.kill.state === 'ok'
      && (rk.value.killed !== kill.value.killed || rk.value.seq !== kill.value.seq)) stale.push(`kill (reader killed=${rk.value.killed} seq=${rk.value.seq})`);
    if (out.reader.home === 'ok' && out.home.state === 'ok' && rh.value.generation !== home.value.generation) stale.push(`home (reader generation=${rh.value.generation})`);
    if (stale.length) out.reader.stale = stale;
  }
  return out;
}

// Refused means the server said no (401/403) or changed 0 rows. A timeout, a
// 5xx or a network error proves nothing about permissions, so it is a failure.
const refused = async (fn) => {
  try { const n = await fn(); return n === 0; } catch (e) { return /\b(401|403)\b|42501|permission denied|row-level security/i.test(String(e && e.message)); }
};

/**
 * Plan row 15, on the reader's real path.
 * State (mutable pointers): writer upserts the probe row v1, anon reads it;
 * writer overwrites v2, anon reads again. Both must match, every round, within
 * 5 s a round (3 rounds: the stale-CDN failure on Storage was intermittent).
 * Slices: writer puts a never-used show/_selftest/<rand>.json, anon reads it.
 * Denials: anon reads kill/home but not an internal Storage object; anon writes
 * and deletes on both the table and Storage are refused and change nothing.
 */
async function selftest(ctx, reader, { now = Date.now, rounds = 3 } = {}) {
  const t0 = now();
  const rand = () => Math.random().toString(36).slice(2);
  const probe = (v) => ({ probe: t0, v, rand: rand() });
  const failures = [];
  let last;
  for (let i = 0; i < rounds; i++) {
    const v1 = probe(`${i}a`);
    await store.putMutable(ctx.state, store.PATHS.probe, v1);
    const r1 = await store.readJsonObject(reader.state, store.PATHS.probe);
    const v2 = probe(`${i}b`);
    await store.putMutable(ctx.state, store.PATHS.probe, v2);
    const r2 = await store.readJsonObject(reader.state, store.PATHS.probe);
    const same = (r, v) => r.state === 'ok' && store.canonical(r.value) === store.canonical(v);
    if (!same(r1, v1)) failures.push(`round ${i}: first anon read ${r1.state} not v1`);
    if (!same(r2, v2)) failures.push(`round ${i}: anon read after overwrite ${r2.state === 'ok' && same(r2, v1) ? 'STALE (old value)' : `${r2.state} not v2`}`);
    last = v2;
  }
  const ms = now() - t0;
  if (ms > SELFTEST_BUDGET_MS * rounds) failures.push(`slow: ${ms} ms for ${rounds} rounds`);
  for (const p of [store.PATHS.kill, store.PATHS.home]) {
    const r = await store.readJsonObject(reader.state, p);
    if (r.state !== 'ok') failures.push(`anon cannot read state ${p} (${r.state})`);
  }
  // Slice: fresh name, so a CDN copy cannot exist yet.
  const slicePath = `${SELFTEST_SLICE_DIR}/${rand()}.json`;
  const sliceText = JSON.stringify(probe('slice'));
  await putVerified(ctx.storage, slicePath, sliceText, { cacheControl: store.CACHE.immutable, cacheBust: now() });
  const slice = await reader.storage.get(slicePath);
  if (slice.status !== 200 || slice.text !== sliceText) failures.push(`anon slice read ${slice.status} ${slice.text === sliceText ? '' : 'wrong bytes'}`.trim());
  // Denials.
  await putVerified(ctx.storage, SELFTEST_INTERNAL_PATH, JSON.stringify(probe('internal')), { cacheControl: store.CACHE.mutable, cacheBust: now() });
  const internal = await reader.storage.get(SELFTEST_INTERNAL_PATH);
  if (internal.status === 200) failures.push(`anon READ internal ${SELFTEST_INTERNAL_PATH}`);
  if (!(await refused(() => reader.state.put(store.PATHS.probe, JSON.stringify(probe('anon')))))) failures.push('anon state write succeeded');
  if (!(await refused(() => reader.state.remove(store.PATHS.probe)))) failures.push('anon state delete succeeded');
  const killBefore = await store.readJsonObject(ctx.state, store.PATHS.kill);
  if (killBefore.state === 'ok' && Number.isInteger(killBefore.value.seq)) {
    // Writes the row's own current value back, so even a leaky policy that lets
    // it through cannot flip the kill; a 1-row answer still proves the leak.
    if (!(await refused(() => reader.state.putIfSeq(store.PATHS.kill, JSON.stringify(killBefore.value), killBefore.value.seq)))) failures.push('anon compare-and-swap on the kill row was not refused');
  }
  const stateAfter = await store.readJsonObject(ctx.state, store.PATHS.probe);
  if (stateAfter.state !== 'ok' || store.canonical(stateAfter.value) !== store.canonical(last)) failures.push(`anon write/delete changed the probe row (now ${stateAfter.state})`);
  if (!(await refused(() => reader.storage.put(slicePath, 'x', { cacheControl: store.CACHE.mutable })))) failures.push('anon Storage PUT succeeded');
  await refused(() => reader.storage.remove(slicePath));
  const sliceAfter = await ctx.storage.get(slicePath, { cacheBust: now() });
  if (sliceAfter.status !== 200 || sliceAfter.text !== sliceText) failures.push(`anon write/delete changed the slice probe (now ${sliceAfter.status})`);
  await ctx.storage.remove(slicePath).catch(() => {});
  await ctx.storage.remove(SELFTEST_INTERNAL_PATH).catch(() => {});
  return { ok: failures.length === 0, ms, rounds, failures };
}

async function main(argv = process.argv.slice(2), env = process.env, out = console.log) {
  let a;
  try { a = parseArgs(argv); } catch (e) { out(String(e.message)); return 2; }
  const modes = ['status', 'setup', 'kill', 'unkill', 'selftest'].filter((k) => a[k]);
  if (modes.length !== 1) { out('pick exactly one of --status --setup --kill --unkill --selftest'); return 2; }
  const by = env.GITHUB_ACTOR ? `gh:${env.GITHUB_ACTOR}` : (env.USER || 'local');
  const ctx = { storage: store.storeFromEnv(env), state: store.stateFromEnv(env) };
  const readerFor = (timeoutMs) => ({ storage: store.readerStoreFromEnv(env, { timeoutMs }), state: store.readerStateFromEnv(env, { timeoutMs }) });
  switch (modes[0]) {
    case 'status': {
      const st = await status(ctx, readerFor(10000));
      out(JSON.stringify(st, null, 2));
      return statusHealthy(st) ? 0 : 1;
    }
    case 'setup': out(JSON.stringify(await store.setupStore(ctx.storage, ctx.state, { by }))); return 0;
    case 'kill':
    case 'unkill': {
      if (!a.reason || a.reason === true) { out('--reason="..." is required'); return 2; }
      const k = await store.setKill(ctx.state, { killed: modes[0] === 'kill', reason: a.reason, by });
      out(`kill now killed=${k.killed} seq=${k.seq}`);
      return 0;
    }
    case 'selftest': {
      const r = await selftest(ctx, readerFor(SELFTEST_BUDGET_MS));
      out(`selftest ${r.ok ? 'PASS' : 'FAIL'}: ${r.rounds} state overwrite rounds through the anon reader in ${r.ms} ms${r.failures.length ? `; ${r.failures.join('; ')}` : ''}`);
      return r.ok ? 0 : 1;
    }
  }
  return 2;
}

if (require.main === module) {
  main().then((code) => { process.exitCode = code; }, (e) => { console.error(`show-refresh-store: ${e.message}`); process.exitCode = 1; });
}

module.exports = { main, selftest, status, statusHealthy, parseArgs };
