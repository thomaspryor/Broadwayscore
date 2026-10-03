#!/usr/bin/env node
/**
 * cloud-worker-pick.js — print the one P0/P1 card a scheduled cloud worker
 * session should take on this firing (BRO-4535). Read-only: it claims
 * nothing. Selection rules and their reasons: scripts/lib/cloud-worker-pick.js.
 *
 * Usage:
 *   node scripts/cloud-worker-pick.js           JSON: { pick, eligible, skipped }
 *
 * `pick` is null when nothing is eligible; the worker then ends with no
 * changes. Exit 0 on a completed pick (null or not), 1 when Linear can't be read.
 */

'use strict';

const { hasHelpFlag } = require('./lib/cli-help.js');

if (hasHelpFlag(process.argv)) {
  console.log('Usage: node scripts/cloud-worker-pick.js\nPrints {pick, eligible, skipped} for the cloud worker routine. Read-only.');
  process.exit(0);
}

require('./lib/load-env').loadEnv();

async function main() {
  const { listOpenIssuesWithDescriptions } = require('./lib/linear-client.js');
  const { evaluateVerifiability } = require('./lib/verify-gate.js');
  const { pickCloudCard } = require('./lib/cloud-worker-pick.js');
  const issues = await listOpenIssuesWithDescriptions();
  const { pick, eligible, skipped } = pickCloudCard(issues, { nowMs: Date.now() });
  const out = {
    pick: pick && {
      identifier: pick.identifier,
      title: pick.title,
      priority: pick.priority,
      state: pick.state && pick.state.name,
      url: pick.url,
      verify: evaluateVerifiability(pick.description || '').cmd,
    },
    eligible,
    open: issues.length,
    skipped,
  };
  console.log(JSON.stringify(out, null, 2));
}

main().catch((err) => {
  console.error(`[cloud-worker-pick] ${err && err.message ? err.message : err}`);
  process.exit(1);
});
