import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { screenLooksNoPayload, noPayloadReaperTick, QUARANTINE_LIMIT } = require('./no-payload-reaper.js');

test('screenLooksNoPayload: matches the known auth-dead signatures, case-insensitive', () => {
  assert.equal(screenLooksNoPayload('Not logged in · Please run /login'), true);
  assert.equal(screenLooksNoPayload('NOT LOGGED IN'), true);
  assert.equal(screenLooksNoPayload('please run /login to continue'), true);
  assert.equal(screenLooksNoPayload('Error: Invalid API key'), true);
});

test('screenLooksNoPayload: a normal working pane is never flagged', () => {
  assert.equal(screenLooksNoPayload('│ ctx 42% │ some normal tool output here'), false);
  assert.equal(screenLooksNoPayload(''), false);
  assert.equal(screenLooksNoPayload(null), false);
  assert.equal(screenLooksNoPayload(undefined), false);
});

test('noPayloadReaperTick: first sighting quarantines (count 1), never closes', () => {
  const { toClose, toQuarantine, state } = noPayloadReaperTick(
    [{ ref: 'workspace:1', title: '🤖 dead one', noPayload: true }], {}
  );
  assert.deepEqual(toClose, []);
  assert.equal(toQuarantine.length, 1);
  assert.equal(toQuarantine[0].count, 1);
  assert.deepEqual(state, { 'workspace:1': 1 });
});

test('noPayloadReaperTick: second consecutive sighting is STILL quarantined, not closed (survives 2 empty turns)', () => {
  const { toClose, toQuarantine, state } = noPayloadReaperTick(
    [{ ref: 'workspace:1', title: '🤖 dead one', noPayload: true }], { 'workspace:1': 1 }
  );
  assert.deepEqual(toClose, []);
  assert.equal(toQuarantine.length, 1);
  assert.equal(toQuarantine[0].count, 2);
  assert.deepEqual(state, { 'workspace:1': 2 });
});

test('noPayloadReaperTick: the THIRD consecutive sighting closes it', () => {
  const { toClose, toQuarantine, state } = noPayloadReaperTick(
    [{ ref: 'workspace:1', title: '🤖 dead one', noPayload: true }], { 'workspace:1': QUARANTINE_LIMIT }
  );
  assert.equal(toQuarantine.length, 0);
  assert.equal(toClose.length, 1);
  assert.equal(toClose[0].ref, 'workspace:1');
  assert.deepEqual(state, {}); // dropped, not carried forward once closed
});

test('noPayloadReaperTick: recovery (noPayload:false) clears state instead of decaying', () => {
  const { toClose, toQuarantine, state } = noPayloadReaperTick(
    [{ ref: 'workspace:1', title: '🤖 recovered', noPayload: false }], { 'workspace:1': 1 }
  );
  assert.deepEqual(toClose, []);
  assert.deepEqual(toQuarantine, []);
  assert.deepEqual(state, {});
});

test('noPayloadReaperTick: independent refs never cross-contaminate counts', () => {
  const { toClose, toQuarantine } = noPayloadReaperTick(
    [
      { ref: 'workspace:1', title: '🤖 a', noPayload: true },
      { ref: 'workspace:2', title: '🤖 b', noPayload: true },
    ],
    { 'workspace:1': QUARANTINE_LIMIT, 'workspace:2': 0 }
  );
  assert.equal(toClose.length, 1);
  assert.equal(toClose[0].ref, 'workspace:1');
  assert.equal(toQuarantine.length, 1);
  assert.equal(toQuarantine[0].ref, 'workspace:2');
});
