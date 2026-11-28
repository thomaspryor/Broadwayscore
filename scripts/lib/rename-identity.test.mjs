// rename-identity: which committed copy the push-time restore compares a staged review against.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { committedHistoryFor, stampRecreatedReviews, recreateStamp, renameStamp } = require('./rename-identity.js');

const committed = {
  'therese-raquin-2015/flipside.json': { wrongProduction: true, llmScore: { score: 40 } },
  'a/src.json': { llmScore: { score: 70 } },
};
const read = (p) => { if (!(p in committed)) throw new Error('absent'); return committed[p]; };

test('an unstamped file is compared against its own committed copy', () => {
  assert.deepEqual(committedHistoryFor('therese-raquin-2015/flipside.json', { fullText: 'x' }, read), committed['therese-raquin-2015/flipside.json']);
});

test('a file a plan deleted and wrote anew has no committed history (BRO-5942)', () => {
  const local = { fullText: 'clean section', _recreatedAfterDelete: recreateStamp('plan-1', '2026-10-23T00:00:00Z') };
  assert.equal(committedHistoryFor('therese-raquin-2015/flipside.json', local, read), null);
});

test('once the stamped file is committed, its later pushes use that copy again', () => {
  const stamp = recreateStamp('plan-1', '2026-10-23T00:00:00Z');
  const atPath = { wrongProduction: false, _recreatedAfterDelete: stamp };
  const readStamped = (p) => (p === 'x/y.json' ? atPath : read(p));
  assert.equal(committedHistoryFor('x/y.json', { _recreatedAfterDelete: { ...stamp } }, readStamped), atPath);
});

test('a fresh rename onto a deleted path keeps the rename source as history (BRO-5356)', () => {
  const local = { _renamedFrom: renameStamp('a', 'src.json'), _recreatedAfterDelete: recreateStamp('plan-2') };
  assert.deepEqual(committedHistoryFor('therese-raquin-2015/flipside.json', local, read), committed['a/src.json']);
});

test('a refused or failed stamp write is not reported as stamped', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recreated-'));
  fs.mkdirSync(path.join(dir, 's'), { recursive: true });
  fs.writeFileSync(path.join(dir, 's/a.json'), JSON.stringify({ fullText: 'a' }));
  fs.writeFileSync(path.join(dir, 's/b.json'), JSON.stringify({ fullText: 'b' }));
  const stamped = stampRecreatedReviews(dir, new Set(['s/a.json', 's/b.json']), 'plan-4', {
    write: (abs) => { if (abs.endsWith('a.json')) return { wrote: false }; throw new Error('disk full'); },
  });
  assert.deepEqual(stamped, []);
});

test('stampRecreatedReviews stamps only deleted paths that exist again', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recreated-'));
  fs.mkdirSync(path.join(dir, 's'), { recursive: true });
  fs.writeFileSync(path.join(dir, 's/back.json'), JSON.stringify({ fullText: 'new' }));
  const writes = [];
  const stamped = stampRecreatedReviews(dir, new Set(['s/back.json', 's/gone.json']), 'plan-3', {
    at: '2026-10-23T01:00:00Z', write: (abs, rec) => writes.push([path.relative(dir, abs), rec]),
  });
  assert.deepEqual(stamped, ['s/back.json']);
  assert.deepEqual(writes, [['s/back.json', { fullText: 'new', _recreatedAfterDelete: { fixId: 'plan-3', at: '2026-10-23T01:00:00Z' } }]]);
});
