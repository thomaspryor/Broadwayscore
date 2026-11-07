/**
 * BRO-5652: re-ensemble-scores.ts must not rescore files moved aside into
 * _superseded-misattributed/ (or _pending/), nor read `_` sidecar files.
 * Requires the real listReensembleFiles (CLAUDE.md section 15).
 *
 * Run: node --test tests/unit/re-ensemble-holding-dirs.test.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
process.env.TS_NODE_PROJECT = new URL('../../scripts/tsconfig.json', import.meta.url).pathname;
require('ts-node/register');
const { listReensembleFiles } = require('../../scripts/re-ensemble-scores');

function corpus() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reensemble-'));
  const put = (rel) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), '{}');
  };
  put('hamilton-2015/nytimes--ben-brantley.json');
  put('hamilton-2015/_blocklist.json');
  put('hamilton-2015/failed-fetches.json');
  put('_superseded-misattributed/hamilton-2015--variety--someone.json');
  put('_superseded-misattributed/hamilton-2015/variety--someone.json');
  put('_pending/x.json');
  put('wicked-2003/variety--marilyn-stasio.json');
  return dir;
}

test('holding folders and sidecars are excluded', () => {
  const dir = corpus();
  try {
    assert.deepEqual(listReensembleFiles(dir).sort(), [
      ['hamilton-2015', 'nytimes--ben-brantley.json'],
      ['wicked-2003', 'variety--marilyn-stasio.json'],
    ]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('--show filter keeps one show and cannot select a holding folder', () => {
  const dir = corpus();
  try {
    assert.deepEqual(listReensembleFiles(dir, 'wicked-2003'), [['wicked-2003', 'variety--marilyn-stasio.json']]);
    assert.deepEqual(listReensembleFiles(dir, '_superseded-misattributed'), []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
