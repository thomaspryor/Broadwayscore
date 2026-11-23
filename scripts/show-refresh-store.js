#!/usr/bin/env node
'use strict';
/**
 * BRO-8056 phase 1c: operate the private show-refresh store.
 *
 *   --status                     bucket visibility, kill state, home.json generation
 *   --setup                      create the private bucket, seed kill.json + home.json
 *   --kill --reason="..."        set kill.json killed:true (the reader renders the build)
 *   --unkill --reason="..."      set killed:false
 *   --selftest                   write a no-cache probe, read it back through a signed
 *                                URL with no key, within 5 s (plan row 15)
 *   --reader-urls --out=FILE     write SHOW_REFRESH_HOME_URL / SHOW_REFRESH_KILL_URL to
 *                                FILE (mode 600). Never printed: signed URLs are secrets.
 *
 * Needs SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL) and SUPABASE_SERVICE_ROLE_KEY.
 * Exit 0 ok, 1 failure, 2 usage.
 */
require('./lib/cli-help').exitOnHelp(module);
const fs = require('fs');
const store = require('./lib/show-refresh/store');
const { putVerified } = require('./lib/live-score/storage');

const SELFTEST_PATH = 'selftest.json';
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
 * (boolean killed) and home.json a schema-1 object. A readable but malformed
 * file is reported as state 'malformed', not 'ok'.
 */
function statusHealthy(st) {
  return st.bucket !== 'missing' && st.public === false && st.kill.state === 'ok' && st.home.state === 'ok';
}

const validKill = (v) => Boolean(v) && typeof v === 'object' && typeof v.killed === 'boolean';
const validHome = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v) && v.schema === 1 && typeof v.shows === 'object' && v.shows !== null;
const shape = (read, valid) => (read.state === 'ok' && !valid(read.value) ? 'malformed' : read.state);

async function status(s) {
  const meta = await s.getBucket();
  if (!meta) return { bucket: 'missing', kill: { state: 'missing' }, home: { state: 'missing' } };
  const kill = await store.readJsonObject(s, store.PATHS.kill);
  const home = await store.readJsonObject(s, store.PATHS.home);
  const eff = store.effectiveKill(kill);
  return {
    bucket: s.bucket,
    public: meta.public,
    kill: { state: shape(kill, validKill), killed: eff.killed, reason: eff.reason, seq: kill.value && kill.value.seq, at: kill.value && kill.value.at },
    home: { state: shape(home, validHome), generation: home.value && home.value.generation, shows: home.value && home.value.shows ? Object.keys(home.value.shows).length : null },
  };
}

/**
 * Plan row 15: sign ONE URL, write v1, read it keyless, overwrite with v2,
 * read the SAME URL again. Both reads must match, all within 5 s. This proves
 * what the reader relies on: a no-cache object read through a long-lived
 * signed URL shows an overwrite promptly (no stale CDN copy).
 */
async function selftest(s, { fetchImpl = fetch, now = Date.now } = {}) {
  const t0 = now();
  const probe = (v) => JSON.stringify({ probe: t0, v, rand: Math.random().toString(36).slice(2) });
  const v1 = probe(1);
  await putVerified(s, SELFTEST_PATH, v1, { cacheControl: store.CACHE.mutable, cacheBust: t0 });
  const url = await s.signUrl(SELFTEST_PATH, 60);
  const read = async () => {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(SELFTEST_BUDGET_MS) });
    return { status: res.status, body: await res.text() };
  };
  const r1 = await read();
  const v2 = probe(2);
  await putVerified(s, SELFTEST_PATH, v2, { cacheControl: store.CACHE.mutable, cacheBust: t0 + 1 });
  const r2 = await read();
  const ms = now() - t0;
  const matched = r1.body === v1 && r2.body === v2;
  const status = r2.status === 200 ? r1.status : r2.status;
  const ok = r1.status === 200 && r2.status === 200 && matched && ms <= SELFTEST_BUDGET_MS;
  return { ok, ms, status, matched, overwriteSeen: r2.body === v2 };
}

async function main(argv = process.argv.slice(2), env = process.env, out = console.log) {
  let a;
  try { a = parseArgs(argv); } catch (e) { out(String(e.message)); return 2; }
  const modes = ['status', 'setup', 'kill', 'unkill', 'selftest', 'reader-urls'].filter((k) => a[k]);
  if (modes.length !== 1) { out('pick exactly one of --status --setup --kill --unkill --selftest --reader-urls'); return 2; }
  const by = env.GITHUB_ACTOR ? `gh:${env.GITHUB_ACTOR}` : (env.USER || 'local');
  const s = store.storeFromEnv(env);
  switch (modes[0]) {
    case 'status': {
      const st = await status(s);
      out(JSON.stringify(st, null, 2));
      return statusHealthy(st) ? 0 : 1;
    }
    case 'setup': out(JSON.stringify(await store.setupStore(s, { by }))); return 0;
    case 'kill':
    case 'unkill': {
      if (!a.reason || a.reason === true) { out('--reason="..." is required'); return 2; }
      const k = await store.setKill(s, { killed: modes[0] === 'kill', reason: a.reason, by });
      out(`kill.json now killed=${k.killed} seq=${k.seq}`);
      return 0;
    }
    case 'selftest': {
      const r = await selftest(s);
      out(`selftest ${r.ok ? 'PASS' : 'FAIL'}: status ${r.status}, matched ${r.matched}, overwrite seen ${r.overwriteSeen}, ${r.ms} ms (budget ${SELFTEST_BUDGET_MS})`);
      return r.ok ? 0 : 1;
    }
    case 'reader-urls': {
      if (!a.out || a.out === true) { out('--out=FILE is required (URLs are never printed)'); return 2; }
      const urls = await store.readerUrls(s);
      fs.writeFileSync(a.out, Object.entries(urls).map(([k, v]) => `${k}=${v}`).join('\n') + '\n', { mode: 0o600 });
      fs.chmodSync(a.out, 0o600); // writeFileSync's mode only applies when it creates the file
      out(`wrote ${Object.keys(urls).join(', ')} to ${a.out}`);
      return 0;
    }
  }
  return 2;
}

if (require.main === module) {
  main().then((code) => { process.exitCode = code; }, (e) => { console.error(`show-refresh-store: ${e.message}`); process.exitCode = 1; });
}

module.exports = { main, selftest, status, statusHealthy, parseArgs };
