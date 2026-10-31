/**
 * BRO-5502 (owner, 2026-10-16: "so many gaps"): every /biz % Recouped cell
 * says something, run over the real data through the real loader. Logic
 * properties only, so a data change cannot redden it: a row is a recoupment,
 * a reported return, a labelled estimate, a loss phrase or a named reason,
 * and a record holding the analyst's figure shows it unless a recoupment, a
 * reported return or a contradicting final label outranks it.
 * Runs in the tsx batch; skipped when core data is absent (Dependabot runs).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const { hasNoInvestorsToRepay } = createRequire(import.meta.url)('../../scripts/lib/commercial-designations');

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const hasData = ['commercial.json', 'shows.json', 'grosses-history.json'].every((f) => fs.existsSync(path.join(root, 'data', f)));

test('every /biz row says something in % Recouped', { skip: !hasData && 'core data not checked out' }, async () => {
  const { getSeasonsWithCommercialData, getShowsBySeasonWithCommercial, getAllOpenShowsWithCommercial } = await import('../../src/lib/data-commercial.ts');
  const { getRecoupedCellSummary, hasCommercialCard, toPublicShowCommercial } = await import('../../src/lib/commercial-display.ts');
  const records = JSON.parse(fs.readFileSync(path.join(root, 'data', 'commercial.json'), 'utf8')).shows;
  const rows = [...getAllOpenShowsWithCommercial(), ...getSeasonsWithCommercialData().flatMap((s) => getShowsBySeasonWithCommercial(s))];
  assert.ok(rows.length > 50, `expected the biz tables to hold rows, got ${rows.length}`);
  const kinds = {};
  for (const row of rows) {
    const cell = getRecoupedCellSummary(row);
    kinds[cell.kind] = (kinds[cell.kind] || 0) + 1;
    if (cell.kind === 'reason' || cell.kind === 'loss') assert.ok(cell.text && cell.text.trim() && cell.text !== '—', `${row.slug}: empty ${cell.kind} text`);
    if (cell.kind === 'analyst') {
      assert.ok(cell.range[0] >= 0 && cell.range[0] <= cell.range[1], `${row.slug}: bad analyst range ${cell.range}`);
      if (!cell.ours) assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(cell.asOf ?? ''), `${row.slug}: analyst figure without a date`);
    }
    if (cell.kind === 'model') {
      assert.ok(cell.pct.every((v) => v >= 0), `${row.slug}: negative model figure reached the page`);
      // An unrecouped show never prints "100%+" (BRO-5073), closed or running.
      if (row.status === 'closed' || row.status === 'open' || row.status === 'previews') assert.ok(cell.pct.every((v) => v <= 99), `${row.slug}: model range ${cell.pct} reaches 100 on an unrecouped show`);
    }
    if (cell.kind === 'analyst' && cell.range[0] < 100) assert.ok(cell.range[1] <= 99, `${row.slug}: analyst range ${cell.range} reaches 100 on an unrecouped show`);
    // What the table shows, the show page shows too (BRO-5508: a TBD show with only the analyst's figure had no card).
    if (['recouped', 'reported', 'analyst', 'model'].includes(cell.kind) && records[row.slug]) {
      assert.ok(hasCommercialCard(toPublicShowCommercial(records[row.slug])), `${row.slug}: the table shows ${cell.kind} but the show page has no card`);
    }
    // The analyst's figure shows unless something outranks or contradicts it.
    // Closed: an undisclosed outcome (TBD) or an enhancement deal's "Nonprofit" never blocks it; a reported return outranks it.
    const openLabel = row.status !== 'closed' || row.designation === 'TBD' || row.designation === 'Nonprofit';
    if ((row.analystRecoupPct || row.ourEstimateRangePct) && !row.recouped && !hasNoInvestorsToRepay(row) && openLabel && !row.reportedReturn) {
      assert.equal(cell.kind, 'analyst', `${row.slug}: holds the analyst figure but shows ${cell.kind}`);
    }
  }
  assert.ok(kinds.recouped > 0, 'no recouped rows at all: the loader or the rule broke');
});
