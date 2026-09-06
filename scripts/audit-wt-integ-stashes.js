#!/usr/bin/env node
'use strict';

/**
 * Triage the shared git stash stack.
 *
 * READ ONLY. This script never drops, applies or pops anything — the stash
 * stack is shared across ~20 sessions and the wt-integ-* entries are the
 * deliberate recovery trace for another session's WIP (asserted by
 * tests/unit/merge-worktree-push-verification.test.mjs).
 *
 * It answers the one question the session-start hook's "inspect before
 * dropping" advice leaves to a human: which entries are safe churn, and which
 * would destroy a real file if applied.
 *
 * Usage:
 *   node scripts/audit-wt-integ-stashes.js            # report
 *   node scripts/audit-wt-integ-stashes.js --json     # machine-readable
 *   node scripts/audit-wt-integ-stashes.js --gate     # exit 1 if any entry is dangerous to apply
 *   node scripts/audit-wt-integ-stashes.js --sha <s>  # triage one stash commit by sha
 *
 * --sha exists because a clean stack proves nothing about detection. It lets
 * you re-run the detector against an entry that has already been dropped (the
 * commit stays reachable in the object store), which is how this script's
 * acceptance test is stated:
 *
 *   node scripts/audit-wt-integ-stashes.js --gate \
 *     --sha 93658d4585564daee0ac1e34be1142e5109cf7dc
 *
 * That is the real wt-integ-94224 entry from 2026-09-06, which held
 * scripts/lib/backlog-drain.js at one line against 231. It must exit 1.
 */

const { execFileSync } = require('child_process');
const {
  classifyStashedFile,
  classifyStashEntry,
} = require('./lib/stash-truncation');

let classifyPath = () => ({ tier: null });
try {
  ({ classifyPath } = require('./lib/infra-review-scope'));
} catch {
  /* scope module is optional; tier just stays null */
}

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const gate = args.includes('--gate');

const shaFlagIndex = args.indexOf('--sha');
if (shaFlagIndex !== -1 && !args[shaFlagIndex + 1]) {
  console.error('--sha requires a commit sha');
  process.exit(2);
}
const onlySha = shaFlagIndex === -1 ? null : args[shaFlagIndex + 1];

function run(gitArgs, { allowFail = false } = {}) {
  try {
    return execFileSync('git', gitArgs, {
      encoding: 'utf-8',
      maxBuffer: 256 * 1024 * 1024,
    });
  } catch (err) {
    if (allowFail) return null;
    throw err;
  }
}

/** Line count of a blob at <rev>:<path>, or null when the path is absent there. */
function linesAt(rev, filePath) {
  const out = run(['show', rev + ':' + filePath], { allowFail: true });
  if (out === null) return null;
  if (out === '') return 0;
  return out.split('\n').length - (out.endsWith('\n') ? 1 : 0);
}

function listStashes() {
  const out = run(['stash', 'list', '--format=%H%x00%gd%x00%gs'], { allowFail: true });
  if (!out || !out.trim()) return [];
  return out
    .trim()
    .split('\n')
    .map((line) => {
      const [sha, ref, subject] = line.split('\0');
      return { sha, ref, subject };
    });
}

/** Paths the stash changes relative to its own base commit. */
function changedPaths(sha) {
  const out = run(['diff', '--name-only', sha + '^', sha], { allowFail: true });
  if (!out || !out.trim()) return [];
  return out.trim().split('\n').filter(Boolean);
}

/** Resolve one stash commit by sha, for re-checking an entry already dropped. */
function stashBySha(sha) {
  const full = run(['rev-parse', '--verify', sha + '^{commit}'], { allowFail: true });
  if (!full) {
    console.error('sha not found in this repository: ' + sha);
    process.exit(2);
  }
  const resolved = full.trim();
  const subject = (run(['log', '-1', '--format=%s', resolved], { allowFail: true }) || '').trim();
  return [{ sha: resolved, ref: resolved.slice(0, 9), subject: subject || '(dropped stash entry)' }];
}

function main() {
  const stashes = onlySha ? stashBySha(onlySha) : listStashes();
  const report = [];

  for (const stash of stashes) {
    const paths = changedPaths(stash.sha);
    const files = [];

    for (const filePath of paths) {
      const stashedLines = linesAt(stash.sha, filePath);
      const baseLines = linesAt(stash.sha + '^', filePath);
      const { tier } = classifyPath(filePath) || { tier: null };
      const verdict = classifyStashedFile({
        path: filePath,
        stashedLines,
        baseLines,
        infraTier: tier,
      });
      files.push({ path: filePath, stashedLines, baseLines, infraTier: tier, ...verdict });
    }

    const entry = classifyStashEntry(files);
    report.push({ ...stash, ...entry, files });
  }

  const dangerous = report.filter((r) => r.danger);

  if (asJson) {
    console.log(
      JSON.stringify(
        { total: report.length, dangerous: dangerous.length, entries: report },
        null,
        2
      )
    );
  } else {
    console.log(
      'Stash triage — ' + report.length + ' entr' + (report.length === 1 ? 'y' : 'ies') +
        ' on the shared stack\n'
    );
    for (const r of report) {
      const mark = r.danger ? 'DANGER' : r.severity === 'warn' ? 'INSPECT' : 'ok';
      console.log('  [' + mark + '] ' + r.ref + '  ' + r.subject);
      console.log('      verdict: ' + r.verdict);
      for (const f of r.files) {
        if (f.verdict === 'telemetry') continue;
        console.log('      - ' + f.path + ' [' + f.verdict + '] ' + f.reason);
      }
      const telemetryCount = r.files.filter((f) => f.verdict === 'telemetry').length;
      if (telemetryCount) console.log('      (+' + telemetryCount + ' telemetry path(s))');
    }
    console.log('');
    if (dangerous.length) {
      console.log(
        dangerous.length + ' entr' + (dangerous.length === 1 ? 'y is' : 'ies are') +
          ' DANGEROUS TO APPLY:'
      );
      for (const r of dangerous) {
        console.log('  ' + r.ref + ' (' + r.subject + ') — sha ' + r.sha);
      }
      console.log('\nDo not apply these to "recover" anything. Inspect a file with:');
      console.log('  git show "${SHA}:<path>"');
      console.log('  (note the braces: in zsh, "$SHA:path" parses :s as a substitute');
      console.log('   modifier, silently drops the path, and shows the WHOLE commit)');
    } else {
      console.log('No entry on the stack would destroy a file if applied.');
    }
  }

  if (gate && dangerous.length) process.exitCode = 1;
}

main();
