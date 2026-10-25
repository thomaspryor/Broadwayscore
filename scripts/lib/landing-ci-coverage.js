#!/usr/bin/env node
/**
 * BRO-2884 — a landed sha must be covered by a test.yml run.
 *
 * GitHub evaluates only the TIP commit of a push for `[skip ci]`. When a
 * telemetry commit ("data: ... [skip ci]") sits on top of a landing at push
 * time, the whole push — landing included — gets ZERO CI, and nobody sees a
 * red because no run exists to be red (observed twice, 2026-09-05).
 *
 * ensureCoverage() is called after a landing is proven on origin/main:
 *   1. a test.yml run whose head_sha is the landed sha OR a descendant of it
 *      covers it (test.yml tests the whole tree at head_sha);
 *   2. none yet and the landing needs CI (skip-ci marker on the landed commit,
 *      or code paths touched) → poll briefly, then dispatch test.yml on main
 *      (workflow_dispatch; its head_sha is main's tip, a descendant), and
 *      verify the dispatched run appears.
 * Dispatch runs test_type=data-only (no e2e/visual, which a push run would add) and
 * diff-scoped steps see HEAD~1..HEAD, so a dispatched run is PARTIAL coverage of a
 * multi-commit landing; it proves the suite ran on a tree containing the landing.
 * A landing that touches only non-test paths and carries no skip marker is
 * 'not-required' (test.yml's push path filter legitimately skipped it).
 *
 * CLI: node scripts/lib/landing-ci-coverage.js --sha=<sha> [--cwd=<dir>]
 *        [--repo=owner/name] [--base=<fork sha>] [--wait-sec=120] [--no-dispatch]
 *   exit 0 covered / not-required, 1 uncovered, 2 unknown (gh unavailable)
 *   GH_BIN overrides the gh executable (tests).
 */
'use strict';
const { spawnSync } = require('child_process');

const SKIP_MARKER = /\[(?:skip ci|ci skip|no ci|skip actions|actions skip)\]|skip-checks:\s*true/i;

/** `on.push.paths` globs from a workflow file's text (top-level push block only). */
function pushPathsFromWorkflow(text) {
  const lines = String(text || '').split('\n');
  const start = lines.findIndex(l => /^  push:\s*$/.test(l));
  if (start < 0) return [];
  const out = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^  \S/.test(lines[i])) break; // next trigger (pull_request:, schedule:, ...)
    const m = lines[i].match(/^\s+-\s+['"]?([^'"#]+?)['"]?\s*(?:#.*)?$/);
    if (m && !m[1].startsWith('!')) out.push(m[1]);
  }
  return out;
}

function globToRegExp(g) {
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') { if (g[i + 1] === '*') { re += '.*'; i++; if (g[i + 1] === '/') i++; } else re += '[^/]*'; }
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

/** True when any changed file matches the workflow's push paths. No paths known or no files known → true (the safe direction: a spare run beats an untested main). */
function touchesCodePaths(files, patterns) {
  if (!files || !files.length || !patterns || !patterns.length) return true;
  const res = patterns.map(globToRegExp);
  return files.some(f => res.some(r => r.test(f)));
}

function hasSkipCiMarker(message) {
  return SKIP_MARKER.test(String(message || ''));
}

/** First run (newest first) whose head_sha is `sha` or a descendant of it. */
function findCoveringRun(runs, sha, isAncestor) {
  for (const r of runs || []) {
    if (!r || !r.head_sha) continue;
    if (r.conclusion === 'cancelled' || r.conclusion === 'skipped') continue;
    if (r.head_sha === sha || isAncestor(sha, r.head_sha)) return r;
  }
  return null;
}

class ListError extends Error {}

async function ensureCoverage(o) {
  const { sha, listRuns, isAncestor, getMessage, getChangedFiles, dispatch } = o;
  const sleep = o.sleep || (ms => new Promise(r => setTimeout(r, ms)));
  const waitSec = o.waitSec == null ? 120 : o.waitSec;
  const pollSec = o.pollSec || 15;
  const find = async () => {
    const runs = await listRuns();
    if (runs === null) throw new ListError();
    return findCoveringRun(runs, sha, isAncestor);
  };

  let run;
  try { run = await find(); } catch (e) { if (e instanceof ListError) return { status: 'unknown' }; throw e; }
  if (run) return { status: 'covered', run };

  const skip = hasSkipCiMarker(getMessage(sha));
  const needsRun = skip || touchesCodePaths(getChangedFiles(sha), o.pushPaths);
  if (!needsRun) return { status: 'not-required' };

  // A skip-marked landed commit will never get a push run; otherwise give the
  // push-triggered run time to appear before paying for a dispatch.
  if (!skip) {
    for (let waited = 0; waited < waitSec && !run; waited += pollSec) {
      await sleep(pollSec * 1000);
      try { run = await find(); } catch (e) { if (e instanceof ListError) return { status: 'unknown' }; throw e; }
    }
    if (run) return { status: 'covered', run };
  }
  if (o.noDispatch) return { status: 'uncovered', skip };

  await dispatch();
  for (let waited = 0; waited <= waitSec && !run; waited += pollSec) {
    try { run = await find(); } catch (e) { if (e instanceof ListError) return { status: 'unknown', dispatched: true }; throw e; }
    if (run) break;
    await sleep(pollSec * 1000);
  }
  return run ? { status: 'dispatched-covered', run, skip } : { status: 'uncovered', skip, dispatched: true };
}

function sh(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', timeout: 60000 });
  return { rc: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}

async function main(argv) {
  const arg = n => (argv.find(a => a.startsWith(`--${n}=`)) || '').slice(n.length + 3);
  const sha = arg('sha');
  if (!sha) { console.error('usage: landing-ci-coverage.js --sha=<sha> [--cwd=dir] [--repo=o/n] [--base=sha]'); return 2; }
  const cwd = arg('cwd') || process.cwd();
  const gh = process.env.GH_BIN || 'gh';
  let repo = arg('repo');
  if (!repo) {
    const r = sh(gh, ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'], cwd);
    repo = r.rc === 0 ? r.out : '';
  }
  if (!repo) { console.log('CI-COVERAGE: UNKNOWN — gh unavailable, cannot list test.yml runs'); return 2; }
  const base = arg('base');
  let ghFailed = false;
  const res = await ensureCoverage({
    sha,
    waitSec: Number(arg('wait-sec') || 120),
    noDispatch: argv.includes('--no-dispatch'),
    listRuns: async () => {
      const r = sh(gh, ['api', '-H', 'Cache-Control: no-cache', `repos/${repo}/actions/workflows/test.yml/runs?branch=main&per_page=50`, '--jq', '[.workflow_runs[] | {head_sha, conclusion, event, html_url}]'], cwd);
      sh('git', ['fetch', 'origin', 'main', '-q'], cwd); // newer heads must exist locally for the ancestry test
      if (r.rc !== 0) { ghFailed = true; return null; }
      try { return JSON.parse(r.out); } catch { ghFailed = true; return null; }
    },
    isAncestor: (a, b) => sh('git', ['merge-base', '--is-ancestor', a, b], cwd).rc === 0,
    getMessage: s => sh('git', ['log', '-1', '--format=%B', s], cwd).out,
    getChangedFiles: s => sh('git', base ? ['diff', '--name-only', base, s] : ['diff-tree', '--no-commit-id', '--name-only', '-r', '-m', s], cwd).out.split('\n').filter(Boolean),
    pushPaths: pushPathsFromWorkflow(sh('git', ['show', `${sha}:.github/workflows/test.yml`], cwd).out),
    dispatch: async () => {
      const r = sh(gh, ['workflow', 'run', 'test.yml', '--ref', 'main', '-f', 'test_type=data-only'], cwd);
      console.log(r.rc === 0 ? 'CI-COVERAGE: no test.yml run covers the landing (skip-ci tip or lost push) — dispatched test.yml on main (test_type=data-only: unit/tsc/data gates, no e2e or visual)' : `CI-COVERAGE: dispatch failed: ${r.err}`);
    },
  });
  if (res.status === 'covered' || res.status === 'dispatched-covered') {
    console.log(`CI-COVERAGE: OK — test.yml run covers ${sha.slice(0, 10)}${res.run.html_url ? ` (${res.run.html_url})` : ''}${res.status === 'dispatched-covered' ? ' [dispatched]' : ''}`);
    return 0;
  }
  if (res.status === 'not-required') {
    console.log(`CI-COVERAGE: not required — ${sha.slice(0, 10)} touches no test.yml path and has no skip marker`);
    return 0;
  }
  if (res.status === 'unknown' || ghFailed) { console.log('CI-COVERAGE: UNKNOWN — gh API failed while listing runs'); return 2; }
  console.log(`CI-COVERAGE: UNCOVERED — no test.yml run has ${sha.slice(0, 10)} as an ancestor${res.skip ? ' (landed commit carries [skip ci])' : ''}. Main is UNTESTED at this sha; run the full suite or dispatch test.yml before relying on it.`);
  return 1;
}

module.exports = { hasSkipCiMarker, touchesCodePaths, pushPathsFromWorkflow, findCoveringRun, ensureCoverage };

if (require.main === module) main(process.argv.slice(2)).then(c => process.exit(c), e => { console.error(e); process.exit(2); });
