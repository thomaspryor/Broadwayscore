/**
 * BRO-4960: --prune-only drops a Critics' Take whose show has too few live
 * reviews (and orphans) without an LLM call, and keeps the MAX_STALE_PRUNE cap.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { pruneConsensusEntries, MAX_STALE_PRUNE } = require('../../scripts/lib/critic-consensus-eligibility.js');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

describe('pruneConsensusEntries', () => {
  test('removes entries below the live-review floor, keeps healthy ones', () => {
    const shows = { dead: { x: 1 }, live: { x: 2 } };
    const counts = new Map([['live', 5]]);
    const r = pruneConsensusEntries(shows, counts);
    assert.deepStrictEqual(r.stale, ['dead']);
    assert.deepStrictEqual(Object.keys(shows), ['live']);
    assert.strictEqual(r.capped, false);
  });

  test('removes orphans only when show ids are supplied', () => {
    const counts = new Map([['a', 5], ['gone', 5]]);
    const keep = { a: {}, gone: {} };
    pruneConsensusEntries(keep, counts);
    assert.deepStrictEqual(Object.keys(keep).sort(), ['a', 'gone']);
    const pruned = { a: {}, gone: {} };
    const r = pruneConsensusEntries(pruned, counts, new Set(['a']));
    assert.deepStrictEqual(r.orphans, ['gone']);
    assert.deepStrictEqual(Object.keys(pruned), ['a']);
  });

  test('deletes nothing above the cap (truncated reviews.json)', () => {
    const shows = {};
    for (let i = 0; i <= MAX_STALE_PRUNE; i++) shows[`s${i}`] = {};
    const r = pruneConsensusEntries(shows, new Map());
    assert.strictEqual(r.capped, true);
    assert.strictEqual(Object.keys(shows).length, MAX_STALE_PRUNE + 1);
  });
});

test('generator accepts --prune-only without ANTHROPIC_API_KEY', { skip: !fs.existsSync(path.join(ROOT, 'data', 'shows.json')) && 'core data absent' }, () => {
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  const out = execFileSync('node', ['scripts/generate-critic-consensus.js', '--prune-only', '--show=__no-such-show__'], { cwd: ROOT, env, encoding: 'utf-8' });
  assert.match(out, /Nothing to prune|Pruned \d+ stale/);
});
