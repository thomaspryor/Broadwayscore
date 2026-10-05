import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('./reconcile-core-data-registry.js', import.meta.url));

function run(cwd, snapshotDir) {
  return execFileSync('node', [SCRIPT, snapshotDir], { cwd, encoding: 'utf8' });
}

test('reconcile-core-data-registry: unions remote-only slugs into a registered private-core-data file', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'reconcile-core-data-'));
  try {
    const checkout = path.join(tmp, 'checkout');
    const snapshot = path.join(tmp, 'snapshot');
    fs.mkdirSync(checkout, { recursive: true });
    fs.mkdirSync(snapshot, { recursive: true });

    fs.writeFileSync(
      path.join(checkout, 'awards.json'),
      JSON.stringify({ shows: { a: { tony: {} } } }, null, 2) + '\n',
    );
    fs.writeFileSync(
      path.join(snapshot, 'awards.json'),
      JSON.stringify({ shows: { a: { tony: {} }, b: { olivier: {} } } }, null, 2) + '\n',
    );

    const out = run(checkout, snapshot);
    assert.equal(out.trim(), 'awards.json');

    const merged = JSON.parse(fs.readFileSync(path.join(checkout, 'awards.json'), 'utf8'));
    assert.deepEqual(Object.keys(merged.shows).sort(), ['a', 'b']);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('reconcile-core-data-registry: no-op when local already matches (nothing printed, file untouched)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'reconcile-core-data-'));
  try {
    const checkout = path.join(tmp, 'checkout');
    const snapshot = path.join(tmp, 'snapshot');
    fs.mkdirSync(checkout, { recursive: true });
    fs.mkdirSync(snapshot, { recursive: true });

    const content = JSON.stringify({ shows: { a: { tony: {} } } }, null, 2) + '\n';
    fs.writeFileSync(path.join(checkout, 'awards.json'), content);
    fs.writeFileSync(path.join(snapshot, 'awards.json'), content);

    const out = run(checkout, snapshot);
    assert.equal(out.trim(), '');
    assert.equal(fs.readFileSync(path.join(checkout, 'awards.json'), 'utf8'), content);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('reconcile-core-data-registry: skips a file that is untouched locally (was never synced this run)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'reconcile-core-data-'));
  try {
    const checkout = path.join(tmp, 'checkout');
    const snapshot = path.join(tmp, 'snapshot');
    fs.mkdirSync(checkout, { recursive: true });
    fs.mkdirSync(snapshot, { recursive: true });
    // No awards.json locally at all — reconciliation must not fabricate one.
    fs.writeFileSync(path.join(snapshot, 'awards.json'), JSON.stringify({ shows: {} }));

    const out = run(checkout, snapshot);
    assert.equal(out.trim(), '');
    assert.equal(fs.existsSync(path.join(checkout, 'awards.json')), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('reconcile-core-data-registry: fails open on a corrupt remote snapshot (skips that file, exits 0)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'reconcile-core-data-'));
  try {
    const checkout = path.join(tmp, 'checkout');
    const snapshot = path.join(tmp, 'snapshot');
    fs.mkdirSync(checkout, { recursive: true });
    fs.mkdirSync(snapshot, { recursive: true });

    const content = JSON.stringify({ shows: { a: {} } }, null, 2) + '\n';
    fs.writeFileSync(path.join(checkout, 'awards.json'), content);
    fs.writeFileSync(path.join(snapshot, 'awards.json'), '{not valid json');

    const out = run(checkout, snapshot); // must not throw
    assert.equal(out.trim(), '');
    assert.equal(fs.readFileSync(path.join(checkout, 'awards.json'), 'utf8'), content);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('reconcile-core-data-registry: reconciles multiple registered files independently in one run', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'reconcile-core-data-'));
  try {
    const checkout = path.join(tmp, 'checkout');
    const snapshot = path.join(tmp, 'snapshot');
    fs.mkdirSync(checkout, { recursive: true });
    fs.mkdirSync(snapshot, { recursive: true });

    fs.writeFileSync(path.join(checkout, 'awards.json'), JSON.stringify({ shows: { a: {} } }));
    fs.writeFileSync(path.join(snapshot, 'awards.json'), JSON.stringify({ shows: { a: {}, b: {} } }));
    fs.writeFileSync(path.join(checkout, 'opening-night-sent.json'), JSON.stringify({ shows: { x: {} } }));
    fs.writeFileSync(path.join(snapshot, 'opening-night-sent.json'), JSON.stringify({ shows: { x: {}, y: {} } }));

    const out = run(checkout, snapshot);
    assert.deepEqual(out.trim().split('\n').sort(), ['awards.json', 'opening-night-sent.json']);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('reconcile-core-data-registry: a dropped Unknown-byline fossil leaves a durable tombstone file (BRO-2918)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'reconcile-core-data-'));
  try {
    const checkout = path.join(tmp, 'checkout');
    const snapshot = path.join(tmp, 'snapshot');
    fs.mkdirSync(checkout, { recursive: true });
    fs.mkdirSync(snapshot, { recursive: true });
    const base = { showId: 's', outlet: 'Radio Times', outletId: 'radio-times', url: 'https://www.radiotimes.com/a/review/', assignedScore: 80 };
    fs.writeFileSync(path.join(checkout, 'reviews.json'), JSON.stringify({
      _meta: { lastUpdated: '2026-10-02T00:00:00Z' },
      reviews: [{ ...base, criticName: 'Olivia Garrett', fullText: 'x'.repeat(500) }],
    }, null, 2) + '\n');
    fs.writeFileSync(path.join(snapshot, 'reviews.json'), JSON.stringify({
      _meta: { lastUpdated: '2026-10-01T00:00:00Z' },
      reviews: [{ ...base, criticName: 'Unknown' }],
    }, null, 2) + '\n');

    // Fossil is only in the remote snapshot; ours already has the bylined row,
    // so ours is unchanged and no tombstone is written (nothing deleted from ours).
    const quiet = run(checkout, snapshot).trim();
    assert.equal(quiet, '');

    // Fossil present in ours (local carried the stale identity): merge drops it.
    fs.writeFileSync(path.join(checkout, 'reviews.json'), JSON.stringify({
      _meta: { lastUpdated: '2026-10-02T00:00:00Z' },
      reviews: [{ ...base, criticName: 'Olivia Garrett', fullText: 'x'.repeat(500) }, { ...base, criticName: 'Unknown' }],
    }, null, 2) + '\n');
    const out = run(checkout, snapshot).trim().split('\n');
    assert.equal(out[0], 'reviews.json');
    assert.equal(out.length, 2);
    assert.match(out[1], /^review-merge-tombstones\/.+\.jsonl$/);
    const row = JSON.parse(fs.readFileSync(path.join(checkout, out[1]), 'utf8').trim());
    assert.equal(row.supersededBy, 'Olivia Garrett');
    assert.equal(row.url, base.url);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
