// BRO-6594: requires the real planner (CLAUDE.md rule 15).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { expectedSource, planRepairs } = require('./rename-crosswire.js');

const OLD = '_pending/the-heart/deadline--7fd7345c.json';
const THR = '_pending/medea/hollywood-reporter--2c44c6f9.json';
const FT = '_pending/medea/financialtimes--16b6f926.json';

test('expectedSource: untouched by us -> remote, only us -> ours, both -> null', () => {
  const ours = new Set([OLD, FT]);
  const remote = new Set([OLD, THR]);
  assert.equal(expectedSource(THR, ours, remote), 'remote');
  assert.equal(expectedSource(FT, ours, remote), 'ours');
  assert.equal(expectedSource(OLD, ours, remote), null);
  assert.equal(expectedSource('shows.json', ours, remote), 'remote');
});

test('planRepairs: the live cross-wire (our FT content in the remote THR path) is restored to remote', () => {
  const plan = planRepairs({
    paths: [THR, FT, OLD],
    oursTouched: new Set([OLD, FT]),
    remoteTouched: new Set([OLD, THR]),
    blobs: {
      head: new Map([[THR, 'ft-ish-mix'], [FT, 'ft']]),
      ours: new Map([[FT, 'ft']]),
      remote: new Map([[THR, 'thr']]),
    },
  });
  assert.deepEqual(plan, [{ path: THR, source: 'remote', action: 'restore' }]);
});

test('planRepairs: our addition lost to a pairing is restored; a path git invented is deleted', () => {
  const plan = planRepairs({
    paths: [FT, 'x/moved.json'],
    oursTouched: new Set([FT]),
    remoteTouched: new Set(),
    blobs: { head: new Map([['x/moved.json', 'ft']]), ours: new Map([[FT, 'ft']]), remote: new Map() },
  });
  assert.deepEqual(plan, [
    { path: FT, source: 'ours', action: 'restore' },
    { path: 'x/moved.json', source: 'remote', action: 'delete' },
  ]);
});

test('planRepairs: no-op when HEAD already matches each one-sided path, and both-touched paths are never touched', () => {
  const plan = planRepairs({
    paths: [FT, THR, 'reviews.json'],
    oursTouched: new Set([FT, 'reviews.json']),
    remoteTouched: new Set([THR, 'reviews.json']),
    blobs: {
      head: new Map([[FT, 'ft'], [THR, 'thr'], ['reviews.json', 'merged']]),
      ours: new Map([[FT, 'ft'], ['reviews.json', 'o']]),
      remote: new Map([[THR, 'thr'], ['reviews.json', 'r']]),
    },
  });
  assert.deepEqual(plan, []);
});
