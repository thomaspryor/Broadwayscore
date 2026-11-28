/**
 * BRO-6759: the different-critic cross-outlet census must call out a flag that
 * hides a review without verified evidence (the appropriate-2023 Deadline case).
 * Uses a synthetic review-texts tree; requires the real audit().
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { audit, containment } = require('../../scripts/audit-cross-outlet-different-critic.js');

const body = (n) => Array.from({ length: 80 }, (_, i) => `word${n}x${i}`).join(' ');

function tree(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xoutlet-'));
  for (const [rel, rec] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), JSON.stringify(rec));
  }
  return root;
}

test('unverified different-critic flag is reported, verified and stale ones are labelled', () => {
  const shared = body(1);
  const root = tree({
    'show/guardian--a.json': { outletId: 'guardian', outlet: 'The Guardian', criticName: 'Adrian Horton', fullText: shared },
    'show/deadline--b.json': { outletId: 'deadline', outlet: 'Deadline', criticName: 'Greg Evans', fullText: shared, crossOutletDuplicate: true, crossOutletPrimaryFile: 'show/guardian--a.json', crossOutletSimilarity: 49 },
    'show/ok--c.json': { outletId: 'deadline', outlet: 'Deadline', criticName: 'Greg Evans', fullText: shared, crossOutletDuplicate: true, crossOutletPrimaryFile: 'show/guardian--a.json', crossOutletVerified: true },
    'show/stale--d.json': { outletId: 'ny1', outlet: 'NY1', criticName: 'Roma Torre', fullText: body(2), crossOutletDuplicate: true, crossOutletPrimaryFile: 'show/guardian--a.json' },
  });
  const status = Object.fromEntries(audit(root).map((r) => [r.file, r.status]));
  assert.equal(status['deadline--b.json'], 'unverified');
  assert.equal(status['ok--c.json'], 'verified-by-person');
  assert.equal(status['stale--d.json'], 'stale');
});

test('same critic under two outlets is never reported', () => {
  const t = body(3);
  const root = tree({
    'show/guardian--a.json': { outletId: 'guardian', criticName: 'Susannah Clapp', fullText: t },
    'show/observer--b.json': { outletId: 'observer', criticName: 'Susannah Clapp', fullText: t, crossOutletDuplicate: true, crossOutletPrimaryFile: 'show/guardian--a.json' },
  });
  assert.deepEqual(audit(root), []);
});

test('containment is a share of the smaller text', () => {
  assert.equal(containment(body(4), body(4)), 100);
  assert.equal(containment(body(4), body(5)), 0);
});

test('BRO-6774: a person-verified flag whose primary no longer shares the text is verified-stale; excerpts count as text', () => {
  const root = tree({
    'show/prim--a.json': { outletId: 'guardian', criticName: 'Adrian Horton', fullText: body(6) },
    'show/vs--b.json': { outletId: 'deadline', criticName: 'Greg Evans', fullText: body(7), crossOutletDuplicate: true, crossOutletPrimaryFile: 'show/prim--a.json', crossOutletVerified: true },
    'show/ex--c.json': { outletId: 'nypost', criticName: 'Johnny Oleksinski', fullText: '', dtliExcerpt: body(6), crossOutletDuplicate: true, crossOutletPrimaryFile: 'show/prim--a.json' },
  });
  const status = Object.fromEntries(audit(root).map((r) => [r.file, r.status]));
  assert.equal(status['vs--b.json'], 'verified-stale');
  assert.notEqual(status['ex--c.json'], 'stale', 'excerpt text is compared, not skipped as empty');
});
