import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { getRunAgeLabel } from '../../src/lib/date-utils.ts';

describe('getRunAgeLabel West End', () => {
  const we = (open, today) => getRunAgeLabel(open, 'west-end', today);
  test('opening day', () => assert.equal(we('2026-10-02', '2026-10-02'), 'Opened today'));
  test('yesterday', () => assert.equal(we('2026-10-01', '2026-10-02'), 'Opened yesterday'));
  test('10 days ago shows the date, UK style, no "in London" (the reported "1 month" case)', () =>
    assert.equal(we('2026-09-22', '2026-10-02'), 'Opened 22 Sep'));
  test('day 13 still shows the date', () => assert.equal(we('2026-09-19', '2026-10-02'), 'Opened 19 Sep'));
  test('day 14 switches to month + year', () => assert.equal(we('2026-09-18', '2026-10-02'), 'Opened Sep 2026'));
  test('months ago', () => assert.equal(we('2026-03-12', '2026-10-02'), 'Opened Mar 2026'));
  test('364 days is still month + year', () => assert.equal(we('2025-10-03', '2026-10-02'), 'Opened Oct 2025'));
  test('365 days is a year', () => assert.equal(we('2025-10-02', '2026-10-02'), 'Since 2025'));
  test('a year or more', () => assert.equal(we('2019-06-20', '2026-10-02'), 'Since 2019'));
  test('month rollover across a year boundary', () => assert.equal(we('2025-12-28', '2026-01-03'), 'Opened 28 Dec'));
  test('future is null', () => assert.equal(we('2026-11-01', '2026-10-02'), null));
  test('null is null', () => assert.equal(we(null, '2026-10-02'), null));
  test('invalid date is null', () => assert.equal(we('soon', '2026-10-02'), null));
  test('off-west-end behaves the same', () =>
    assert.equal(getRunAgeLabel('2026-09-22', 'off-west-end', '2026-10-02'), 'Opened 22 Sep'));
});

describe('getRunAgeLabel other markets keep the suffix', () => {
  test('broadway', () => assert.match(getRunAgeLabel('2015-03-01', 'broadway'), /on Broadway$/));
  test('off-broadway', () => assert.match(getRunAgeLabel('2015-03-01', 'off-broadway'), /Off-Broadway$/));
  test('default category is broadway', () => assert.match(getRunAgeLabel('2015-03-01'), /on Broadway$/));
  test('suffix override (opera) wins over the market suffix', () =>
    assert.match(getRunAgeLabel('2015-03-01', 'broadway', undefined, 'at the Met'), /at the Met$/));
  test('future opening is null', () => assert.equal(getRunAgeLabel('2999-01-01', 'broadway'), null));
});
