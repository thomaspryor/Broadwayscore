// BRO-7171 plan item 8: one persistent Chrome profile per outlet outside /tmp,
// shared by renew-cookies.js, the gap driver and the login/recover scripts,
// under the renew lock. Before this, each login and recover script had its own
// /tmp profile, so a login made by one never reached the others and macOS
// cleared them all on reboot.
// Run: node --test scripts/lib/cookie-renew-profile.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const LIB = path.join(here, 'cookie-renew.js');
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'profile-claim-')));
const env = { ...process.env, HOME: path.join(TMP, 'home'), COOKIE_RENEW_LOCK_PATH: path.join(TMP, 'cookies', '_renew.lock') };
const claimIn = (code) => spawnSync(process.execPath, ['-e', `const C = require(${JSON.stringify(LIB)}); ${code}`], { env, encoding: 'utf8' });

test('claim migrates the newest legacy /tmp profile once, without Chrome singleton files', () => {
  const older = path.join(TMP, 'legacy-old'); const newer = path.join(TMP, 'legacy-new');
  for (const [d, mark] of [[older, 'old'], [newer, 'new']]) {
    fs.mkdirSync(path.join(d, 'Default'), { recursive: true });
    fs.writeFileSync(path.join(d, 'Default', 'Cookies'), mark);
    fs.writeFileSync(path.join(d, 'SingletonLock'), 'x');
  }
  const past = new Date(Date.now() - 3600_000);
  fs.utimesSync(older, past, past);
  const r = claimIn(`const a = C.claimOutletProfile('nyt', { legacy: [${JSON.stringify(older)}, ${JSON.stringify(newer)}] });
    const b = C.claimOutletProfile('nyt'); console.log(JSON.stringify({ dir: a.dir, same: a === b }));`);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout.trim().split('\n').pop());
  assert.equal(out.dir, path.join(env.HOME, 'Library', 'Application Support', 'BroadwayScorecard', 'browser-profiles', 'nyt'));
  assert.ok(!out.dir.startsWith('/tmp') && !out.dir.startsWith(os.tmpdir()) || out.dir.startsWith(env.HOME));
  assert.equal(out.same, true, 'a second launch site in the same run reuses the claim');
  assert.equal(fs.readFileSync(path.join(out.dir, 'Default', 'Cookies'), 'utf8'), 'new');
  assert.equal(fs.existsSync(path.join(out.dir, 'SingletonLock')), false);
  assert.equal(fs.existsSync(env.COOKIE_RENEW_LOCK_PATH), false, 'released at exit');
});

test('a second process cannot open the profile while another holds it', async () => {
  const holder = spawn(process.execPath, ['-e', `require(${JSON.stringify(LIB)}).claimOutletProfile('wsj'); console.log('HELD'); setTimeout(() => {}, 20000);`], { env });
  await new Promise((res) => holder.stdout.once('data', res));
  const r = claimIn(`try { C.claimOutletProfile('wsj'); console.log('GOT'); } catch (e) { console.log(e.code); }`);
  assert.equal(r.stdout.trim(), 'EPROFILEBUSY');
  holder.kill('SIGKILL');
  await new Promise((res) => holder.once('exit', res));
  const r2 = claimIn(`C.claimOutletProfile('wsj'); console.log('GOT');`);
  assert.equal(r2.stdout.trim(), 'GOT', 'a dead holder is taken over');
});

// Ship-check: the renew lock counts as abandoned after 2h by mtime, and a
// profile claim holds it for the whole run. Without a heartbeat a second run
// claimed a LIVE 2h+ holder's lock and opened Chrome on the same profile.
test('a live holder past 2h keeps the profile: the held lock is heartbeated', async () => {
  const hbEnv = { ...env, COOKIE_RENEW_HEARTBEAT_MS: '100' };
  const holder = spawn(process.execPath, ['-e', `require(${JSON.stringify(LIB)}).claimOutletProfile('nyt'); console.log('HELD'); setTimeout(() => {}, 20000);`], { env: hbEnv });
  await new Promise((res) => holder.stdout.once('data', res));
  const old = new Date(Date.now() - 3 * 3600_000);
  fs.utimesSync(env.COOKIE_RENEW_LOCK_PATH, old, old); // as if acquired 3h ago
  await new Promise((res) => setTimeout(res, 400));
  const r = claimIn(`try { C.claimOutletProfile('nyt'); console.log('GOT'); } catch (e) { console.log(e.code); }`);
  assert.equal(r.stdout.trim(), 'EPROFILEBUSY', 'live holder kept its profile');
  holder.kill('SIGKILL');
  await new Promise((res) => holder.once('exit', res));
});

// Class guard: no script opens a Chrome profile under /tmp any more.
test('class guard: no /tmp Chrome profiles in scripts/', () => {
  const repo = path.resolve(here, '..', '..');
  const RE = /(?:PROFILE_DIR\s*=\s*|profileDir:\s*|launchPersistentContext\(\s*|launchOtpBrowser\(\s*)['"`]\/tmp\//;
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(d, e.name);
    if (e.isDirectory()) return ['node_modules', '.git'].includes(e.name) ? [] : walk(p);
    return /\.(c?js|mjs)$/.test(e.name) && !/\.test\./.test(e.name) ? [p] : [];
  });
  // Throwaway by design: --local mode injects its own cookies into a scratch profile each run.
  const ALLOW = new Set(['scripts/newspapers-com-extract.js:/tmp/np-local-extract-profile']);
  const hits = walk(path.join(repo, 'scripts')).flatMap((f) => {
    const rel = path.relative(repo, f);
    return fs.readFileSync(f, 'utf8').split('\n')
      .filter((l) => RE.test(l) && ![...ALLOW].some((a) => a.startsWith(`${rel}:`) && l.includes(a.slice(rel.length + 1))))
      .map(() => rel);
  });
  assert.deepEqual(hits, [], 'use cookie-renew.claimOutletProfile(outlet) (shared profile + renew lock)');
});
