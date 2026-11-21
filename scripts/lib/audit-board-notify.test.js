'use strict';
// BRO-7920: a task-board failure must not fail a closing-date audit after it saved data.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { notifyBoardAfterSave, missingKeyError } = require('./audit-board-notify');

test('a transient board failure becomes a warning, not a throw', async () => {
  const lines = [];
  const r = await notifyBoardAfterSave(async () => {
    throw new Error('notifyLinear: dedup search failed (exit null): Linear HTTP 429 (rate-limited)');
  }, 'audit-closing-dates', l => lines.push(l));
  assert.equal(r.ok, false);
  assert.match(lines[0], /^::warning::audit-closing-dates: could not file/);
  assert.match(lines[0], /429/);
});

test('a missing LINEAR_API_KEY still fails the run', async () => {
  await assert.rejects(
    notifyBoardAfterSave(async () => { throw missingKeyError('LINEAR_API_KEY not set'); }, 'x', () => {}),
    /LINEAR_API_KEY not set/,
  );
});

test('success passes through', async () => {
  let called = 0;
  const r = await notifyBoardAfterSave(async () => { called++; }, 'x', () => {});
  assert.deepEqual(r, { ok: true });
  assert.equal(called, 1);
});

// Class guard: an audit that saves shows.json must not await the board call bare.
for (const file of ['audit-closing-dates.js', 'audit-we-closing-dates.js']) {
  test(`${file} files the board card only through notifyBoardAfterSave`, () => {
    const src = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    assert.ok(/saveShows\(/.test(src), 'still saves shows.json (guard premise)');
    assert.equal((src.match(/await notifyLinear\(/g) || []).length, 0, 'bare await notifyLinear( would fail the push again');
    assert.ok(/notifyBoardAfterSave\(\(\) => notifyLinear\(/.test(src));
  });
}
