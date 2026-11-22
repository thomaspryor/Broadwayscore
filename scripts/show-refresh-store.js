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

/** Healthy = bucket exists, is private, kill.json and home.json both read ok. */
function statusHealthy(st) {
  return st.bucket !== 'missing' && st.public === false && st.kill.state === 'ok' && st.home.state === 'ok';
}

async function status(s) {
  const meta = await s.getBucket();
  if (!meta) return { bucket: 'missing', kill: { state: 'missing' }, home: { state: 'missing' } };
  const kill = await store.readJsonObject(s, store.PATHS.kill);
  const home = await store.readJsonObject(s, store.PATHS.home);
  const eff = store.effectiveKill(kill);
  return {
    bucket: s.bucket,
    public: meta.public,
    kill: { state: kill.state, killed: eff.killed, reason: eff.reason, seq: kill.value && kill.value.seq, at: kill.value && kill.value.at },
    home: { state: home.state, generation: home.value && home.value.generation, shows: home.value && home.value.shows ? Object.keys(home.value.shows).length : null },
  };
}

/** No-cache write, then a keyless read through a fresh signed URL, all inside 5 s. */
async function selftest(s, { fetchImpl = fetch, now = Date.now } = {}) {
  const t0 = now();
  const text = JSON.stringify({ probe: t0, rand: Math.random().toString(36).slice(2) });
  await putVerified(s, SELFTEST_PATH, text, { cacheControl: store.CACHE.mutable, cacheBust: t0 });
  const url = await s.signUrl(SELFTEST_PATH, 60);
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(SELFTEST_BUDGET_MS) });
  const body = await res.text();
  const ms = now() - t0;
  const ok = res.status === 200 && body === text && ms <= SELFTEST_BUDGET_MS;
  return { ok, ms, status: res.status, matched: body === text };
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
      out(`selftest ${r.ok ? 'PASS' : 'FAIL'}: status ${r.status}, matched ${r.matched}, ${r.ms} ms (budget ${SELFTEST_BUDGET_MS})`);
      return r.ok ? 0 : 1;
    }
    case 'reader-urls': {
      if (!a.out || a.out === true) { out('--out=FILE is required (URLs are never printed)'); return 2; }
      const urls = await store.readerUrls(s);
      fs.writeFileSync(a.out, Object.entries(urls).map(([k, v]) => `${k}=${v}`).join('\n') + '\n', { mode: 0o600 });
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
