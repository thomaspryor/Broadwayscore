import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSearchUrl,
  buildFlagUrl,
  findExactFlagMatch,
  buildPatchRequest,
  parseArgs,
  checkRegistryConflict,
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

test('parseArgs defaults to archive (active:false) with no --active flag', () => {
  const { identifier, desiredActive, dryRun } = parseArgs(['gate-cold-start']);
  assert.equal(identifier, 'gate-cold-start');
  assert.equal(desiredActive, false);
  assert.equal(dryRun, false);
});

test('parseArgs accepts --active=true and --dry-run', () => {
  const { identifier, desiredActive, dryRun } = parseArgs(['772232', '--active=true', '--dry-run']);
  assert.equal(identifier, '772232');
  assert.equal(desiredActive, true);
  assert.equal(dryRun, true);
});

test('parseArgs rejects zero or multiple positional identifiers', () => {
  assert.throws(() => parseArgs([]), /Usage:/);
  assert.throws(() => parseArgs(['a', 'b']), /Usage:/);
});

test('parseArgs rejects a malformed --active value instead of silently archiving (e.g. a typo like --active=True)', () => {
  assert.throws(() => parseArgs(['gate-cold-start', '--active=True']), /must be exactly 'true' or 'false'/);
  assert.throws(() => parseArgs(['gate-cold-start', '--active=1']), /must be exactly 'true' or 'false'/);
});

test('parseArgs rejects an unrecognized flag instead of silently ignoring it', () => {
  assert.throws(() => parseArgs(['gate-cold-start', '--dryrun']), /Unrecognized flag/);
});

test('parseArgs rejects --active passed more than once', () => {
  assert.throws(() => parseArgs(['gate-cold-start', '--active=true', '--active=false']), /more than once/);
});

test('checkRegistryConflict warns when the target key is still REGISTERED_FLAGS with a conflicting expected active state', () => {
  const registry = [{ key: 'ticket-single-button', expected: { exists: true, active: true } }];
  const warning = checkRegistryConflict('ticket-single-button', false, registry);
  assert.match(warning, /ticket-single-button.*expecting active:true/);
});

test('checkRegistryConflict is null when desiredActive matches the registry expectation', () => {
  const registry = [{ key: 'ticket-single-button', expected: { exists: true, active: true } }];
  assert.equal(checkRegistryConflict('ticket-single-button', true, registry), null);
});

test('checkRegistryConflict is null when the key has no registry entry', () => {
  assert.equal(checkRegistryConflict('gate-cold-start', false, [{ key: 'ticket-single-button', expected: { exists: true, active: true } }]), null);
});

test('checkRegistryConflict is null for an exists:false entry (deliberately non-live, not a real flag to warn about)', () => {
  const registry = [{ key: 'mobile-gate-timing', expected: { exists: false } }];
  assert.equal(checkRegistryConflict('mobile-gate-timing', false, registry), null);
});

test('checkRegistryConflict returns null (not a nonsensical warning) on a malformed entry missing `expected`', () => {
  const registry = [{ key: 'ticket-single-button' }];
  assert.doesNotThrow(() => checkRegistryConflict('ticket-single-button', false, registry));
  assert.equal(checkRegistryConflict('ticket-single-button', false, registry), null);
});
