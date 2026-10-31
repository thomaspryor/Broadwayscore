#!/usr/bin/env node
'use strict';
/**
 * audit-core-data-writers.js — advisory (BRO-3514).
 *
 * Re-derives which workflows write each private-core-data 'single-writer'
 * file in scripts/lib/core-data-merge-registry.js and compares the result to
 * the entry's hand-verified `writers` list. push-core-data does not reconcile
 * these files, so an undocumented second writer can silently drop the other
 * writer's update (critic-consensus.json had three writers while the
 * registry said one workflow, followers/subscribers three while it said one).
 *
 * Detection is static and heuristic (findCoreDataWriters in
 * scripts/lib/api-fallback-writer-drift.js). It ALWAYS exits 0 (advisory, per
 * CLAUDE.md §19); drift shows as ::warning:: lines in the lint-workflows job.
 *
 * Usage: node scripts/audit-core-data-writers.js [--json]
 *   On drift: hand-verify the new writer, then either add it to `writers`
 *   (and a multiWriterMitigation if writers can run concurrently) or give the
 *   file a real merge function (status 'active').
 */
require('./lib/cli-help').exitOnHelp(module);

const fs = require('fs');
const path = require('path');
const { CORE_DATA_MERGE_REGISTRY } = require('./lib/core-data-merge-registry');
const { findCoreDataWriters, checkCoreDataEntry } = require('./lib/api-fallback-writer-drift');

const ROOT = path.resolve(__dirname, '..');

function loadWorkflowTexts(root = ROOT) {
  const dir = path.join(root, '.github', 'workflows');
  const out = {};
  for (const f of fs.readdirSync(dir).filter((x) => /\.ya?ml$/.test(x)).sort()) out[f] = fs.readFileSync(path.join(dir, f), 'utf8');
  return out;
}

function auditCoreDataWriters({ root = ROOT, registry = CORE_DATA_MERGE_REGISTRY } = {}) {
  const workflowTexts = loadWorkflowTexts(root);
  const readFile = (rel) => { try { return fs.readFileSync(path.join(root, rel), 'utf8'); } catch { return null; } };
  return registry
    .filter((e) => e.surface === 'private-core-data' && e.status === 'single-writer')
    .map((entry) => {
      const derivedWriters = findCoreDataWriters(entry.file, workflowTexts, readFile);
      return { file: entry.file, declared: entry.writers || null, derivedWriters, ...checkCoreDataEntry(entry, derivedWriters, workflowTexts) };
    });
}

function main() {
  const results = auditCoreDataWriters();
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(results, null, 2));
    return;
  }
  for (const r of results) {
    const line = `${r.file}: ${r.status}${r.reason ? ` — ${r.reason}` : ''} (declared: ${(r.declared || []).join(', ') || 'none'}; found: ${r.derived.join(', ') || 'none'})`;
    if (r.status === 'drift' || r.status === 'undeclared') console.log(`::warning::core-data writer drift: ${line}`);
    else console.log(`  ${line}`);
  }
  const bad = results.filter((r) => r.status === 'drift' || r.status === 'undeclared').length;
  console.log(`\n${results.length} single-writer core-data file(s) checked, ${bad} with drift (advisory; exit 0).`);
}

if (require.main === module) {
  try {
    main();
  } catch (e) {
    // Advisory means advisory: a crash in this heuristic must not redden lint-workflows.
    console.log(`::warning::audit-core-data-writers crashed (advisory, exit 0): ${e && e.stack ? e.stack.split('\n')[0] : e}`);
  }
}

module.exports = { auditCoreDataWriters, loadWorkflowTexts };
