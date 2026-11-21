import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parseArgs } = require('../../scripts/lib/cli-args.js');
const { parseArgs: nextParse } = require('../../scripts/linear-next.js');
const { parseArgs: sessionParse } = require('../../scripts/linear-session.js');
const { parseArgs: drainParse } = require('../../scripts/linear-drain-parked.js');

// BRO-2628 / BRO-2630: one parser for the Linear CLIs.

test('equals form, space form, bare switch and positionals', () => {
  assert.deepEqual(parseArgs(['--a=1', '--b', 'two', 'pos', '--d']), { _: ['pos'], a: '1', b: 'two', d: true });
});

test('space form consumes the next non-flag token', () => {
  assert.deepEqual(parseArgs(['--c', 'pos']), { _: [], c: 'pos' });
  assert.deepEqual(parseArgs(['first', '--c']), { _: ['first'], c: true });
});

test('coercion is off unless asked for', () => {
  assert.equal(parseArgs(['--force=0']).force, '0');
});

test('coerceBooleans turns off-values into false for switches only', () => {
  const opts = { coerceBooleans: true, textFlags: ['model'] };
  for (const v of ['', '0', 'false', 'FALSE']) assert.equal(parseArgs([`--force=${v}`], opts).force, false, v);
  assert.equal(parseArgs(['--force=yes'], opts).force, 'yes');
  assert.equal(parseArgs(['--model=0'], opts).model, '0');
  assert.equal(parseArgs(['--brand-new-switch=false'], opts)['brand-new-switch'], false);
});

test('linear-next: --force=0 is off, free-text flags keep their value', () => {
  assert.equal(nextParse(['--force=0']).force, false);
  assert.equal(nextParse(['--dry-run=false'])['dry-run'], false);
  assert.equal(nextParse(['--id=BRO-0']).id, 'BRO-0');
  assert.equal(nextParse(['--model=opus']).model, 'opus');
  assert.equal(nextParse(['--allow-reported-work=false'])['allow-reported-work'], 'false');
});

test('linear-session: --force reason strings are never coerced', () => {
  assert.equal(sessionParse(['--force=0']).force, '0');
  assert.equal(sessionParse(['--issue=BRO-1', '--status', 'paused']).issue, 'BRO-1');
});

test('linear-drain-parked: --cap=5 sets cap (was silently ignored)', () => {
  const a = drainParse(['--cap=5']);
  assert.equal(a.cap, '5');
  assert.equal('cap=5' in a, false);
  assert.equal(drainParse(['--cap', '7']).cap, '7');
  assert.equal(drainParse(['--dry-run=0'])['dry-run'], false);
});

test('linear-session: --help as the first argument prints usage instead of "Unknown command"', async () => {
  const { main } = require('../../scripts/linear-session.js');
  const logs = [];
  const orig = console.log;
  console.log = (m) => logs.push(String(m));
  try { await main(['--help']); } finally { console.log = orig; }
  assert.match(logs.join('\n'), /Usage/);
});
