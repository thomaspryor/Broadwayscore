/**
 * BRO-7117: an auto/market opening-night poller run must leave a show that an
 * active TARGETED poller run owns to that run. The two run kinds sit in
 * different concurrency groups, so without this guard both worked the same
 * show at once and one failed (BRO-5716, BRO-6594, BRO-7338): half of the
 * "Opening Night Poller Failed" cards in Oct-Nov 2026.
 *
 * Two layers:
 *   1. wiring: the workflow checks at Find, before every poll in the loop, and
 *      before collect/score (a targeted run that started after Find);
 *   2. the CLI at its I/O boundary, with a fake `gh` on PATH: it filters, and
 *      it fails open (keeps every show) when the run list cannot be read.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const WF = yaml.load(fs.readFileSync(path.join(ROOT, '.github/workflows/opening-night-poller.yml'), 'utf8'));
const steps = WF.jobs.poll.steps;
const byName = (n) => {
  const s = steps.find((x) => x.name === n);
  assert.ok(s, `step "${n}" missing from opening-night-poller.yml`);
  return s;
};
const idx = (n) => steps.findIndex((x) => x.name === n);
const CLI = 'filter-active-targeted-poller-shows.js';

test('Find step: auto branch reads active targeted runs and filters before ordering', () => {
  const find = byName('Find shows to poll');
  assert.ok(find.env.GH_TOKEN, 'Find step needs GH_TOKEN to list runs');
  const run = find.run;
  const autoBranch = run.slice(run.indexOf('else'));
  assert.match(autoBranch, new RegExp(`${CLI} --active`));
  const filterAt = autoBranch.indexOf('ownedElsewhere.has(s.id)');
  const orderAt = autoBranch.indexOf('orderPollShows(opened');
  assert.ok(filterAt > 0, 'candidates must be filtered by the owned set');
  assert.ok(orderAt > filterAt, 'filter must run before orderPollShows so front/main_front_end match the list');
  assert.match(autoBranch, /process\.env\.POLLER_OWNED_SHOWS/, 'owned list must come in through process.env, not string interpolation');
});

test('poll loop re-checks ownership before every main and hot poll (auto runs only)', () => {
  const poll = byName('Run poller for each show');
  assert.ok(poll.env.GH_TOKEN, 'poll step needs GH_TOKEN');
  const run = poll.run;
  assert.match(run, /owned_elsewhere\(\) \{\n\s*\[ -z "\$INPUT_SHOW_ID" \] \|\| return 1/, 'targeted runs must never skip their own show');
  assert.match(run, new RegExp(`${CLI} --active`));
  const mainLoop = run.slice(run.indexOf('for SHOW_ID in "${SHOW_ARRAY[@]}"; do'));
  assert.ok(mainLoop.indexOf('owned_elsewhere "$SHOW_ID"') > 0);
  assert.ok(mainLoop.indexOf('owned_elsewhere "$SHOW_ID"') < mainLoop.indexOf('poll_one "$SHOW_ID"'), 'check must come before the poll');
  assert.ok(mainLoop.indexOf('owned_elsewhere "$HOT_ID"') > 0);
  assert.ok(mainLoop.indexOf('owned_elsewhere "$HOT_ID"') < mainLoop.indexOf('poll_one "$HOT_ID"'), 'hot re-poll must check first');
});

test('collect and score use the re-scoped list and skip when every show is owned', () => {
  const scope = byName('Scope collect and score to shows this run still owns');
  assert.equal(scope.id, 'scope');
  assert.equal(scope['continue-on-error'], true, 'scope must fail open');
  assert.ok(scope.env.GH_TOKEN);
  assert.match(scope.run, new RegExp(`${CLI} "\\$FIND_SHOWS"`));
  const collect = byName('Collect full text inline');
  const score = byName('Score reviews inline');
  assert.ok(idx('Scope collect and score to shows this run still owns') < idx('Collect full text inline'));
  for (const s of [collect, score]) {
    assert.match(s.if, /steps\.scope\.outputs\.all_owned != 'true'/, `${s.name} must skip when every show is owned`);
  }
  assert.equal(collect.env.SHOW_FILTER, '${{ steps.scope.outputs.shows || steps.find.outputs.shows }}');
  assert.match(score.run, /SHOWS="\$\{\{ steps\.scope\.outputs\.shows \|\| steps\.find\.outputs\.shows \}\}"/);
});

function runCli(args, ghScript) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro7117-gh-'));
  fs.writeFileSync(path.join(dir, 'gh'), `#!/bin/sh\n${ghScript}\n`, { mode: 0o755 });
  try {
    return execFileSync(process.execPath, [path.join(ROOT, 'scripts', CLI), ...args], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
    }).trim();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// The 2026-11-11 00:25Z pair (BRO-7338), as `gh run list` returns it.
const RUNS = JSON.stringify([
  { databaseId: 42931235978, status: 'in_progress', displayTitle: 'Opening Night Poller — cloud-9-west-end-2026' },
  { databaseId: 42931217026, status: 'in_progress', displayTitle: 'Opening Night Poller — auto' },
  { databaseId: 42874533817, status: 'completed', displayTitle: 'Opening Night Poller — tosca-english-national-opera-west-end-2026' },
]);

test('CLI filter mode drops the owned show (BRO-7338 replay)', () => {
  const out = runCli(['cloud-9-west-end-2026,tosca-english-national-opera-west-end-2026'], `echo '${RUNS}'`);
  assert.equal(out, 'tosca-english-national-opera-west-end-2026');
});

test('CLI --active lists only active targeted shows', () => {
  assert.equal(runCli(['--active'], `echo '${RUNS}'`), 'cloud-9-west-end-2026');
});

test('CLI fails open when gh errors: keeps every show, owns nothing', () => {
  assert.equal(runCli(['a-2026,b-2026'], 'echo boom >&2; exit 1'), 'a-2026,b-2026');
  assert.equal(runCli(['--active'], 'exit 1'), '');
  assert.equal(runCli(['a-2026'], 'echo not-json'), 'a-2026');
});
