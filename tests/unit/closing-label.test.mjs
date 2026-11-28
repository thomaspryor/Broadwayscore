/**
 * BRO-7252 class guard: a repeatedly extended run must never render "Closes".
 * Owner decision 2026-11-09: Operation Mincemeat (~12 extensions), Rocky Horror
 * and Schmigadoon read "Extended through <date> (Nth extension)"; real
 * announced finals (Buena Vista Social Club, Two Strangers) keep "Closes".
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  formatClosingLabel,
  formatClosingLabelCompact,
  getClosingLabel,
  getClosingExtensionCount,
  isRepeatedlyExtended,
  ordinal,
} from '../../src/lib/closing-label';
import { getShowDateLineSegments, formatDateLineString } from '../../src/lib/show-date-line';

const require = createRequire(import.meta.url);
const { writeClosingDate, recordClosingExtension } = require('../../scripts/lib/closing-date-guard.js');

const ext = (n) => Array.from({ length: n }, (_, i) => ({
  announcedAt: `2026-0${(i % 9) + 1}-01`, from: `2026-0${(i % 9) + 1}-15`, to: `2026-0${(i % 9) + 1}-28`, source: 'press',
}));

test('ordinals', () => {
  assert.deepEqual([1, 2, 3, 4, 11, 12, 13, 21, 22, 112].map(ordinal), ['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd', '112th']);
});

test('no extensions: keeps "Closes" (Buena Vista, Two Strangers)', () => {
  assert.equal(formatClosingLabel({ closingDate: '2027-01-17' }, 'Jan 17, 2027'), 'Closes Jan 17, 2027');
  assert.equal(formatClosingLabel({ closingDate: '2027-01-17', closingExtensions: [] }, 'Jan 17, 2027'), 'Closes Jan 17, 2027');
  assert.equal(getClosingLabel({}, 'x').kind, 'closes');
});

test('REPEATEDLY EXTENDED run never renders "Closes" (Operation Mincemeat, 12th)', () => {
  const label = formatClosingLabel({ closingDate: '2027-07-04', closingExtensions: ext(12) }, 'Jul 4, 2027');
  assert.equal(label, 'Extended through Jul 4, 2027 (12th extension)');
  assert.ok(!/Closes/.test(label));
  assert.ok(!/Closes/.test(formatClosingLabelCompact({ closingExtensionCount: 12 }, 'Jul 4')));
});

test('count-only (serialized card) input behaves the same as the full list', () => {
  assert.equal(getClosingExtensionCount({ closingExtensionCount: 3 }), 3);
  assert.equal(formatClosingLabel({ closingExtensionCount: 3 }, 'Apr 4, 2027'), 'Extended through Apr 4, 2027 (3rd extension)');
  assert.equal(formatClosingLabelCompact({ closingExtensionCount: 2 }, 'Apr 4'), 'Extended through Apr 4 (2nd ext.)');
});

test('first extension also reads "Extended through"; Closing Watch threshold is 2+', () => {
  assert.equal(formatClosingLabel({ closingExtensions: ext(1) }, 'Mar 1, 2027'), 'Extended through Mar 1, 2027 (1st extension)');
  assert.equal(isRepeatedlyExtended({ closingExtensions: ext(1) }), false);
  assert.equal(isRepeatedlyExtended({ closingExtensions: ext(2) }), true);
  assert.equal(isRepeatedlyExtended({ closingExtensionCount: 2 }), true);
  assert.equal(isRepeatedlyExtended(null), false);
});

test('hero date line is unchanged: it keeps "Closes" even for an extended run (owner 2026-11-10)', () => {
  const extended = getShowDateLineSegments({ status: 'open', openingDate: '2025-03-20', closingDate: '2027-07-04', closingExtensionCount: 12 });
  assert.equal(formatDateLineString(extended), 'Opened Mar 20, 2025 · Closes Jul 4, 2027');
  const final = getShowDateLineSegments({ status: 'open', openingDate: '2025-03-19', closingDate: '2027-01-17' });
  assert.equal(formatDateLineString(final), 'Opened Mar 19, 2025 · Closes Jan 17, 2027');
});

test('writer: a later closingDate on an open show records an extension event', () => {
  const show = { id: 'x', status: 'open', closingDate: '2027-04-17' };
  assert.equal(writeClosingDate(show, '2027-07-04', 'press', { todayStr: '2026-11-09', log() {} }), true);
  assert.equal(show.closingDate, '2027-07-04');
  assert.deepEqual(show.closingExtensions, [{ announcedAt: '2026-11-09', from: '2027-04-17', to: '2027-07-04', source: 'press' }]);
});

test('writer: no event for first date, earlier date, same date, closed show, force, or repeat', () => {
  const none = { id: 'a', status: 'open', closingDate: null };
  writeClosingDate(none, '2027-01-01', 's', { log() {} });
  assert.equal(none.closingExtensions, undefined);

  const earlier = { id: 'b', status: 'open', closingDate: '2027-05-01' };
  writeClosingDate(earlier, '2027-04-01', 's', { log() {} });
  assert.equal(earlier.closingExtensions, undefined);

  const same = { id: 'c', status: 'open', closingDate: '2027-05-01' };
  writeClosingDate(same, '2027-05-01', 's', { log() {} });
  assert.equal(same.closingExtensions, undefined);

  const closed = { id: 'd', status: 'closed', closingDate: '2026-05-01' };
  writeClosingDate(closed, '2026-06-01', 's', { log() {} });
  assert.equal(closed.closingExtensions, undefined);

  const forced = { id: 'e', status: 'open', closingDate: '2027-05-01' };
  writeClosingDate(forced, '2027-06-01', 's', { force: true, log() {} });
  assert.equal(forced.closingExtensions, undefined);

  const rep = { id: 'f', status: 'open', closingDate: '2027-05-01', closingExtensions: [{ announcedAt: null, from: '2027-04-01', to: '2027-05-01' }] };
  assert.equal(recordClosingExtension(rep, '2027-05-01', 's'), null);
});

test('writer: human-corrected closingDate is untouched and records nothing', () => {
  const show = { id: 'h', status: 'open', closingDate: '2027-05-01', humanCorrectedClosingDate: true };
  assert.equal(writeClosingDate(show, '2027-09-01', 's', { log() {} }), false);
  assert.equal(show.closingDate, '2027-05-01');
  assert.equal(show.closingExtensions, undefined);
});

// Source scan: every surface must go through closing-label.ts. A raw
// "Closes {date}" literal in src/ is how the bug came back each time a new card was added.
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(tsx?|jsx?)$/.test(name)) out.push(p);
  }
  return out;
}
const RAW_CLOSES = /(?:: 'Closes'\s*\}\s*\{|\bcloses\s*\{|`Closes \$\{|>\s*Closes\s*\{|·\s*Closes\s*\{|['"]Closes ['"]\s*\+|\}\s*Closes\s*\{)/;
const ALLOWED = new Set([
  'src/lib/closing-label.ts',
  // The show-page hero line is deliberately unchanged (owner 2026-11-10): the label lives on /biz and the below-fold facts.
  'src/lib/show-date-line.ts',
  'src/app/test/visual-fixture/page.tsx', // static fixture with a literal date
]);

test('class guard: no component renders a raw "Closes <date>" outside closing-label.ts', () => {
  const offenders = [];
  for (const file of walk('src')) {
    if (ALLOWED.has(file)) continue;
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((l, i) => { if (RAW_CLOSES.test(l)) offenders.push(`${file}:${i + 1}: ${l.trim().slice(0, 120)}`); });
  }
  assert.deepEqual(offenders, [], 'Use formatClosingLabel from @/lib/closing-label (BRO-7252)');
});

test('writer keeps the stored count ahead of the list (13th extension reads 13th)', () => {
  const show = { id: 'x', status: 'open', closingDate: '2027-07-04', closingExtensionCount: 12,
    closingExtensions: [{ announcedAt: '2026-11-02', from: '2027-04-25', to: '2027-07-04', source: 's' }] };
  writeClosingDate(show, '2027-09-05', 'test', { todayStr: '2026-12-01' });
  assert.equal(show.closingExtensionCount, 13);
  assert.equal(getClosingExtensionCount(show), 13);
  assert.ok(/13th extension/.test(formatClosingLabel(show, 'Sep 5, 2027')));
});

test('correction writers opt out: recordExtension:false appends nothing', () => {
  const show = { id: 'y', status: 'open', closingDate: '2027-01-17' };
  writeClosingDate(show, '2027-02-01', 'IBDB enrichment', { recordExtension: false });
  assert.equal(show.closingExtensions, undefined);
  assert.equal(show.closingDate, '2027-02-01');
});

test('class guard: /biz closing surfaces go through closing-label (BRO-7252)', async () => {
  const { readFileSync } = await import('node:fs');
  for (const f of ['src/components/biz/AllShowsTable.tsx', 'src/components/biz/AtRiskCard.tsx', 'src/components/BizBuzzCard.tsx']) {
    assert.match(readFileSync(f, 'utf8'), /getClosingLabel/, `${f} must render closing text via getClosingLabel`);
  }
});
