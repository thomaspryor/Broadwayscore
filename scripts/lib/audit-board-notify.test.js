'use strict';
// BRO-7920: a task-board failure must not fail a closing-date audit after it saved data.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { notifyBoardAfterSave, assertBoardConfigured, missingKeyError } = require('./audit-board-notify');

const NO_DISCORD = { env: {}, log: () => {} };

test('a transient board failure becomes a warning, not a throw', async () => {
  const lines = [];
  const r = await notifyBoardAfterSave(async () => {
    throw new Error('notifyLinear: dedup search failed (exit null): Linear HTTP 429 (rate-limited)');
  }, 'audit-closing-dates', { env: {}, log: l => lines.push(l) });
  assert.equal(r.ok, false);
  assert.equal(r.discord, false);
  assert.match(lines[0], /^::warning::audit-closing-dates: could not file/);
  assert.match(lines[0], /429/);
});

test('a failed card posts the findings to Discord when the webhook is set', async () => {
  const posts = [];
  const r = await notifyBoardAfterSave(async () => { throw new Error('HTTP 429'); }, 'audit-we-closing-dates', {
    summary: '• show-a: stored 2027-01-01, wet says 2027-03-01 (59d)',
    env: { DISCORD_WEBHOOK_ALERTS: 'https://discord.invalid/hook' },
    fetchFn: async (url, init) => { posts.push({ url, body: JSON.parse(init.body) }); return { ok: true }; },
    log: () => {},
  });
  assert.equal(r.discord, true);
  assert.equal(posts.length, 1);
  assert.match(posts[0].body.content, /show-a: stored 2027-01-01/);
});

test('a Discord failure never throws', async () => {
  const r = await notifyBoardAfterSave(async () => { throw new Error('HTTP 429'); }, 'x', {
    env: { DISCORD_WEBHOOK_ALERTS: 'https://discord.invalid/hook' },
    fetchFn: async () => { throw new Error('ECONNRESET'); },
    log: () => {},
  });
  assert.deepEqual([r.ok, r.discord], [false, false]);
});

test('a missing LINEAR_API_KEY still fails the run', async () => {
  await assert.rejects(
    notifyBoardAfterSave(async () => { throw missingKeyError('LINEAR_API_KEY not set'); }, 'x', NO_DISCORD),
    /LINEAR_API_KEY not set/,
  );
});

test('assertBoardConfigured refuses before any write when the key is missing', () => {
  assert.throws(() => assertBoardConfigured({}), /LINEAR_API_KEY not set/);
  assert.doesNotThrow(() => assertBoardConfigured({ LINEAR_API_KEY: 'lin_api_x' }));
});

test('success passes through', async () => {
  let called = 0;
  const r = await notifyBoardAfterSave(async () => { called++; }, 'x', NO_DISCORD);
  assert.deepEqual(r, { ok: true });
  assert.equal(called, 1);
});

// Class guard: every script that saves shows.json and files a board card must
// check the key up front and file the card only through notifyBoardAfterSave.
const scriptsDir = path.join(__dirname, '..');
const guarded = fs.readdirSync(scriptsDir)
  .filter(f => f.endsWith('.js'))
  .filter(f => {
    const src = fs.readFileSync(path.join(scriptsDir, f), 'utf8');
    return /saveShows\(/.test(src) && /function notifyLinear\(/.test(src);
  });

test('the guard finds the closing-date audits', () => {
  assert.ok(guarded.includes('audit-closing-dates.js'));
  assert.ok(guarded.includes('audit-we-closing-dates.js'));
});

for (const file of guarded) {
  test(`${file} checks the key before writing and files the card only through notifyBoardAfterSave`, () => {
    const src = fs.readFileSync(path.join(scriptsDir, file), 'utf8');
    assert.equal((src.match(/await notifyLinear\(/g) || []).length, 0, 'bare await notifyLinear( would fail the push again');
    assert.ok(/notifyBoardAfterSave\(\(\) => notifyLinear\(/.test(src));
    const check = src.indexOf('assertBoardConfigured()');
    assert.ok(check > 0 && check < src.indexOf('saveShows('), 'key check must come before saveShows');
  });
}
