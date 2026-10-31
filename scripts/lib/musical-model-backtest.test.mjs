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
// Later the same day (BRO-5648), with more truth rows: musicals 13.7, 38/60;
// plays 15.7, 12/22 (one new row, see the play bound below).
// 2026-10-19 (BRO-5651): one more play truth row (All the Way, 2014) took
// plays to 17.8, 12/23. Play calibration (PLAY_LIVE_OPTS eraIndex + costSplit):
// timing plays 17.8 -> 10.1, 14/23; reported-truth plays 9.7 -> 5.3, 25/28.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const { MUSICAL_LIVE_OPTS, PLAY_LIVE_OPTS } = createRequire(import.meta.url)('./recoupment-model.js');

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const NEEDED = ['shows.json', 'commercial.json', 'grosses.json', 'grosses-history.json'];
const missing = NEEDED.filter((f) => !fs.existsSync(path.join(REPO, 'data', f)));
const skip = missing.length ? `private core data absent: ${missing.join(', ')}` : false;

// The three worst rows of a type, so a local failure names the shows that
// moved it. In CI the backtest prints aggregates only (the repo is public, so no
// show names in its logs) and there are no rows to name.
const worst = (rows, type) => (Array.isArray(rows)
  ? rows.filter((r) => r.type === type && Number.isFinite(r.newErr))
    .sort((a, b) => b.newErr - a.newErr).slice(0, 3)
    .map((r) => `${r.slug} ${Math.round(r.newErr)}`).join(', ')
  : 'rows hidden in CI, run the test locally');

function backtest(...args) {
  const out = execFileSync(process.execPath, ['scripts/backtest-recoupment-ground-truth.js', ...args, '--json'], {
    cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'inherit'],
  });
  // GitHub Actions workflow commands (::warning ...) share stdout with the JSON when
  // a variant reads worse than the shipped model; drop them before parsing.
  return JSON.parse(out.split('\n').filter((l) => !l.startsWith('::')).join('\n'));
}

test('timing backtest: musicals hold MAE <= 15.5 and >= 35 inside; plays MAE <= 15 and >= 16 inside', { skip }, () => {
  const { summary, rows } = backtest('--timing');
  const m = summary['type:musical'];
  const p = summary['type:play'];
  assert.ok(m.n >= 55, `musical checkpoints ${m.n}`);
  assert.ok(m.newMae <= 15.5, `musical timing MAE ${m.newMae} (was 18.4 before BRO-5598); worst: ${worst(rows, 'musical')}`);
  assert.ok(m.newInside >= 35, `musical timing inside ${m.newInside}/${m.n} (was 34/60)`);
  // Plays (BRO-5651): 10.1, 14/23 with PLAY_LIVE_OPTS; 17.8, 12/23 without
  // eraIndex + costSplit (the worst rows were pre-2020 star plays on an
  // estimated nut, Sea Wall / A Life and All the Way). Slack as for musicals.
  assert.ok(p.n >= 22, `play checkpoints ${p.n}`);
  // BRO-5817 (2026-10-22): truth rows grew to 29 plays (worst: Sea Wall 88,
  // Mockingbird 83, Oh Mary 61, on estimated nuts) -> MAE 13.2,
  // inside 16/29; model unchanged. Bound re-pinned with slack for more rows.
  assert.ok(p.newMae <= 15, `play timing MAE ${p.newMae} (17.8 before BRO-5651); worst: ${worst(rows, 'play')}`);
  assert.ok(p.newInside >= 16, `play timing inside ${p.newInside}/${p.n} (was 12/23)`);
});

// Switching each MUSICAL_LIVE_OPTS option off moves musicals and must leave
// every play number as it is, however many truth rows the data gains. A
// play-MAE bound cannot catch a leak: turning the musical options on for every
// show lowers play MAE (BRO-5648 review).
test('timing backtest: the musical-only options leave plays untouched', { skip }, () => {
  const plays = (...args) => {
    const { n, newMae, newMedian, newInside } = backtest('--timing', ...args).summary['type:play'];
    return { n, newMae, newMedian, newInside };
  };
  const base = plays();
  for (const name of Object.keys(MUSICAL_LIVE_OPTS)) {
    assert.deepEqual(plays(`--opt=${name}=false`), base, `--opt=${name}=false changed the play results`);
  }
});

// The mirror for the play-only options (BRO-5651): eraIndex alone moved
// musical timing MAE 13.7 -> 15.8, so a leak into musicals must fail here.
test('timing backtest: the play-only options leave musicals untouched', { skip }, () => {
  const musicals = (...args) => {
    const { n, newMae, newMedian, newInside } = backtest('--timing', ...args).summary['type:musical'];
    return { n, newMae, newMedian, newInside };
  };
  const base = musicals();
  for (const name of Object.keys(PLAY_LIVE_OPTS)) {
    assert.deepEqual(musicals(`--opt=${name}=false`), base, `--opt=${name}=false changed the musical results`);
  }
});

test('reported-truth backtest: musicals hold MAE <= 5.2 and >= 73 inside; plays MAE <= 6.5 and >= 24 inside', { skip }, () => {
  const { summary } = backtest('--base=HEAD');
  const m = summary['type:musical'];
  assert.ok(m.n >= 86, `musical rows ${m.n}`);
  // BRO-6188: constrain estimated costs for pre-2020 musicals by their known
  // capitalization instead of enabling eraIndex across musicals. On 89 truth
  // rows MAE 7.3 -> 3.7; timing 14.6 -> 12.7, no timing checkpoint worse.
  // BRO-6345: BRO-6218 re-sourced Cabaret 2024's cost to the filed $1.5M/week
  // (trade-reported, all-in), so the raw model now reads a -135% net loss against
  // a reported 0% return: the largest single miss, ~1.5 pts of the 89-row MAE
  // (3.7 -> 4.6, 77/89 inside). Viewers see the value floored at 0, but the raw
  // -135% is still a model gap (does the all-in cost double-count?).
  // Bound sits between 4.6 and the pre-BRO-6188 7.3; the all-off gain below
  // (8.8 vs 4.6) still fails if MUSICAL_LIVE_OPTS is undone.
  assert.ok(m.newMae <= 5.2, `musical reported-truth MAE ${m.newMae} (7.3 before BRO-6188, 4.6 after BRO-6218)`);
  assert.ok(m.newInside >= 73, `musical reported-truth inside ${m.newInside}/${m.n} (was 61/70)`);
  // An absolute bound only catches an undo at the current row count (all five
  // earlier options off read 6.3 vs 2.9 on 74 rows, under the bound), so also assert the
  // live options' own gain: it must stay visible however many truth rows are added.
  const allOff = backtest('--base=HEAD', ...Object.keys(MUSICAL_LIVE_OPTS).map((k) => `--opt=${k}=false`)).summary['type:musical'];
  assert.ok(allOff.newMae - m.newMae >= 2, `MUSICAL_LIVE_OPTS gain ${(allOff.newMae - m.newMae).toFixed(1)} pts (live ${m.newMae}, all off ${allOff.newMae})`);
  const p = summary['type:play'];
  assert.ok(p.n >= 26, `play rows ${p.n}`);
  assert.ok(p.newMae <= 6.5, `play reported-truth MAE ${p.newMae} (9.7 before BRO-5651)`);
  assert.ok(p.newInside >= 24, `play reported-truth inside ${p.newInside}/${p.n} (was 24/28)`);
});
