// BRO-6615: lost nightly pushes. Requires the REAL disqualifier and registry
// (CLAUDE.md §15), so a registry or predicate change fails here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { disqualifyingPath } = require('../../scripts/lib/api-fallback-disqualifier.js');
const registry = require('../../scripts/lib/reconcile-merged-json.js');

test('press-night records are API-fallback safe (press-night-probe run 40983253026 lost 7/7 attempts on this path)', () => {
  assert.equal(disqualifyingPath(['data/audit/press-night/a-few-good-men-2026-2026-10-29.json'], registry), null);
  assert.equal(disqualifyingPath(['data/audit/press-night/the-lives-of-others-west-end-2026-2026-10-29.json'], registry), null);
});

test('other unaudited data/audit paths still disqualify', () => {
  for (const p of [
    'data/audit/press-night-unregistered.json',
    'data/audit/press-night/nested/x.json',
    'data/audit/press-night/notes.txt',
    'data/audit/nobody-registered-me.json',
  ]) {
    assert.equal(disqualifyingPath([p], registry), p, p);
  }
});

test('a press-night record riding with shows.json still disqualifies the whole push', () => {
  assert.equal(disqualifyingPath(['data/audit/press-night/x-2026-10-29.json', 'data/shows.json'], registry), 'data/shows.json');
});
