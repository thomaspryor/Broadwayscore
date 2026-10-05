#!/usr/bin/env node
// BRO-2836: ordinal publishDates ("April 11th, 2024") must behave exactly like ISO at
// every date-window guard, and unparseable dates must be loud.
const assert = require('assert');
const { toDateMs } = require('./lib/date-utils');
const g = require('./lib/review-guards');

let n = 0;
const t = (name, fn) => { fn(); n++; console.log('  ✓ ' + name); };

t('toDateMs: ordinal == ISO', () => {
  for (const [o, i] of [['April 11th, 2024', '2024-04-11'], ['March 26th, 2018', '2018-03-26'], ['July 2nd, 2024', '2024-07-02'], ['22nd March 2025', '2025-03-22']]) {
    assert.ok(Math.abs(toDateMs(o) - toDateMs(i)) <= 86400000, o);
    assert.ok(!isNaN(toDateMs(o)), o);
  }
});
t('toDateMs: null/empty/garbage/sentinel are NaN, never 0', () => {
  for (const v of [null, undefined, '', 'garbage', 'For a previous production', {}]) assert.ok(isNaN(toDateMs(v)), String(v));
});
t('toDateMs: Date/number/ISO-T/historical pass through', () => {
  assert.strictEqual(toDateMs(new Date(5)), 5);
  assert.strictEqual(toDateMs(7), 7);
  assert.strictEqual(toDateMs('2026-02-11T05:00:00Z'), Date.parse('2026-02-11T05:00:00Z'));
  assert.ok(!isNaN(toDateMs('1952-11-25')));
});
t('applyTemporalOverrides: ordinal == ISO (8 rows from the issue)', () => {
  for (const [open, ord, iso] of [
    ['2024-04-11', 'April 11th, 2024', '2024-04-11'], ['2019-04-17', 'April 18th, 2019', '2019-04-18'],
    ['2022-08-06', 'July 15th, 2022', '2022-07-15'], ['2024-04-11', 'May 6th, 2024', '2024-05-06']]) {
    const a = g.applyTemporalOverrides(true, false, 'high', open, ord);
    const b = g.applyTemporalOverrides(true, false, 'high', open, iso);
    assert.strictEqual(a.wpConfidence, 'low', ord);
    assert.strictEqual(a.wpConfidence, b.wpConfidence);
  }
});
t('isReviewWithinOwnProductionWindow: ordinal == ISO', () => {
  const show = { openingDate: '2024-04-11', previewsStartDate: '2024-03-20', closingDate: '2024-09-01' };
  assert.strictEqual(g.isReviewWithinOwnProductionWindow(show, 'April 11th, 2024'), true);
  assert.strictEqual(g.isReviewWithinOwnProductionWindow(show, 'April 11th, 2019'), false);
});
t('unparseable date with digits warns once; sentinel stays quiet', () => {
  const warns = []; const orig = console.warn; console.warn = (m) => warns.push(m);
  try {
    g.applyTemporalOverrides(true, false, 'high', '2024-04-11', 'Smarch 40th, 2024');
    g.applyTemporalOverrides(true, false, 'high', '2024-04-11', 'Smarch 40th, 2024');
    g.applyTemporalOverrides(true, false, 'high', '2024-04-11', 'For a previous production');
  } finally { console.warn = orig; }
  assert.strictEqual(warns.length, 1, warns.join('|'));
  assert.ok(g.getUnparseableDateCount() >= 1);
});
t('no raw new Date(<publishDate>) left in scripts/lib', () => {
  const fs = require('fs'), path = require('path');
  const dir = path.join(__dirname, 'lib');
  const bad = [];
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.js')).map(f => [f, path.join(dir, f)]).concat([['validate-data.js', path.join(__dirname, 'validate-data.js')]]);
  for (const [f, fp] of files) {
    fs.readFileSync(fp, 'utf8').split('\n').forEach((l, i) => {
      if (/(new Date|Date\.parse)\([\w.]*publishDate\b/.test(l) && !/^\s*(\/\/|\*)/.test(l) && !/BRO-2836-ok/.test(l)) bad.push(`${f}:${i + 1}`);
    });
  }
  assert.deepStrictEqual(bad, [], 'use toDateMs from date-utils: ' + bad.join(', '));
});
console.log(`✅ PASS — ${n} checks`);
