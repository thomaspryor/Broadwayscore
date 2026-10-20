import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { acquireClaim, releaseClaim, DEFAULT_STALE_MS } = require('./atomic-claim.js');

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-claim-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('BRO-5584: a stale holder cannot release its successor, even in the same process', t => {
  const dir = tmpDir(t);
  const first = acquireClaim(dir, 'k1', { now: 1000 });
  const second = acquireClaim(dir, 'k1', { now: 1000 + DEFAULT_STALE_MS });
  releaseClaim(dir, 'k1', first.nonce);
  assert.ok(fs.existsSync(path.join(dir, 'k1.claim')), 'successor claim must survive the old release');
  assert.equal(typeof second.nonce, 'string');
  assert.notEqual(first.nonce, second.nonce);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'k1.claim', 'meta.json'))).nonce, second.nonce);
  releaseClaim(dir, 'k1', second.nonce);
  assert.equal(fs.existsSync(path.join(dir, 'k1.claim')), false);
});

test('BRO-5584: wrong or missing ownership tokens cannot release a claim', t => {
  const dir = tmpDir(t);
  const owner = acquireClaim(dir, 'k1');
  for (const token of ['wrong', undefined, null, true, '']) {
    releaseClaim(dir, 'k1', token);
    assert.ok(fs.existsSync(path.join(dir, 'k1.claim')), `claim must survive token ${token}`);
  }
  releaseClaim(dir, 'k1', owner.nonce);
  assert.equal(fs.existsSync(path.join(dir, 'k1.claim')), false);
});

test('BRO-5584: missing, corrupt, and legacy metadata prevent release', t => {
  const dir = tmpDir(t);
  for (const metadata of [null, '{invalid', JSON.stringify({ pid: process.pid, ts: 1000 })]) {
    const owner = acquireClaim(dir, 'k1', { now: 1000 });
    const claim = path.join(dir, 'k1.claim');
    const file = path.join(claim, 'meta.json');
    if (metadata === null) fs.unlinkSync(file);
    else fs.writeFileSync(file, metadata);
    assert.doesNotThrow(() => releaseClaim(dir, 'k1', owner.nonce));
    assert.ok(fs.existsSync(claim));
    fs.rmSync(claim, { recursive: true, force: true });
  }
});

test('BRO-5584: a stale legacy claim gains a token on takeover', t => {
  const dir = tmpDir(t);
  const claim = path.join(dir, 'k1.claim');
  fs.mkdirSync(claim);
  fs.writeFileSync(path.join(claim, 'meta.json'), JSON.stringify({ pid: process.pid, ts: 1000 }));
  const owner = acquireClaim(dir, 'k1', { now: 1000 + DEFAULT_STALE_MS });
  assert.equal(typeof owner.nonce, 'string');
  releaseClaim(dir, 'k1');
  assert.ok(fs.existsSync(claim));
  releaseClaim(dir, 'k1', owner.nonce);
  assert.equal(fs.existsSync(claim), false);
});

test('acquireClaim: first caller wins, a second caller is refused while fresh', t => {
  const dir = tmpDir(t);
  assert.equal(typeof acquireClaim(dir, 'k1', { now: 1000 }).nonce, 'string');
  assert.equal(acquireClaim(dir, 'k1', { now: 1000 + DEFAULT_STALE_MS - 1 }), false, 'still fresh — genuinely held');
});

test('acquireClaim: a genuinely stale claim is taken over', t => {
  const dir = tmpDir(t);
  assert.equal(typeof acquireClaim(dir, 'k1', { now: 1000 }).nonce, 'string');
  assert.equal(typeof acquireClaim(dir, 'k1', { now: 1000 + DEFAULT_STALE_MS + 1 }).nonce, 'string', 'past staleMs — takeover');
});

test('releaseClaim frees the key for immediate re-acquisition', t => {
  const dir = tmpDir(t);
  const owner = acquireClaim(dir, 'k1', { now: 1000 });
  releaseClaim(dir, 'k1', owner.nonce);
  assert.equal(typeof acquireClaim(dir, 'k1', { now: 1001 }).nonce, 'string');
});

test('BRO-395: a future-dated existing claim is never treated as fresh (never wedges the claim forever)', t => {
  const dir = tmpDir(t);
  // Held "now" (ms epoch far in the future relative to every later check
  // below) — simulates a corrupt/clock-skewed write, not a legitimate hold.
  const futureHoldMs = Date.now() + 45 * 24 * 60 * 60 * 1000;
  assert.equal(typeof acquireClaim(dir, 'k1', { now: futureHoldMs }).nonce, 'string');
  // A real caller checking moments later, with the real clock, must NOT be
  // told "fresh, held elsewhere" — `now - existing.ts` is deeply negative
  // here, which the old unclamped check (`< staleMs`) would have read as
  // fresh forever, permanently wedging this claim.
  assert.equal(
    typeof acquireClaim(dir, 'k1', { now: Date.now() }).nonce,
    'string',
    'a future-dated existing claim must be treated as untrustworthy, not fresh — takeover must succeed'
  );
});
