import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const d = require('./backup-drill.js');

const NOW = new Date('2026-10-22T12:00:00Z');
const weekly = (date, files = d.WEEKLY_FILES) => files.map((f) => `2026-10-18 06:10:00 1234 weekly/${date}/${f}`).join('\n');
const daily = (date, run, files = d.DAILY_FILES) => files.map((f) => `2026-10-21 05:30:00 99 daily/${date}/run-${run}/${f}`).join('\n');

test('pickLatestSet: newest complete weekly set wins, partial newer set skipped', () => {
  const listing = [weekly('2026-10-18'), weekly('2026-10-11'), weekly('2026-10-19', ['MANIFEST.sha256'])].join('\n');
  assert.equal(d.pickLatestSet('weekly', listing, NOW).prefix, 'weekly/2026-10-18');
});
test('pickLatestSet: daily picks highest run id on the newest date', () => {
  const listing = [daily('2026-10-21', 100), daily('2026-10-21', 250), daily('2026-10-20', 999)].join('\n');
  assert.equal(d.pickLatestSet('daily', listing, NOW).prefix, 'daily/2026-10-21/run-250');
});
test('pickLatestSet: per-run weekly folders (BRO-6132 bucket lock) and re-run attempts', () => {
  const runWeekly = (date, run) => d.WEEKLY_FILES.map((f) => `x 1 1 weekly/${date}/${run}/${f}`).join('\n');
  // A legacy flat set and a per-run set on the same date: the run folder wins.
  let listing = [weekly('2026-10-18'), runWeekly('2026-10-18', 'run-500')].join('\n');
  assert.equal(d.pickLatestSet('weekly', listing, NOW).prefix, 'weekly/2026-10-18/run-500');
  // A re-run attempt beats attempt 1 of the same run, and a partial attempt is skipped.
  listing = [runWeekly('2026-10-18', 'run-500-1'), runWeekly('2026-10-18', 'run-500-2'),
    'x 1 1 weekly/2026-10-18/run-500-3/MANIFEST.sha256'].join('\n');
  assert.equal(d.pickLatestSet('weekly', listing, NOW).prefix, 'weekly/2026-10-18/run-500-2');
  listing = [daily('2026-10-21', 250), daily('2026-10-21', '250-2')].join('\n');
  assert.equal(d.pickLatestSet('daily', listing, NOW).prefix, 'daily/2026-10-21/run-250-2');
});
test('pickLatestSet: stale newest set fails loudly', () => {
  assert.throws(() => d.pickLatestSet('weekly', weekly('2026-09-20'), NOW), /backups have stopped/);
  assert.throws(() => d.pickLatestSet('daily', daily('2026-10-10', 1), NOW), /days old/);
});
test('pickLatestSet: no complete set / unknown kind throw', () => {
  assert.throws(() => d.pickLatestSet('weekly', weekly('2026-10-18', ['MANIFEST.sha256']), NOW), /no complete weekly/);
  assert.throws(() => d.pickLatestSet('monthly', '', NOW), /unknown kind/);
});

function makeExport({ rows = 3, manifestRows = 3, auth = 2, manifestAuth = 2 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drill-test-'));
  fs.mkdirSync(path.join(dir, 'tables'));
  fs.writeFileSync(path.join(dir, 'tables', 'lists.ndjson'), Array.from({ length: rows }, (_, i) => JSON.stringify({ id: i })).join('\n') + (rows ? '\n' : ''));
  fs.writeFileSync(path.join(dir, 'auth_users.ndjson'), Array.from({ length: auth }, (_, i) => JSON.stringify({ id: `u${i}` })).join('\n') + (auth ? '\n' : ''));
  fs.writeFileSync(path.join(dir, 'BACKUP_MANIFEST.json'), JSON.stringify({ tables: { lists: { rows: manifestRows, pk: ['id'] } }, auth_users: manifestAuth }));
  return dir;
}
test('recountExport: matching export has no problems and returns counts only', () => {
  const dir = makeExport();
  const r = d.recountExport(dir, path.join(dir, 'BACKUP_MANIFEST.json'));
  assert.deepEqual(r.problems, []);
  assert.deepEqual(r.counts, { lists: 3, auth_users: 2 });
});
test('recountExport: truncated table, empty auth and manifest drift are all reported', () => {
  assert.match(d.recountExport(makeExport({ rows: 2 })).problems.join(), /lists: file has 2 rows, manifest says 3/);
  assert.match(d.recountExport(makeExport({ auth: 0, manifestAuth: 0 })).problems.join(), /auth_users.ndjson is missing or empty/);
  const dir = makeExport();
  const other = path.join(dir, 'outer.json');
  fs.writeFileSync(other, JSON.stringify({ tables: {}, auth_users: 9 }));
  assert.match(d.recountExport(dir, other).problems.join(), /differs from the one inside/);
});
test('countLines ignores blank lines and handles a missing trailing newline', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'drill-cl-')), 'x.ndjson');
  fs.writeFileSync(f, '{"a":1}\n\n{"a":2}');
  assert.equal(d.countLines(f), 2);
});
