// BRO-5767: the morning digest's "cards landed in the last 24h" split by Codex vs Claude.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { landedLaneLine } = require('../send-morning-digest.js');

test('counts distinct cards per lane from origin/main log', () => {
  const log = [
    'Codex runner\tBRO-1: fix a',
    'Codex runner\tBRO-1: fix a follow-up',
    'Codex runner\tBRO-2: fix b',
    'Claude\tBRO-3: thing',
    'thomaspryor\tBRO-4: owner commit',
    'github-actions[bot]\thealth: Record test success',
  ].join('\n');
  const calls = [];
  const line = landedLaneLine({ run: (args) => { calls.push(args[0]); return args[0] === 'log' ? log : ''; } });
  assert.equal(line, 'Cards landed in the last 24h: Codex 2, Claude 1.');
  assert.deepEqual(calls, ['fetch', 'log']);
});

test('a failed fetch still counts from the last fetched origin/main', () => {
  const line = landedLaneLine({ run: (args) => { if (args[0] === 'fetch') throw new Error('offline'); return 'Claude\tBRO-9: x'; } });
  assert.equal(line, 'Cards landed in the last 24h: Codex 0, Claude 1.');
});

test('a failed log read says so instead of throwing', () => {
  const line = landedLaneLine({ run: (args) => { if (args[0] === 'log') throw new Error('bad revision origin/main'); return ''; } });
  assert.match(line, /could not be counted \(bad revision origin\/main\)/);
});
