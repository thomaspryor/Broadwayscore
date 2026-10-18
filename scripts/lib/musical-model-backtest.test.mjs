// BRO-5598: pins the recoupment model's musical backtest stats at the level
// the musical calibration reached (scripts/lib/recoupment-model.js
// MUSICAL_LIVE_OPTS), so a later model or data change that undoes it fails
// here. Runs the real backtest script (§15); skips when the private core data
// (commercial.json, grosses) is absent.
//
// Baseline before BRO-5598 (2026-10-18): timing musicals MAE 18.4, inside
// 34/60; plays 10.9, 12/21. Reached: musicals 14.1, 37/60; plays unchanged.
// Bounds sit between the old and new levels (slack for weekly data growth)
// and still fail if MUSICAL_LIVE_OPTS is undone (18.4 MAE, 4.6 GT MAE).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const NEEDED = ['shows.json', 'commercial.json', 'grosses.json', 'grosses-history.json'];
const missing = NEEDED.filter((f) => !fs.existsSync(path.join(REPO, 'data', f)));
const skip = missing.length ? `private core data absent: ${missing.join(', ')}` : false;

function backtest(...args) {
  const out = execFileSync(process.execPath, ['scripts/backtest-recoupment-ground-truth.js', ...args, '--json'], {
    cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'inherit'],
  });
  return JSON.parse(out);
}

test('timing backtest: musicals hold MAE <= 15.5 and >= 35 inside; plays no worse than before', { skip }, () => {
  const { summary } = backtest('--timing');
  const m = summary['type:musical'];
  const p = summary['type:play'];
  assert.ok(m.n >= 55, `musical checkpoints ${m.n}`);
  assert.ok(m.newMae <= 15.5, `musical timing MAE ${m.newMae} (was 18.4 before BRO-5598)`);
  assert.ok(m.newInside >= 35, `musical timing inside ${m.newInside}/${m.n} (was 34/60)`);
  assert.ok(p.newMae <= 10.9, `play timing MAE ${p.newMae}`);
  assert.ok(p.newInside >= 12, `play timing inside ${p.newInside}/${p.n}`);
});

test('reported-truth backtest: musicals hold MAE <= 4.2 and >= 62 inside', { skip }, () => {
  const { summary } = backtest('--base=HEAD');
  const m = summary['type:musical'];
  assert.ok(m.n >= 65, `musical rows ${m.n}`);
  assert.ok(m.newMae <= 4.2, `musical reported-truth MAE ${m.newMae} (was 4.6 before BRO-5598)`);
  assert.ok(m.newInside >= 62, `musical reported-truth inside ${m.newInside}/${m.n} (was 61/70)`);
});
