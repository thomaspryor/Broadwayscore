/**
 * Integration guard for the retry-cap persistence in the self-healing recovery
 * loop (scripts/audit-show-review-gap.js → bumpRecoveryCount). The pure
 * flagged-recovery.test.mjs proves the DECISION; this proves the cap actually
 * lands on disk so a permanently-dead URL stops re-fetching after 3 tries
 * (acceptance: "retry cap proven — no infinite re-fetch / credit burn").
 *
 * bumpRecoveryCount writes to the module-level REVIEW_TEXTS_DIR captured at
 * require time, so we point that at a temp dir BEFORE requiring the module.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { isRecoverableFlaggedFile, nextRecoveryCount } = require('../../scripts/lib/flagged-recovery.js');

const SHOW = 'glengarry-glen-ross-west-end-2026';
const FILE = 'times-uk--clive-davis.json';
let tmpRoot;
let bumpRecoveryCount;

describe('flagged-recovery persistence (retry cap lands on disk)', () => {
  before(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-persist-'));
    process.env.REVIEW_TEXTS_DIR = tmpRoot;
    fs.mkdirSync(path.join(tmpRoot, SHOW), { recursive: true });
    fs.writeFileSync(
      path.join(tmpRoot, SHOW, FILE),
      JSON.stringify({ showId: SHOW, outletId: 'times-uk', criticName: 'Clive Davis', url: 'https://www.thetimes.com/x', fullText: '' }),
    );
    // Require AFTER REVIEW_TEXTS_DIR is set so the module binds the temp dir.
    ({ bumpRecoveryCount } = require('../../scripts/audit-show-review-gap.js'));
  });

  after(() => {
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  test('bump persists aggUrlRecoveryCount + timestamp without clobbering the body fields', () => {
    const ok = bumpRecoveryCount(SHOW, FILE, 1);
    assert.equal(ok, true);
    const d = JSON.parse(fs.readFileSync(path.join(tmpRoot, SHOW, FILE), 'utf8'));
    assert.equal(d.aggUrlRecoveryCount, 1);
    assert.ok(d.aggUrlRecoveryAt, 'aggUrlRecoveryAt stamped');
    assert.equal(d.outletId, 'times-uk');       // untouched
    assert.equal(d.criticName, 'Clive Davis');  // untouched
  });

  test('a dead URL stops after exactly 3 persisted attempts', () => {
    const fp = path.join(tmpRoot, SHOW, FILE);
    // Reset to a fresh empty-body file.
    fs.writeFileSync(fp, JSON.stringify({ showId: SHOW, fullText: '' }));
    let attempts = 0;
    while (true) {
      const d = JSON.parse(fs.readFileSync(fp, 'utf8'));
      if (!isRecoverableFlaggedFile(d)) break;   // cap reached → loop would skip it
      bumpRecoveryCount(SHOW, FILE, nextRecoveryCount(d)); // simulate a failed fetch
      attempts++;
      assert.ok(attempts <= 3, 'must not exceed the cap');
    }
    const final = JSON.parse(fs.readFileSync(fp, 'utf8'));
    assert.equal(attempts, 3, 'exactly 3 fetch attempts before the cap halts it');
    assert.equal(final.aggUrlRecoveryCount, 3);
    assert.equal(isRecoverableFlaggedFile(final), false);
  });
});
