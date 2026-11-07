// BRO-4638: the Mac opening-night monitor is retired through its existing
// kill switch (data/opening-night-monitor/DISABLED), committed with a
// "RETIRED:" first line so the Mac's 30-minute checkout-sync carries it in.
// These tests prove (1) the marker is tracked in the tree and not gitignored,
// and (2) a RETIRED marker stops the launcher before the stale-kill-switch
// pager, while an ordinary DISABLED file still reaches that pager.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const KILL_FILE_REL = 'data/opening-night-monitor/DISABLED';
const { isRetiredMarker, readRetiredMarker, RETIRED_PREFIX } = require(path.join(ROOT, 'scripts/lib/retired-kill-switch.js'));
const core = require(path.join(ROOT, 'scripts/lib/dispatch-watchdog-core.js'));

test('the RETIRED marker is committed at the kill-switch path with the RETIRED: prefix', () => {
  const text = fs.readFileSync(path.join(ROOT, KILL_FILE_REL), 'utf8');
  assert.ok(text.startsWith(`${RETIRED_PREFIX} `), 'DISABLED must start with "RETIRED: "');
  assert.match(text.split('\n')[0], /RETIRED: \d{4}-\d{2}-\d{2} BRO-4638/, 'first line must carry the date and BRO-4638');
  assert.ok(readRetiredMarker(path.join(ROOT, KILL_FILE_REL)), 'readRetiredMarker must recognise the committed file');
});

test('the kill-switch path is not gitignored, so checkout-sync carries it to the Mac', () => {
  let ignored = true;
  try {
    execFileSync('git', ['check-ignore', '-q', KILL_FILE_REL], { cwd: ROOT, stdio: 'ignore' });
  } catch (err) {
    if (err.status === 1) ignored = false; // exit 1 = not ignored
    else throw err;
  }
  assert.equal(ignored, false, `${KILL_FILE_REL} must not be gitignored`);
});

test('a RETIRED marker is recognised; ordinary kill-switch content is not', () => {
  assert.equal(isRetiredMarker('RETIRED: 2026-10-11 BRO-4638'), true);
  assert.equal(isRetiredMarker('\n  RETIRED: leading whitespace ok'), true);
  assert.equal(isRetiredMarker(''), false);
  assert.equal(isRetiredMarker('maintenance window, back tonight'), false);
  assert.equal(isRetiredMarker('retired: lowercase is not the marker'), false);
  assert.equal(isRetiredMarker(null), false);
});

test('an ordinary 48h-old DISABLED is still stale; the same age with RETIRED is skipped', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'on-retired-'));
  try {
    const plain = path.join(dir, 'plain');
    const retired = path.join(dir, 'retired');
    fs.writeFileSync(plain, '');
    fs.writeFileSync(retired, 'RETIRED: 2026-10-11 BRO-4638\n');
    const old = new Date(Date.now() - 48 * 3600 * 1000);
    fs.utimesSync(plain, old, old);
    fs.utimesSync(retired, old, old);
    // Both are past the pager's bar, so only the RETIRED guard keeps one quiet.
    assert.equal(core.killSwitchStaleness(fs.statSync(plain).mtimeMs, Date.now()).stale, true);
    assert.equal(core.killSwitchStaleness(fs.statSync(retired).mtimeMs, Date.now()).stale, true);
    assert.equal(readRetiredMarker(plain), null, 'an empty DISABLED must still reach the pager');
    assert.equal(readRetiredMarker(retired), 'RETIRED: 2026-10-11 BRO-4638');
    assert.equal(readRetiredMarker(path.join(dir, 'missing')), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('the launcher returns 0 on a RETIRED marker before any work and before the stale pager', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts/opening-night-monitor-launch.js'), 'utf8');
  assert.match(src, /require\(['"]\.\/lib\/retired-kill-switch\.js['"]\)/);
  const guardIdx = src.indexOf('const retired = readRetiredMarker(KILL_FILE);');
  const returnIdx = src.indexOf('if (retired) {', guardIdx);
  const gcIdx = src.indexOf('  gcStateFiles();\n  const shows = loadShows();');
  const pagerIdx = src.indexOf('pageIfKillSwitchStale(KILL_FILE');
  assert.ok(guardIdx > -1 && returnIdx > -1 && gcIdx > -1 && pagerIdx > -1, 'expected guard, gc and pager markers');
  assert.ok(guardIdx < gcIdx, 'RETIRED guard must run before per-tick work');
  assert.ok(guardIdx < pagerIdx, 'RETIRED guard must run before the stale-kill-switch pager');
  assert.match(src.slice(returnIdx, returnIdx + 120), /return 0;/, 'a retired tick must exit 0 so launchd records no failure');
});
