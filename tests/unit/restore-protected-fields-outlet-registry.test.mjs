// Pins reconcileOutletRegistry() — the belt-and-braces path for task #989
// (outlet-registry lost-update). The primary fix excludes untouched
// dual-tracked core files from staging entirely (core-data-public-stage-
// exclusions.test.mjs); this covers the case where a registry-touching
// commit genuinely conflicts and reaches push-with-retry.sh's rebase path,
// where restore_protected_fields() already runs for every *.json diff but
// didn't know outlet-registry.json's { outlets: { id: {} } } shape.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { reconcileOutletRegistry } = require('../../scripts/lib/restore-protected-fields.js');

test('restores multiAuthor dropped locally but present on remote — the incident case', () => {
  const local = { outlets: { 'plays-international': { displayName: 'Plays International', tier: 3 } } };
  const remote = { outlets: { 'plays-international': { displayName: 'Plays International', tier: 3, multiAuthor: true } } };

  const { modified, notes } = reconcileOutletRegistry(local, remote);
  assert.equal(modified, true);
  assert.equal(local.outlets['plays-international'].multiAuthor, true);
  assert.ok(notes.some((n) => n.includes('multiAuthor')));
});

test('restores defaultCritic dropped locally but present on remote', () => {
  const local = { outlets: { 'jks-theatre-scene': {} } };
  const remote = { outlets: { 'jks-theatre-scene': { defaultCritic: 'Jeff Kyler' } } };

  const { modified } = reconcileOutletRegistry(local, remote);
  assert.equal(modified, true);
  assert.equal(local.outlets['jks-theatre-scene'].defaultCritic, 'Jeff Kyler');
});

test('never overrides an explicit local scalar value with remote', () => {
  const local = { outlets: { foo: { multiAuthor: false } } };
  const remote = { outlets: { foo: { multiAuthor: true } } };

  const { modified } = reconcileOutletRegistry(local, remote);
  assert.equal(modified, false);
  assert.equal(local.outlets.foo.multiAuthor, false);
});

test('unions aliases from both sides instead of overwriting', () => {
  const local = { outlets: { foo: { aliases: ['foo', 'foo-alt'] } } };
  const remote = { outlets: { foo: { aliases: ['foo', 'foo-remote-alias'] } } };

  const { modified, notes } = reconcileOutletRegistry(local, remote);
  assert.equal(modified, true);
  assert.deepEqual(local.outlets.foo.aliases, ['foo', 'foo-alt', 'foo-remote-alias']);
  assert.ok(notes.some((n) => n.includes('alias')));
});

test('no-op when local already matches remote', () => {
  const local = { outlets: { foo: { multiAuthor: true, aliases: ['foo'] } } };
  const remote = { outlets: { foo: { multiAuthor: true, aliases: ['foo'] } } };

  const { modified, notes } = reconcileOutletRegistry(local, remote);
  assert.equal(modified, false);
  assert.deepEqual(notes, []);
});

test('skips outlets that only exist on one side', () => {
  const local = { outlets: { 'local-only': { tier: 3 } } };
  const remote = { outlets: { 'remote-only': { multiAuthor: true } } };

  const { modified } = reconcileOutletRegistry(local, remote);
  assert.equal(modified, false);
  assert.equal(local.outlets['local-only'].multiAuthor, undefined);
});

test('fails open on malformed input (missing outlets key)', () => {
  assert.deepEqual(reconcileOutletRegistry({}, {}), { modified: false, notes: [] });
  assert.deepEqual(reconcileOutletRegistry(null, { outlets: {} }), { modified: false, notes: [] });
  assert.deepEqual(reconcileOutletRegistry({ outlets: {} }, null), { modified: false, notes: [] });
});
