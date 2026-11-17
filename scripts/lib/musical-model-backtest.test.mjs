// LIVE-DATA-LANE: reads data/shows.json (untracked core data); data/commercial.json (untracked core data); data/grosses.json (untracked core data); +1 more. Runs in check-corpus-drift.yml, not test.yml's blocking batch (BRO-7101).
// BRO-7633: compare the live calibration with its options disabled on the
// same current corpus. Fixed MAE ceilings and inside-count floors drift as
// private truth rows grow, refusing unrelated landings. The relative checks
// still catch a lost calibration; the type-isolation checks below catch leaks.
// This suite also runs in check-corpus-drift.yml's live-data lane.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { MUSICAL_LIVE_OPTS, PLAY_LIVE_OPTS } = require('./recoupment-model.js');
const { calibrationFailures } = require('./backtest-calibration.js');

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const NEEDED = ['shows.json', 'commercial.json', 'grosses.json', 'grosses-history.json'];
const missing = NEEDED.filter((f) => !fs.existsSync(path.join(REPO, 'data', f)));
const skip = missing.length ? `private core data absent: ${missing.join(', ')}` : false;

function backtest(...args) {
  const out = execFileSync(process.execPath, ['scripts/backtest-recoupment-ground-truth.js', ...args, '--json'], {
    cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'inherit'],
  });
  // GitHub Actions workflow commands (::warning ...) share stdout with the JSON when
  // a variant reads worse than the shipped model; drop them before parsing.
  return JSON.parse(out.split('\n').filter((l) => !l.startsWith('::')).join('\n'));
}

function checkCalibration(mode) {
  const report = backtest(mode);
  assert.equal(report.skipped.newOnly, 0, 'live model dropped a baseline row');
  for (const [type, opts] of [['musical', MUSICAL_LIVE_OPTS], ['play', PLAY_LIVE_OPTS]]) {
    // Only the live reported-truth run needs --base=HEAD to select that mode.
    // Disabled options already select it, avoiding two redundant git archives.
    const off = backtest(...(mode === '--timing' ? [mode] : []), ...Object.keys(opts).map((name) => `--opt=${name}=false`));
    assert.equal(off.skipped.newOnly, 0, `${type} disabled options dropped a baseline row`);
    const live = report.summary[`type:${type}`];
    const disabled = off.summary[`type:${type}`];
    assert.deepEqual(calibrationFailures(live, disabled), [], `${mode} ${type} calibration`);
  }
}

test('timing backtest: calibration improves MAE without losing inside coverage on the same corpus', { skip }, () => {
  checkCalibration('--timing');
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

test('reported-truth backtest: calibration improves MAE without losing inside coverage on the same corpus', { skip }, () => {
  checkCalibration('--base=HEAD');
});
