#!/usr/bin/env node
/**
 * auto-fix-first.js (BRO-5477): thin CLI over scripts/lib/auto-fix-first.js.
 *
 *   node scripts/auto-fix-first.js gate    # .github/actions/notify-failure, on a page-worthy failure
 *   node scripts/auto-fix-first.js sweep   # opening-night-checklist.yml, hourly
 *
 * gate reads the failing workflow from GITHUB_WORKFLOW_REF and the alert from
 * INPUT_TITLE / INPUT_DESCRIPTION. For an auto-fix-first workflow it files the
 * fix card or its second attempt (no email), holds, or sends the escalation email itself, and writes
 * `handled=true` (and `held=true` when nothing was sent) to GITHUB_OUTPUT so
 * the action's own send step stands down. For any other workflow, or if this
 * script crashes, it writes nothing and the action emails as before.
 */
'use strict';

const fs = require('fs');
const { hasHelpFlag } = require('./lib/cli-help.js');

const USAGE = 'Usage: node scripts/auto-fix-first.js gate|sweep';

function setOutput(name, value) {
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
  console.log(`[auto-fix-first] ${name}=${value}`);
}

async function runGate() {
  const policy = require('./lib/page-worthy-alerts.js');
  const lib = require('./lib/auto-fix-first.js');
  const m = String(process.env.GITHUB_WORKFLOW_REF || '').match(/\.github\/workflows\/([^@]+)/);
  const workflowFile = m ? m[1] : '';
  if (!policy.isAutoFixFirstWorkflow(workflowFile)) {
    console.log(`[auto-fix-first] ${workflowFile || '(unknown workflow)'} is not auto-fix-first; the normal alert sends.`);
    return;
  }
  const repo = process.env.GITHUB_REPOSITORY || '';
  const runUrl = repo && process.env.GITHUB_RUN_ID ? `https://github.com/${repo}/actions/runs/${process.env.GITHUB_RUN_ID}` : '';
  const title = process.env.INPUT_TITLE || `${workflowFile} failed`;
  const description = process.env.INPUT_DESCRIPTION || 'Check the run logs for details.';
  const res = await lib.gate({ key: lib.workflowKey(workflowFile), alertTitle: title, alertDescription: description, runUrl });
  console.log(`[auto-fix-first] ${workflowFile}: ${res.action} (${res.reason})${res.card ? ` card ${res.card.identifier}` : ''}`);
  if (!res.email) {
    setOutput('handled', 'true');
    setOutput('held', 'true');
    return;
  }
  if (!res.preamble) return; // kill switch: the action's normal send step emails
  const { sendAlert } = require('./lib/discord-notify.js');
  const delivered = await sendAlert({
    title: lib.escalationTitle({ reason: res.reason, what: lib.plainName(lib.workflowKey(workflowFile), title) }),
    // BRO-5498: the owner's action first, the escalation preamble next.
    description: require('./lib/page-worthy-alerts.js').withOwnerAction('auto-fix-first:escalation:', `${res.preamble}\n\n${description}`),
    severity: 'error',
    email: process.env.INPUT_EMAIL === 'true',
    fields: runUrl ? [{ name: 'Run', value: `[View logs](${runUrl})` }] : [],
    url: runUrl,
    idempotencyKey: res.card ? lib.escalationIdempotencyKey(res.card) : undefined,
  });
  // Undelivered: write nothing, so the action's own send step tries again.
  if (!delivered) return;
  await res.markEscalated();
  setOutput('handled', 'true');
}

async function runSweep() {
  const results = await require('./lib/auto-fix-first.js').sweep({});
  for (const r of results) console.log(`[auto-fix-first] sweep ${r.key}: ${r.action} (${r.reason})${r.card ? ` card ${r.card}` : ''}`);
  if (!results.length) console.log('[auto-fix-first] sweep: no auto-fix cards in the last 24h');
  if (results.some((r) => r.action === 'error')) process.exitCode = 1;
}

async function main() {
  const mode = process.argv[2];
  if (hasHelpFlag(process.argv) || !['gate', 'sweep'].includes(mode)) {
    console.log(USAGE);
    process.exit(hasHelpFlag(process.argv) ? 0 : 2);
  }
  if (mode === 'gate') await runGate();
  else await runSweep();
}

if (require.main === module) {
  main().catch((e) => {
    console.error(`[auto-fix-first] ${e.stack || e.message}`);
    process.exit(1);
  });
}
