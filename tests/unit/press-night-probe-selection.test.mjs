// BRO-6658: every press night in a market's window must reach a probe record. The Lives of Others
// (West End, only trusted source theatremonkey, no reviewEmbargoAt) was selected and dispatched at
// 22:38Z, but both record pushes were lost, so the morning grade read "the overnight check did not run".
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { selectOpeningNightShows } = require('../../scripts/lib/opening-night-selection.js');
const { probeDue } = require('../../scripts/lib/press-night-record.js');
const { findEntry } = require('../../scripts/lib/core-data-merge-registry.js');

const lives = {
  id: 'the-lives-of-others-west-end-2026',
  category: 'west-end',
  status: 'open',
  openingDate: '2026-10-29',
  previewsStartDate: '2026-10-14',
  openingDateSource: 'theatremonkey',
};
const EMBARGO = '2026-10-29T21:00:00.000Z'; // West End market default, 21:00 UK (GMT)
const at = (iso) => Date.parse(iso);

test('west-end show with only a theatremonkey source and no reviewEmbargoAt is selected for the market', () => {
  const now = new Date('2026-10-29T22:37:53Z');
  assert.deepEqual(selectOpeningNightShows([lives], { market: 'west-end', now }).map((s) => s.id), [lives.id]);
});

test('same show still in previews on its press night is selected too (trusted source)', () => {
  const now = new Date('2026-10-29T22:37:53Z');
  const s = { ...lives, status: 'previews' };
  assert.equal(selectOpeningNightShows([s], { market: 'west-end', now }).length, 1);
});

test('probeDue gives it a record target on the market-default embargo, across the evening crons', () => {
  const want = { showId: lives.id, night: '2026-10-29', market: 'west-end', embargoAt: EMBARGO };
  for (const t of ['2026-10-29T18:35:00Z', '2026-10-29T20:00:00Z', '2026-10-29T22:37:53Z', '2026-10-29T23:41:24Z', '2026-10-30T00:00:00Z']) {
    assert.deepEqual(probeDue(lives, at(t)), want, t);
  }
});

test('probeDue is null outside the start window, so the orchestrator cannot start it on the wrong night', () => {
  assert.equal(probeDue(lives, at('2026-10-29T18:00:00Z')), null);
  assert.equal(probeDue(lives, at('2026-10-30T00:30:00Z')), null);
});

test('every press-night market the orchestrator selects gets a due target (no category is silently skipped)', () => {
  for (const category of ['broadway', 'off-broadway', 'west-end', 'off-west-end']) {
    const s = { id: `x-${category}`, category, status: 'open', openingDate: '2026-10-29', openingDateSource: 'playbill' };
    const due = probeDue(s, at('2026-10-30T00:00:00Z'));
    assert.ok(due, `${category} has no probe target`);
    assert.equal(due.night, '2026-10-29');
  }
});

test('the record file is registered for the Git Data API push fallback (its pushes were lost 7/7 on 2026-10-29)', () => {
  const entry = findEntry('audit/press-night/the-lives-of-others-west-end-2026-2026-10-29.json');
  assert.ok(entry, 'data/audit/press-night/*.json missing from core-data-merge-registry');
  assert.equal(entry.apiFallbackSafe, true);
});
