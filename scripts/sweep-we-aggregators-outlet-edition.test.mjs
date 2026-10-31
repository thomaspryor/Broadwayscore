/**
 * sweep-we-aggregators.js writeReview: the URL edition decides the outlet.
 *
 * 2026-09-29: a WET row labelled "Time Out" with a timeout.com/london URL
 * re-created my-neighbour-totoro-west-end-2025/timeout--andrzej-lukowski.json
 * as outletId "timeout" (Time Out New York) — writeReview built outletId from
 * the outlet NAME and never looked at the URL.
 *
 * Run: node --test scripts/sweep-we-aggregators-outlet-edition.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

// REVIEW_TEXTS_DIR is read at require time: point it at a temp dir first.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-we-edition-'));
process.env.REVIEW_TEXTS_DIR = tmp;
const require_ = createRequire(import.meta.url);
const { writeReview } = require_('./sweep-we-aggregators.js');

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

function quiet(fn) {
  const log = console.log;
  console.log = () => {};
  try { return fn(); } finally { console.log = log; }
}

test('a "Time Out" row with a /london URL is written as timeout-london', () => {
  quiet(() => writeReview({
    outlet: 'Time Out', outletId: 'timeout', critic: 'Andrzej Lukowski',
    url: 'https://www.timeout.com/london/theatre/my-neighbour-totoro-review',
    source: 'westendtheatre', stars: 4,
  }, 'show-edition'));
  const dir = path.join(tmp, 'show-edition');
  assert.deepEqual(fs.readdirSync(dir), ['timeout-london--andrzej-lukowski.json']);
  const d = JSON.parse(fs.readFileSync(path.join(dir, 'timeout-london--andrzej-lukowski.json'), 'utf8'));
  assert.equal(d.outletId, 'timeout-london');
  assert.equal(d.outlet, 'Time Out London');
});

test('a row without a path-split URL keeps its name-derived outlet', () => {
  quiet(() => writeReview({
    outlet: 'The Guardian', critic: 'Arifa Akbar',
    url: 'https://www.theguardian.com/stage/2026/jan/01/some-review',
    source: 'westendtheatre', stars: 4,
  }, 'show-plain'));
  assert.deepEqual(fs.readdirSync(path.join(tmp, 'show-plain')), ['guardian--arifa-akbar.json']);
});
