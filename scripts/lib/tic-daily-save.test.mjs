// BRO-8054: a refused or failed shows.json save must not drop a whole TIC batch, and a transient
// failure must not be remembered as a final refusal (reviewers found both in the first version).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { saveAddedShows } = require('./tic-daily.js');

const setup = () => {
  const doc = { shows: [{ id: 'old' }, { id: 'a' }, { id: 'b' }, { id: 'c' }] };
  const added = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  const nextSeen = {
    1: { reason: 'added', id: 'a', retry: false, on: 'd' },
    2: { reason: 'added', id: 'b', retry: false, on: 'd' },
    3: { reason: 'added', id: 'c', retry: false, on: 'd' },
    9: { reason: 'virtual', retry: false, on: 'd' },
  };
  return { doc, added, nextSeen };
};
const ids = (doc) => doc.shows.map((s) => s.id);

test('a clean batch save returns every entry and leaves seen alone', () => {
  const { doc, added, nextSeen } = setup();
  const out = saveAddedShows(doc, added, { save: () => {}, nextSeen, today: 'T' });
  assert.deepEqual(out.map((a) => a.id), ['a', 'b', 'c']);
  assert.equal(nextSeen[2].reason, 'added');
});

test('one duplicate refusal blocks only its own row; the others still land', () => {
  const { doc, added, nextSeen } = setup();
  const save = (d) => { if (d.shows.some((s) => s.id === 'b')) throw new Error('shows-write-guard: refusing to write 1 new duplicate show row(s)\n  - b'); };
  const out = saveAddedShows(doc, added, { save, nextSeen, today: 'T' });
  assert.deepEqual(out.map((a) => a.id), ['a', 'c']);
  assert.deepEqual(ids(doc), ['old', 'a', 'c']);
  assert.equal(nextSeen[2].retry, false);
  assert.match(nextSeen[2].reason, /^write-refused:.*duplicate/);
  assert.equal(nextSeen[1].reason, 'added');
  assert.equal(nextSeen[9].reason, 'virtual', 'unrelated entries untouched');
});

test('RED-THEN-GREEN: a transient failure is retried tomorrow, never stored as a final refusal', () => {
  const { doc, added, nextSeen } = setup();
  const save = () => { throw new Error('timed out after 30000ms waiting for lock'); };
  const out = saveAddedShows(doc, added, { save, nextSeen, today: 'T' });
  assert.deepEqual(out, []);
  assert.deepEqual(ids(doc), ['old']);
  assert.deepEqual(Object.keys(nextSeen), ['9'], 'added entries forgotten so pickCandidates sees them again');
});

test('the log names each row that did not land', () => {
  const { doc, added, nextSeen } = setup();
  const lines = [];
  saveAddedShows(doc, added, { save: () => { throw new Error('boom'); }, nextSeen, today: 'T', log: (m) => lines.push(m) });
  assert.equal(lines.length, 3);
  assert.match(lines[0], /id a: .*will retry.*boom/);
});
