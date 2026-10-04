/**
 * BRO-4595 — parseShowListArg: the list-capable `--shows=` / `--show=` filter
 * generate-critic-consensus.js uses so opening-night-poller.yml can dispatch
 * update-critic-consensus.yml ONCE with every polled show instead of once per
 * show (the workflow's concurrency group keeps one pending run and cancelled
 * 56 of 58 per-show dispatches on 2026-10-04).
 *
 * Run: node --test scripts/lib/parse-show-list-arg.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parseShowListArg, describeShowFilter } = require('./parse-show-list-arg.js');

describe('parseShowListArg', () => {
  it('returns null when no filter flag is present (whole-scan mode)', () => {
    assert.equal(parseShowListArg(['--force', '--max-shows=200']), null);
    assert.equal(parseShowListArg([]), null);
    assert.equal(parseShowListArg(undefined), null);
  });

  it('--show=ID keeps working as the one-ID alias (remediation path, task #389)', () => {
    const f = parseShowListArg(['--show=fear-of-13-2025']);
    assert.deepEqual([...f], ['fear-of-13-2025']);
  });

  it('--shows=a,b filters to both ids', () => {
    const f = parseShowListArg(['--shows=queen-of-versailles-2025,ragtime-2025']);
    assert.ok(f.has('queen-of-versailles-2025'));
    assert.ok(f.has('ragtime-2025'));
    assert.equal(f.size, 2);
  });

  it('a comma-separated list is also accepted on the --show alias (workflow passes the input through)', () => {
    const f = parseShowListArg(['--show=a-2025,b-2025']);
    assert.deepEqual([...f].sort(), ['a-2025', 'b-2025']);
  });

  it('trims whitespace, strips quotes, drops empties (trailing / double commas)', () => {
    const f = parseShowListArg(['--shows=" a-2025 ,, b-2025,"']);
    assert.deepEqual([...f].sort(), ['a-2025', 'b-2025']);
  });

  it('repeated or mixed flags union', () => {
    const f = parseShowListArg(['--show=a-2025', '--shows=b-2025,c-2025', '--show=a-2025']);
    assert.deepEqual([...f].sort(), ['a-2025', 'b-2025', 'c-2025']);
  });

  it('a supplied-but-empty filter is an EMPTY Set, never null (no accidental whole scan)', () => {
    const f = parseShowListArg(['--shows=']);
    assert.ok(f instanceof Set);
    assert.equal(f.size, 0);
    assert.equal(parseShowListArg(['--shows=,']).size, 0);
  });

  it('handles the real poller payload size (58 comma-joined ids)', () => {
    const ids = Array.from({ length: 58 }, (_, i) => `show-${i}-2025`);
    const f = parseShowListArg([`--shows=${ids.join(',')}`]);
    assert.equal(f.size, 58);
    assert.ok(f.has('show-57-2025'));
  });
});

describe('describeShowFilter', () => {
  it('null → null; one id → single-show; many → show-list with count', () => {
    assert.equal(describeShowFilter(null), null);
    assert.match(describeShowFilter(new Set(['x-2025'])), /^Single-show mode: x-2025$/);
    assert.match(describeShowFilter(new Set(['a', 'b', 'c'])), /^Show-list mode \(3 shows\): a, b, c$/);
    assert.match(describeShowFilter(new Set()), /empty/);
  });
});
