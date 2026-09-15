import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSearchUrl,
  buildFlagUrl,
  findExactFlagMatch,
  buildPatchRequest,
} from './posthog-flag-admin-core.js';

test('buildSearchUrl encodes the key into the ?search= query param', () => {
  const url = buildSearchUrl('332742', 'gate-cold-start');
  assert.equal(url, 'https://us.posthog.com/api/projects/332742/feature_flags/?search=gate-cold-start');
});

test('buildSearchUrl percent-encodes special characters in the key', () => {
  const url = buildSearchUrl('332742', 'a flag/with?chars');
  assert.equal(url, 'https://us.posthog.com/api/projects/332742/feature_flags/?search=a%20flag%2Fwith%3Fchars');
});

test('buildFlagUrl targets a single flag by numeric id', () => {
  assert.equal(
    buildFlagUrl('332742', 772232),
    'https://us.posthog.com/api/projects/332742/feature_flags/772232/'
  );
});

test('findExactFlagMatch returns the single exact key match', () => {
  const results = [
    { id: 1, key: 'gate-cold-start-v2' },
    { id: 2, key: 'gate-cold-start' },
  ];
  const { match, ambiguous } = findExactFlagMatch(results, 'gate-cold-start');
  assert.equal(ambiguous, false);
  assert.equal(match.id, 2);
});

test('findExactFlagMatch returns no match when only substring matches exist', () => {
  const results = [{ id: 1, key: 'gate-cold-start-v2' }];
  const { match, ambiguous } = findExactFlagMatch(results, 'gate-cold-start');
  assert.equal(match, null);
  assert.equal(ambiguous, false);
});

test('findExactFlagMatch returns no match on an empty results array', () => {
  const { match, ambiguous } = findExactFlagMatch([], 'gate-cold-start');
  assert.equal(match, null);
  assert.equal(ambiguous, false);
});

test('findExactFlagMatch flags ambiguous when 2+ results share the exact key (never guesses)', () => {
  const results = [
    { id: 1, key: 'gate-cold-start' },
    { id: 2, key: 'gate-cold-start' },
  ];
  const { match, ambiguous, matches } = findExactFlagMatch(results, 'gate-cold-start');
  assert.equal(match, null);
  assert.equal(ambiguous, true);
  assert.equal(matches.length, 2);
});

test('buildPatchRequest builds a PATCH to the flag URL with the active body', () => {
  const req = buildPatchRequest('332742', 772232, false);
  assert.equal(req.url, 'https://us.posthog.com/api/projects/332742/feature_flags/772232/');
  assert.equal(req.method, 'PATCH');
  assert.deepEqual(JSON.parse(req.body), { active: false });
});

test('buildPatchRequest supports re-activating a flag (active: true)', () => {
  const req = buildPatchRequest('332742', 772232, true);
  assert.deepEqual(JSON.parse(req.body), { active: true });
});
