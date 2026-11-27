// BRO-8323: with no review data the probe must refuse, not print "low-yield"
// (a stop-the-backfill verdict drawn from zero files).
// Run: node --test scripts/lib/probe-historical-backfill-yield.test.mjs
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const probe = new URL('../probe-historical-backfill-yield.js', import.meta.url).pathname;
const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-empty-'));
after(() => fs.rmSync(empty, { recursive: true, force: true }));

test('missing review data exits 2 with no verdict', () => {
  for (const dir of [empty, path.join(empty, 'absent')]) {
    const r = spawnSync(process.execPath, [probe], { env: { ...process.env, REVIEW_TEXTS_DIR: dir }, encoding: 'utf8' });
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.doesNotMatch(r.stdout, /low-yield|keep/);
    assert.match(r.stderr, /No review data/);
  }
});
