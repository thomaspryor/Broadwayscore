/**
 * verify-bro-4724-recheck.test.mjs — RECHECK-AFTER acceptance for BRO-4724
 * (first WRITE run of create-tour-entries.js, scrape-new-aggregators.yml on
 * 2026-10-06, then fetch-tour-schedules at 07:47 UTC on 2026-10-07). Asserts
 * against LIVE data, not fixtures: run by scripts/autonomous-acceptance-recheck.js
 * once those crons have acted. A red run means the pipeline did not create or
 * pick up the tours, not a code regression.
 *
 * timebomb-audit-exempt: dated RECHECK-AFTER probe of live cron output; the assertions are pinned to real 2026-10 run dates a shifted clock cannot simulate.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
// land.js runs every changed *.test.mjs, so the cron-dependent checks skip
// until the morning after the first write run.
const NO_DATA = fs.existsSync(path.join(ROOT, 'data', 'shows.json')) ? false : 'no core-data checkout here';
const PENDING = NO_DATA || Date.now() < Date.parse('2026-10-07T09:00:00Z')
  ? 'waits for the 2026-10-06 auto-create write run and the 2026-10-07 schedule fetch' : false;

const tours = () => readJson('data/shows.json').shows.filter(s => s.category === 'tour');
const audit = () => readJson('data/audit/tour-autocreate.json');

test('the weekly auto-create ran in write mode after landing', { skip: PENDING }, () => {
  const a = audit();
  assert.equal(a.mode, 'write', `last run was ${a.mode} (TOUR_AUTOCREATE not write?)`);
  assert.ok(a.generatedAt >= '2026-10-06', `last report ${a.generatedAt}`);
  assert.ok(a.discovery && !a.discovery.error, `discovery failed: ${a.discovery && a.discovery.error}`);
});

test('every tour it created is a sane, dated tour entry', { skip: PENDING }, () => {
  const byId = new Map(tours().map(s => [s.id, s]));
  for (const id of audit().created || []) {
    const s = byId.get(id);
    assert.ok(s, `${id} reported created but not in shows.json`);
    assert.ok(['upcoming', 'open', 'previews'].includes(s.status), `${id}: status ${s.status}`);
    assert.match(String(s.openingDate || ''), /^\d{4}-\d{2}-\d{2}/, `${id}: no openingDate`);
    assert.ok(s.title, `${id}: no title`);
  }
});

test('the schedule fetch picked every created tour up', { skip: PENDING }, () => {
  const sched = readJson('data/tour-schedules.json').tours || {};
  const missing = (audit().created || []).filter(id => !(sched[id] && (sched[id].stops || []).length));
  assert.deepEqual(missing, [], 'created tours with no stops in tour-schedules.json');
});

test('no title has two tours over the same dates', { skip: PENDING }, () => {
  const live = tours().filter(s => s.status !== 'closed' && s.openingDate);
  const byTitle = new Map();
  for (const s of live) {
    const k = String(s.title).trim().toLowerCase();
    byTitle.set(k, [...(byTitle.get(k) || []), s]);
  }
  const dupes = [];
  for (const [title, list] of byTitle) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const [a, b] = [list[i], list[j]].sort((x, y) => x.openingDate.localeCompare(y.openingDate));
        // Overlap: the later launch comes before the earlier one ends.
        if (!a.closingDate || b.openingDate <= a.closingDate) dupes.push(`${title}: ${a.id} + ${b.id}`);
      }
    }
  }
  // Two companies at once are real but rare (route-tour-candidates.js asks
  // the owner); anything here needs a look either way.
  assert.deepEqual(dupes, [], 'overlapping tours of one title');
});
