// TESTS-VS-DERIVED-DATA-EXEMPT: pure date arithmetic on synthetic run objects; no data/*.json read.
/**
 * notify-failure cooldown (BRO-5302): the 2026-10-13 orchestrator double page. Two market runs were
 * created at 17:21, ran ~5h, and failed at 22:37 and 22:38. Measured on creation time the first
 * was 5h old when the second checked, outside the 2h window, so the duplicate page was not
 * suppressed. Pattern: require() the real helper (CLAUDE.md rule 15).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { isRecentOtherFailure, createdFilterDate } = require('../../scripts/lib/notify-cooldown.js');
const ROOT = path.resolve(import.meta.dirname, '../..');

const T = (s) => new Date(`2026-10-13T${s}Z`);
const cutoffAt = (nowHHMMSS, minutes = 120) => new Date(T(nowHHMMSS).getTime() - minutes * 60 * 1000);

describe('isRecentOtherFailure', () => {
  test('the real incident: sibling created 17:21, failed 22:37, checked at 22:38 -> suppressed', () => {
    const sibling = { id: 38438033645, created_at: '2026-10-13T17:21:48Z', updated_at: '2026-10-13T22:37:40Z' };
    assert.equal(isRecentOtherFailure(sibling, cutoffAt('22:38:22'), 38438037005), true);
  });

  test('a failure that finished before the window does not suppress, however it was created', () => {
    const old = { id: 1, created_at: '2026-10-13T17:21:48Z', updated_at: '2026-10-13T19:00:00Z' };
    assert.equal(isRecentOtherFailure(old, cutoffAt('22:38:22'), 2), false);
  });

  test('the current run never suppresses itself', () => {
    const me = { id: 7, created_at: '2026-10-13T22:30:00Z', updated_at: '2026-10-13T22:37:00Z' };
    assert.equal(isRecentOtherFailure(me, cutoffAt('22:38:00'), 7), false);
  });

  test('short runs behave as before (created ~ updated inside the window)', () => {
    const quick = { id: 3, created_at: '2026-10-13T22:00:00Z', updated_at: '2026-10-13T22:02:00Z' };
    assert.equal(isRecentOtherFailure(quick, cutoffAt('22:30:00'), 4), true);
  });

  test('missing updated_at falls back to created_at; null run is false', () => {
    assert.equal(isRecentOtherFailure({ id: 3, created_at: '2026-10-13T22:00:00Z' }, cutoffAt('22:30:00'), 4), true);
    assert.equal(isRecentOtherFailure(null, cutoffAt('22:30:00'), 4), false);
  });
});

describe('createdFilterDate', () => {
  test('reaches back far enough to include a run created before midnight that failed after it', () => {
    // cutoff 00:30 UTC on the 14th; a 5h run created 20:00 on the 13th must still be listed
    const cutoff = new Date('2026-10-14T00:30:00Z');
    assert.equal(createdFilterDate(cutoff), '2026-10-13');
    assert.ok(createdFilterDate(cutoff) <= '2026-10-13');
  });
});

describe('notify-failure wiring', () => {
  const action = fs.readFileSync(path.join(ROOT, '.github/actions/notify-failure/action.yml'), 'utf8');
  test('the composite uses the helper and no longer compares created_at to the cutoff', () => {
    assert.match(action, /require\('\.\/scripts\/lib\/notify-cooldown\.js'\)/);
    assert.match(action, /isRecentOtherFailure\(/);
    assert.match(action, /created: `>=\$\{createdFilterDate\(cutoff\)\}`/);
    assert.doesNotMatch(action, /new Date\(r\.created_at\);\s*\n\s*return created >= cutoff/);
  });
});
