/**
 * Unit tests for scripts/lib/rebuild-pause.js (Schmigadoon 2026 Bug #12).
 *
 * This lib is the read-side of the opening-night rebuild-pause tombstone.
 * A miss here means a rebuild could race a hand-edited reviews.json during
 * the morning broadcast window (the Schmigadoon 2026 scenario).
 *
 * Fail-open semantics are load-bearing: a corrupt or missing tombstone must
 * NOT pause rebuilds permanently. We explicitly test the failure modes.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { isRebuildPaused, readRebuildPause } = require('../../scripts/lib/rebuild-pause.js');

// Use a temp file per test run so we don't touch the real tombstone path.
let tmpDir;
let tombstonePath;

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rebuild-pause-test-'));
  tombstonePath = path.join(tmpDir, 'rebuild-pause.json');
});

after(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

function writeTombstone(body) {
  fs.writeFileSync(tombstonePath, typeof body === 'string' ? body : JSON.stringify(body));
}

function clearTombstone() {
  try { fs.unlinkSync(tombstonePath); } catch {}
}

describe('isRebuildPaused — fail-open defaults', () => {
  test('missing file → not paused', () => {
    clearTombstone();
    assert.strictEqual(isRebuildPaused(Date.now(), tombstonePath), false);
  });

  test('invalid JSON → not paused (fail-open)', () => {
    writeTombstone('not json {{');
    assert.strictEqual(isRebuildPaused(Date.now(), tombstonePath), false);
  });

  test('missing `until` field → not paused', () => {
    writeTombstone({ reason: 'no until' });
    assert.strictEqual(isRebuildPaused(Date.now(), tombstonePath), false);
  });

  test('invalid `until` string → not paused', () => {
    writeTombstone({ until: 'definitely-not-a-date' });
    assert.strictEqual(isRebuildPaused(Date.now(), tombstonePath), false);
  });

  test('null body → not paused', () => {
    writeTombstone('null');
    assert.strictEqual(isRebuildPaused(Date.now(), tombstonePath), false);
  });
});

describe('isRebuildPaused — active window', () => {
  test('until is in the future → paused', () => {
    const future = new Date(Date.now() + 30 * 60000).toISOString();
    writeTombstone({ until: future, reason: 'opening-night hotfix' });
    assert.strictEqual(isRebuildPaused(Date.now(), tombstonePath), true);
  });

  test('until is in the past → not paused (expired)', () => {
    const past = new Date(Date.now() - 5 * 60000).toISOString();
    writeTombstone({ until: past, reason: 'stale' });
    assert.strictEqual(isRebuildPaused(Date.now(), tombstonePath), false);
  });

  test('until is exactly now → not paused (strict greater-than)', () => {
    const now = Date.now();
    writeTombstone({ until: new Date(now).toISOString(), reason: 'boundary' });
    assert.strictEqual(isRebuildPaused(now, tombstonePath), false);
  });

  test('custom nowMs — tests pause at a specific simulated time', () => {
    const until = new Date('2026-04-21T13:30:00Z').toISOString();
    writeTombstone({ until });
    // At 13:00, still paused
    assert.strictEqual(
      isRebuildPaused(new Date('2026-04-21T13:00:00Z').getTime(), tombstonePath),
      true,
    );
    // At 14:00, no longer paused
    assert.strictEqual(
      isRebuildPaused(new Date('2026-04-21T14:00:00Z').getTime(), tombstonePath),
      false,
    );
  });
});

describe('readRebuildPause — structured read', () => {
  test('returns parsed fields when present', () => {
    const until = new Date('2026-04-21T13:30:00Z').toISOString();
    writeTombstone({
      until,
      pausedAt: '2026-04-21T13:00:00Z',
      pausedBy: 'tompryor',
      reason: 'opening-night hotfix',
    });
    const entry = readRebuildPause(tombstonePath);
    assert.ok(entry);
    assert.strictEqual(entry.until.toISOString(), until);
    assert.strictEqual(entry.pausedAt, '2026-04-21T13:00:00Z');
    assert.strictEqual(entry.pausedBy, 'tompryor');
    assert.strictEqual(entry.reason, 'opening-night hotfix');
  });

  test('returns null on missing file', () => {
    clearTombstone();
    assert.strictEqual(readRebuildPause(tombstonePath), null);
  });

  test('coerces non-string fields to empty strings', () => {
    writeTombstone({
      until: new Date(Date.now() + 60000).toISOString(),
      pausedAt: 12345,           // wrong type
      pausedBy: { nested: 1 },   // wrong type
      reason: ['array'],         // wrong type
    });
    const entry = readRebuildPause(tombstonePath);
    assert.ok(entry);
    assert.strictEqual(entry.pausedAt, '');
    assert.strictEqual(entry.pausedBy, '');
    assert.strictEqual(entry.reason, '');
  });
});
