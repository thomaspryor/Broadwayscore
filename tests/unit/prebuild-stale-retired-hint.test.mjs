// BRO-7187: validate-shows-prebuild.js names a flagged row an applied plan already
// retired, so a stale local shows.json is not filed as a live duplicate.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
const require = createRequire(import.meta.url);
const { staleDataHints, appliedRetirements } = require('../../scripts/lib/retired-by-applied-plan.js');
const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..');

const kept = { id: 'begin-again-regional-2026', slug: 'begin-again-regional-2026', title: 'Begin Again',
  venue: 'The Old Globe (Donald and Darlene Shiley Stage), San Diego, CA', status: 'closed',
  previewsStartDate: '2026-09-06', openingDate: '2026-09-17', closingDate: '2026-10-18', category: 'regional', market: 'regional', type: 'musical' };
const dup = { id: 'begin-again-old-regional-2026', slug: 'begin-again-old-regional-2026', title: 'Begin Again',
  venue: 'The Old Globe, San Diego, CA', status: 'closed', openingDate: '2026-09-18', category: 'regional', market: 'regional', type: 'play' };

test('the real bro-7080 plan is read as retiring begin-again-old-regional-2026', () => {
  const r = appliedRetirements();
  assert.equal(r.get('begin-again-old-regional-2026')?.plan, 'bro-7080');
});

test('hint names the retiring plan; no hint for an unretired pair', () => {
  const hints = staleDataHints([{ show: dup, existing: kept }]);
  assert.equal(hints.length, 1);
  assert.match(hints[0], /begin-again-old-regional-2026 was retired by bro-7080/);
  assert.deepEqual(staleDataHints([{ show: { id: 'x-2026' }, existing: { id: 'y-2026' } }]), []);
});

test('ignores pending plans and failed retire results', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'retired-hint-'));
  const act = { type: 'retire-show', id: 'z-2026', expectTitle: 'Z', reason: 'r' };
  fs.writeFileSync(path.join(dir, 'p1.json'), JSON.stringify({ status: 'pending', plan: { actions: [act] } }));
  fs.writeFileSync(path.join(dir, 'p2.json'), JSON.stringify({ status: 'partial', plan: { actions: [act] }, results: [{ action: 'retire-show', ok: false }] }));
  assert.equal(appliedRetirements(dir).size, 0);
});

test('a later applied add-show of the same id suppresses the hint (a real re-add)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'retired-hint-readd-'));
  const ret = { type: 'retire-show', id: 'z-2026', expectTitle: 'Z', reason: 'r' };
  const add = { type: 'add-show', show: { id: 'z-2026' } };
  fs.writeFileSync(path.join(dir, 'a.json'), JSON.stringify({ status: 'applied', executedAt: '2026-11-01T00:00:00Z', plan: { actions: [ret] }, results: [{ action: 'retire-show', ok: true }] }));
  assert.equal(appliedRetirements(dir).get('z-2026')?.plan, 'a');
  fs.writeFileSync(path.join(dir, 'b.json'), JSON.stringify({ status: 'applied', executedAt: '2026-11-05T00:00:00Z', plan: { actions: [add] }, results: [{ action: 'add-show', ok: true }] }));
  assert.equal(appliedRetirements(dir).has('z-2026'), false);
});

test('prebuild on a stale snapshot still blocks and prints the STALE DATA hint', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prebuild-stale-'));
  const file = path.join(dir, 'shows.json');
  fs.writeFileSync(file, JSON.stringify({ shows: [kept, dup] }));
  const r = spawnSync(process.execPath, ['scripts/validate-shows-prebuild.js'], { cwd: ROOT, env: { ...process.env, SHOWS_FILE_OVERRIDE: file }, encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /BUILD BLOCKED/);
  assert.match(r.stderr, /STALE DATA/);
  assert.match(r.stderr, /retired by bro-7080/);
});
