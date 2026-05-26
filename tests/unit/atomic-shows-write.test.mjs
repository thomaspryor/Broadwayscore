import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { atomicWriteShowsJson, AtomicWriteShrinkError } = require('../../scripts/lib/atomic-shows-write.js');

function withTmpFile(initial, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'atomic-shows-'));
  const path = join(dir, 'shows.json');
  if (initial != null) writeFileSync(path, initial);
  try { return fn(path); }
  finally { rmSync(dir, { recursive: true, force: true }); }
}

test('atomicWriteShowsJson writes new file when target absent', () => {
  withTmpFile(null, (p) => {
    const r = atomicWriteShowsJson(p, { shows: [{ id: 'a' }] });
    assert.equal(r.wrote, true);
    assert.equal(r.lineCountBefore, 0);
    const parsed = JSON.parse(readFileSync(p, 'utf8'));
    assert.equal(parsed.shows.length, 1);
  });
});

test('atomicWriteShowsJson allows growth and small shrinks (<=5%)', () => {
  // Build a 100-show baseline (current shape) so percent-shrink math is meaningful
  const shows = Array.from({ length: 100 }, (_, i) => ({ id: `s-${i}` }));
  const initial = JSON.stringify({ shows }, null, 2);

  withTmpFile(initial, (p) => {
    // Add 1 show — grows
    const r1 = atomicWriteShowsJson(p, { shows: [...shows, { id: 's-new' }] });
    assert.ok(r1.lineCountAfter > r1.lineCountBefore);

    // Drop 4 shows — ~4% line drop — should pass at 5% threshold
    const r2 = atomicWriteShowsJson(p, { shows: shows.slice(0, 96) });
    assert.equal(r2.wrote, true);
  });
});

test('atomicWriteShowsJson refuses >5% shrink', () => {
  const shows = Array.from({ length: 100 }, (_, i) => ({ id: `s-${i}` }));
  const initial = JSON.stringify({ shows }, null, 2);

  withTmpFile(initial, (p) => {
    // Drop 50 shows — ~50% line drop — should throw
    assert.throws(
      () => atomicWriteShowsJson(p, { shows: shows.slice(0, 50) }),
      AtomicWriteShrinkError
    );
    // File untouched
    const stillThere = JSON.parse(readFileSync(p, 'utf8'));
    assert.equal(stillThere.shows.length, 100);
  });
});

test('atomicWriteShowsJson allowShrink: true bypasses gate', () => {
  const shows = Array.from({ length: 100 }, (_, i) => ({ id: `s-${i}` }));
  const initial = JSON.stringify({ shows }, null, 2);

  withTmpFile(initial, (p) => {
    const r = atomicWriteShowsJson(p, { shows: shows.slice(0, 50) }, { allowShrink: true });
    assert.equal(r.wrote, true);
    const parsed = JSON.parse(readFileSync(p, 'utf8'));
    assert.equal(parsed.shows.length, 50);
  });
});

test('atomicWriteShowsJson custom shrinkThresholdPct', () => {
  const shows = Array.from({ length: 100 }, (_, i) => ({ id: `s-${i}` }));
  const initial = JSON.stringify({ shows }, null, 2);

  withTmpFile(initial, (p) => {
    // Drop 6 → ~6% — should fail at default 5%, pass at 10%
    assert.throws(() => atomicWriteShowsJson(p, { shows: shows.slice(0, 94) }), AtomicWriteShrinkError);
    const r = atomicWriteShowsJson(p, { shows: shows.slice(0, 94) }, { shrinkThresholdPct: 10 });
    assert.equal(r.wrote, true);
  });
});
