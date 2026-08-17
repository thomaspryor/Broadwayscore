#!/usr/bin/env node
/**
 * Closes the ALARM loop: tell the owner when a delegated Linear agent accepted
 * work and is doing nothing.
 *
 * The board cannot show this. On 2026-08-16 ten delegated issues displayed as
 * assigned and `active` with zero output, and it surfaced only because the
 * owner happened to ask. Nothing watches for it.
 *
 * Writes ~/.cyrus/linear-delegation-status.json, which the morning digest
 * reads. Exit 1 if anything is stalled, so it can also be used as a check.
 *
 * Usage: node scripts/check-linear-delegations.js [--json] [--help]
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { hasHelpFlag } = require('./lib/cli-help.js');
const { assessDelegations } = require('./lib/linear-delegation-health.js');

const USAGE = `check-linear-delegations.js — find delegated Linear issues that are silently doing nothing.

  --json     print the full verdict list as JSON
  --help,-h  this message

Writes ~/.cyrus/linear-delegation-status.json for the morning digest.
Exit 0 = nothing stalled. Exit 1 = at least one delegated agent is dead.`;

const args = process.argv.slice(2);
if (hasHelpFlag(args)) {
  console.log(USAGE);
  process.exit(0);
}

const STATUS_PATH = path.join(process.env.CYRUS_HOME || path.join(os.homedir(), '.cyrus'),
  'linear-delegation-status.json');

function linearKey() {
  if (process.env.LINEAR_API_KEY) return process.env.LINEAR_API_KEY;
  const envPath = path.join(os.homedir(), 'Broadwayscore', '.env');
  const m = fs.readFileSync(envPath, 'utf8').match(/^LINEAR_API_KEY=(.+)$/m);
  if (!m) throw new Error(`LINEAR_API_KEY not found in env or ${envPath}`);
  return m[1].trim().replace(/^"|"$/g, '');
}

async function gql(query) {
  const res = await fetch('https://api.linear.app/graphql', {
    method: 'POST',
    headers: { authorization: linearKey(), 'content-type': 'application/json' },
    body: JSON.stringify({ query }),
    signal: AbortSignal.timeout(30000),
  });
  const out = await res.json();
  if (out.errors) throw new Error(JSON.stringify(out.errors).slice(0, 300));
  return out.data;
}

// Sessions are the authoritative view: an issue can carry a delegate with no
// session at all, which is its own failure mode.
const QUERY = `query {
  agentSessions(first: 50) {
    nodes {
      createdAt status
      issue { identifier state { name } delegate { displayName } }
      activities { nodes { createdAt content {
        __typename
        ... on AgentActivityThoughtContent { body }
        ... on AgentActivityResponseContent { body }
        ... on AgentActivityActionContent { action }
      } } }
    }
  }
}`;

async function main() {
  const data = await gql(QUERY);

  // Group sessions by issue, keeping only issues still delegated and open.
  const byIssue = new Map();
  for (const s of data.agentSessions.nodes) {
    const iss = s.issue;
    if (!iss || !iss.delegate) continue;
    if (['Done', 'Canceled', 'Duplicate'].includes(iss.state?.name)) continue;
    if (!byIssue.has(iss.identifier)) {
      byIssue.set(iss.identifier, { identifier: iss.identifier, delegateName: iss.delegate.displayName, sessions: [] });
    }
    byIssue.get(iss.identifier).sessions.push({
      createdAt: s.createdAt,
      status: s.status,
      activities: s.activities.nodes.map((a) => ({
        createdAt: a.createdAt,
        typename: a.content.__typename,
        body: a.content.body || a.content.action || '',
      })),
    });
  }

  const { verdicts, alarm } = assessDelegations([...byIssue.values()]);

  fs.mkdirSync(path.dirname(STATUS_PATH), { recursive: true });
  fs.writeFileSync(STATUS_PATH, `${JSON.stringify({ at: new Date().toISOString(), alarm, verdicts }, null, 2)}\n`);

  if (args.includes('--json')) {
    console.log(JSON.stringify({ alarm, verdicts }, null, 2));
  } else {
    for (const v of verdicts) console.log(`${v.verdict.padEnd(14)} ${v.identifier}  ${v.detail}`);
    console.log(alarm ? `\nALARM: ${alarm}` : '\nno stalled delegations');
  }

  process.exit(verdicts.some((v) => v.verdict === 'stalled' || v.verdict === 'never-started') ? 1 : 0);
}

main().catch((err) => {
  console.error(`FATAL ${err.message}`);
  process.exit(2);
});
