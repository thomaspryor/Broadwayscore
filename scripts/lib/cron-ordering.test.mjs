import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ORDERING, checkOrdering, fileReader, chainsOn, minuteOfDay } = require('./cron-ordering.js');
const WF = path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..', '.github', 'workflows');

test('every registered cron ordering holds against the live workflow files (BRO-4801)', () => {
  const problems = checkOrdering(fileReader(WF));
  assert.deepEqual(problems.map((p) => `${p.entry.before} -> ${p.entry.after}: ${p.problem}`), []);
  assert.ok(ORDERING.length >= 5);
});

const PROD = "name: Rebuild\non:\n  schedule:\n    - cron: '0 4 * * *'\n";
const read = (files) => (f) => (f in files ? files[f] : null);
const entry = { before: 'p.yml', beforeCron: '0 4 * * *', after: 'c.yml', why: 't' };

test('a consumer 15-90 min after its producer fails; 4h+ passes; just-before fails', () => {
  const at = (c) => checkOrdering(read({ 'p.yml': PROD, 'c.yml': `on:\n  schedule:\n    - cron: '${c}'\n` }), [entry]);
  assert.equal(at('15 5 * * *').length, 1);
  assert.equal(at('0 9 * * *').length, 0);
  assert.equal(at('30 3 * * *').length, 1, '23.5h lead = runs just before the producer');
});

test('a workflow_run chain on the producer satisfies the ordering at any time', () => {
  const cons = "on:\n  workflow_run:\n    workflows: ['Rebuild']\n    types: [completed]\n  schedule:\n    - cron: '15 4 * * *'\n";
  assert.equal(chainsOn(cons, 'Rebuild'), true);
  assert.equal(checkOrdering(read({ 'p.yml': PROD, 'c.yml': cons }), [entry]).length, 0);
});

test('a producer whose registered cron moved is reported, not silently passed', () => {
  const moved = PROD.replace("'0 4 * * *'", "'0 6 * * *'");
  const p = checkOrdering(read({ 'p.yml': moved, 'c.yml': "on:\n  schedule:\n    - cron: '0 12 * * *'\n" }), [entry]);
  assert.match(p[0].problem, /no longer has cron/);
  assert.equal(minuteOfDay('*/5 * * * *'), null);
});

test('chainsOn reads flow and block workflow lists', () => {
  assert.equal(chainsOn('on:\n  workflow_run:\n    workflows: ["A", \'B\']\n', 'B'), true);
  assert.equal(chainsOn('on:\n  workflow_run:\n    workflows:\n      - "Rebuild Reviews Data"\n      - Other\n    types: [completed]\n', 'Other'), true);
  assert.equal(chainsOn('on:\n  workflow_run:\n    workflows:\n      - "Rebuild Reviews Data"\n    types: [completed]\n', 'types'), false);
  assert.equal(chainsOn('on:\n  push:\n', 'A'), false);
});
