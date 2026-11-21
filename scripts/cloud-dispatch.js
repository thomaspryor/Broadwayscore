#!/usr/bin/env node
'use strict';
/**
 * cloud-dispatch.js (BRO-5892): dispatch a workflow on main and optionally wait for it, over REST only.
 * Use this in cloud sessions instead of `gh workflow run` (which needs GraphQL unless given --ref) or the
 * MCP actions_run_trigger (which cannot wait).
 *
 * Usage: node scripts/cloud-dispatch.js <workflow.yml> [-f key=value ...] [--ref=main] [--wait] [--timeout=MIN]
 *                                       [--match=TEXT] [--repo=owner/name]
 *   --match  text the run's title must contain. Defaults to a workflow's known run-name
 *            (execute-approved-fix.yml: "execute-approved-fix <issue_number> [").
 * Exit 0 dispatched (and, with --wait, succeeded); 1 the run failed; 2 bad usage, run not found, ambiguous, or timeout.
 */
const { dispatch, listRunIds, findRun, waitRun, DEFAULT_REPO } = require('./lib/rest-dispatch');

const USAGE = 'Usage: node scripts/cloud-dispatch.js <workflow.yml> [-f key=value ...] [--ref=main] [--wait] [--timeout=MIN] [--match=TEXT] [--repo=owner/name]';

// Workflows whose run-name carries an input, so parallel runs are told apart.
const KNOWN_MATCH = {
  // "[" ends the id, so bro-9 does not also match bro-9-b's run.
  // With a mode, "]" too, so an apply run is not mixed up with a dry run of the same plan.
  'execute-approved-fix.yml': (inputs) => inputs.issue_number && `execute-approved-fix ${inputs.issue_number} [${inputs.mode ? `${inputs.mode}]` : ''}`,
  // BRO-6266: the answer text stays out of the run title (the Actions page is readable).
  'record-owner-answer.yml': (inputs) => inputs.issue && `record-owner-answer ${inputs.issue} [`,
  // BRO-6368: a brief post run is titled by its hash (fixed length, so no prefix clash).
  'social-autopost.yml': (inputs) => inputs.brief && `Social Autopost brief ${inputs.brief}`,
};

function parseArgs(argv) {
  const opts = { inputs: {}, ref: 'main', wait: false, timeoutMin: 60, repo: DEFAULT_REPO, match: null, workflow: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-f' || a === '--field') {
      const kv = argv[++i] || '';
      const eq = kv.indexOf('=');
      if (eq <= 0) throw new Error(`-f expects key=value, got "${kv}"`);
      opts.inputs[kv.slice(0, eq)] = kv.slice(eq + 1);
    } else if (a === '--wait') opts.wait = true;
    else if (a.startsWith('--ref=')) opts.ref = a.slice(6);
    else if (a.startsWith('--timeout=')) opts.timeoutMin = Number(a.slice(10));
    else if (a.startsWith('--match=')) opts.match = a.slice(8);
    else if (a.startsWith('--repo=')) opts.repo = a.slice(7);
    else if (!a.startsWith('-') && !opts.workflow) opts.workflow = a;
    else throw new Error(`Unknown argument: ${a}`);
  }
  if (!opts.workflow) throw new Error('No workflow given');
  if (!/\.ya?ml$/.test(opts.workflow)) opts.workflow += '.yml';
  if (!(opts.timeoutMin > 0)) throw new Error('--timeout must be a positive number of minutes');
  if (opts.match == null && KNOWN_MATCH[opts.workflow]) opts.match = KNOWN_MATCH[opts.workflow](opts.inputs) || null;
  return opts;
}

function main(argv, deps = {}) {
  let opts;
  try { opts = parseArgs(argv); } catch (e) { console.error(`${e.message}\n${USAGE}`); return 2; }
  const since = new Date().toISOString();
  let exclude;
  try {
    exclude = listRunIds({ workflow: opts.workflow, repo: opts.repo, ...deps });
    dispatch({ workflow: opts.workflow, inputs: opts.inputs, ref: opts.ref, repo: opts.repo, ...deps });
  } catch (e) {
    console.error(`Dispatch failed: ${(e.stderr || e.message || '').toString().trim()}`);
    return 2;
  }
  console.log(`Dispatched ${opts.workflow} on ${opts.ref}${Object.keys(opts.inputs).length ? ` with ${JSON.stringify(opts.inputs)}` : ''}`);
  // Exit 1 means the run failed. An API that keeps failing while we look or wait is "unknown": 2.
  try {
    return follow(opts, since, exclude, deps);
  } catch (e) {
    console.error(`GitHub API kept failing, run state unknown: ${(e.stderr || e.message || '').toString().trim()}`);
    return 2;
  }
}

function follow(opts, since, exclude, deps) {
  const found = findRun({ workflow: opts.workflow, since, match: opts.match, exclude, repo: opts.repo, ...deps });
  if (found.ambiguous) {
    console.error(`More than one new run${opts.match ? ` titled "${opts.match}"` : ''}; pass --match=<text from the run title>:`);
    for (const r of found.ambiguous) console.error(`  ${r.html_url} ${r.display_title}`);
    return 2;
  }
  if (!found.run) { console.error('Dispatched, but no run appeared within 3 minutes. Check the Actions tab.'); return 2; }
  console.log(`Run: ${found.run.html_url}`);
  if (!opts.wait) return 0;
  const run = waitRun({ runId: found.run.id, repo: opts.repo, timeoutMs: opts.timeoutMin * 60 * 1000, onPoll: (r) => console.log(`  ${r && r.status}...`), ...deps });
  if (!run) { console.error(`Still running after ${opts.timeoutMin} min: ${found.run.html_url}`); return 2; }
  console.log(`Conclusion: ${run.conclusion} ${run.html_url}`);
  return run.conclusion === 'success' ? 0 : 1;
}

module.exports = { parseArgs, main };

if (require.main === module) {
  const argv = process.argv.slice(2);
  if (require('./lib/cli-help').hasHelpFlag(argv)) { console.log(USAGE); process.exit(0); }
  process.exit(main(argv));
}
