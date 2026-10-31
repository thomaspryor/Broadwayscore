// BRO-5109: a breakeven or all-in weekly figure must not print as a running "Weekly Cost".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../../src/lib/biz-format.ts', import.meta.url), 'utf8');
const body = src.slice(src.indexOf('export function weeklyCostLabel'));
const weeklyCostLabel = new Function(`${body.replace('export function', 'function').replace(/: string|\?: [^)]*\)/g, (m) => (m.startsWith('?') ? ')' : ''))}; return weeklyCostLabel;`)();

test('labels follow the cost basis', () => {
  assert.equal(weeklyCostLabel('breakeven'), 'Weekly Breakeven');
  assert.equal(weeklyCostLabel('all-in'), 'Weekly Cost (all-in)');
  assert.equal(weeklyCostLabel('running'), 'Weekly Cost');
  assert.equal(weeklyCostLabel(undefined), 'Weekly Cost');
});

test('both /biz surfaces use the helper', () => {
  for (const f of ['../../src/components/BizBuzzCard.tsx', '../../src/components/biz/AllShowsTable.tsx']) {
    assert.match(readFileSync(new URL(f, import.meta.url), 'utf8'), /weeklyCostLabel\(/);
  }
});

test('the public commercial projection keeps the basis (it is a whitelist, so a missing key hides the label)', () => {
  const src = readFileSync(new URL('../../src/lib/commercial-display.ts', import.meta.url), 'utf8');
  const fn = src.slice(src.indexOf('export function toPublicShowCommercial'));
  assert.match(fn.slice(0, 2500), /weeklyRunningCostBasis/);
});
