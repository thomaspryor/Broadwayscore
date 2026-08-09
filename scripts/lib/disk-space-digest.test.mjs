/**
 * Disk-space digest row (2026-08-09).
 *
 * WHY: disk was not a monitored signal ANYWHERE. The volume hit 100% (2.0Gi free
 * of 460Gi) and nothing warned, because there was no digest row to warn with —
 * `grep -n "diskFree|df -|DISK_FLOOR" scripts/health-check.js scripts/lib/autonomous-checks.js`
 * returned nothing. Merges silently degraded for hours (one took ~25 minutes
 * paying an emergency GC). These tests pin the two things that made it invisible:
 * that a low reading actually produces a non-ok row, and that the df parse
 * survives the real `df -h` output shape on this machine.
 *
 * Run: node --test scripts/lib/disk-space-digest.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { diskSpaceResults, readDiskSpace } = require('../health-check.js');

test('the incident reading (2.0GB free) is an ERROR, not a warning', () => {
  const [r] = diskSpaceResults(2, 460);
  assert.equal(r.status, 'error');
  assert.match(r.message, /2GB free/);
  assert.match(r.message, /10GB floor/);
  assert.ok(r.hint && r.hint.length > 20, 'an error row must tell the operator what to do');
});

test('the band between the floors warns rather than pages', () => {
  const [r] = diskSpaceResults(15, 460);
  assert.equal(r.status, 'warn');
  assert.match(r.message, /15GB free/);
});

test('healthy disk is ok — the row must not become permanent noise', () => {
  for (const free of [20, 54, 300]) {
    const [r] = diskSpaceResults(free, 460);
    assert.equal(r.status, 'ok', `${free}GB should read ok`);
  }
});

test('boundaries are exact: 10 warns, just under 10 errors', () => {
  assert.equal(diskSpaceResults(10, 460)[0].status, 'warn');
  assert.equal(diskSpaceResults(9, 460)[0].status, 'error');
  assert.equal(diskSpaceResults(19, 460)[0].status, 'warn');
  assert.equal(diskSpaceResults(20, 460)[0].status, 'ok');
});

test('an unreadable reading warns instead of silently passing', () => {
  // The failure that started all this was a check that could not speak. A parse
  // failure must never look like a healthy disk.
  for (const bad of [NaN, 0, -1, undefined, null]) {
    const [r] = diskSpaceResults(bad, 460);
    assert.equal(r.status, 'warn', `${bad} must not read as ok`);
    assert.match(r.message, /Could not read/);
  }
});

test('readDiskSpace parses the real df -h output from this machine', () => {
  // Captured verbatim 2026-08-09 (macOS df -h, the post-reclaim reading).
  const real = [
    'Filesystem      Size  Used Avail Capacity iused ifree %iused  Mounted on',
    '/dev/disk3s5   460Gi  393Gi   54Gi    88%    6.9M   21M   25%   /System/Volumes/Data',
  ].join('\n');
  const { free, total } = readDiskSpace(real);
  assert.equal(free, 54);
  assert.equal(total, 460);
  assert.equal(diskSpaceResults(free, total)[0].status, 'ok');
});

test('readDiskSpace parses the incident reading and drives an error row', () => {
  const incident = [
    'Filesystem      Size  Used Avail Capacity iused ifree %iused  Mounted on',
    '/dev/disk3s5   460Gi  423Gi  2.0Gi   100%    6.9M   21M   25%   /System/Volumes/Data',
  ].join('\n');
  const { free, total } = readDiskSpace(incident);
  assert.equal(free, 2);
  assert.equal(total, 460);
  assert.equal(diskSpaceResults(free, total)[0].status, 'error');
});

test('readDiskSpace returns NaN on junk rather than guessing a healthy number', () => {
  for (const junk of ['', 'not df output', 'Filesystem Size']) {
    const { free } = readDiskSpace(junk);
    assert.ok(Number.isNaN(free), `${JSON.stringify(junk)} must not yield a number`);
  }
});
