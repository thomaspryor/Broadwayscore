#!/usr/bin/env node
/**
 * Is a Linear agent runner actually executing, or just accepting work?
 *
 * WHY THIS EXISTS
 * On 2026-08-16 the hosted Cyrus runner accepted ten delegations and produced
 * ZERO activities on all ten — Linear happily created a session for each, the
 * board showed them assigned, and nothing ran. From Linear's UI that is almost
 * indistinguishable from "working on it". The only reliable signal is whether
 * the agent session accrues ACTIVITIES.
 *
 * So: delegate a trivial ask to one runner, wait, and report activities. An
 * agent session with 0 activities after the timeout is a dead runner, whatever
 * its status field says.
 *
 * Usage:
 *   node tools/linear-migration/check-runner.js --runner=cyrus     # hosted (Team Cloud)
 *   node tools/linear-migration/check-runner.js --runner=cyrus1    # self-hosted (Mac)
 *   node tools/linear-migration/check-runner.js --runner=codex
 *   [--issue=BRO-338] [--timeout=180]
 *
 * Exit 0 = runner produced activities. Exit 1 = accepted but produced nothing.
 *
 * COSTS QUOTA: a runner on a bring-your-own-Claude-token plan spends the
 * owner's Claude quota to answer this. Probe once, not in a loop.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { hasHelpFlag } = require('../../scripts/lib/cli-help.js');
const { assessDelegations } = require('../../scripts/lib/linear-delegation-health.js');

const USAGE = `check-runner.js — prove a Linear agent runner actually executes.

  --runner=<displayName>   cyrus (hosted) | cyrus1 (self-hosted) | codex   [required]
  --issue=<identifier>     scratch issue to probe on (default BRO-338)
  --timeout=<seconds>      how long to wait for activities (default 180)
  --help, -h               this message

Exit 0 = activities appeared. Exit 1 = session created but nothing ran.`;

const args = process.argv.slice(2);
if (hasHelpFlag(args)) {
  console.log(USAGE);
  process.exit(0);
}

const arg = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=')[1] : fallback;
};

const RUNNER = arg('runner');
const ISSUE = arg('issue', 'BRO-338');
const TIMEOUT_S = Number(arg('timeout', '180'));

if (!RUNNER) {
  console.error('--runner is required (cyrus | cyrus1 | codex)\n');
  console.error(USAGE);
  process.exit(2);
}

function linearKey() {
  if (process.env.LINEAR_API_KEY) return process.env.LINEAR_API_KEY;
  const envPath = path.join(os.homedir(), 'Broadwayscore', '.env');
  const m = fs.readFileSync(envPath, 'utf8').match(/^LINEAR_API_KEY=(.+)$/m);
  if (!m) throw new Error(`LINEAR_API_KEY not found in env or ${envPath}`);
  return m[1].trim().replace(/^"|"$/g, '');
}

const KEY = linearKey();

async function gql(query, variables = {}) {
  const res = await fetch('https://api.linear.app/graphql', {
    method: 'POST',
    headers: { authorization: KEY, 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  const out = await res.json();
  if (out.errors) throw new Error(JSON.stringify(out.errors).slice(0, 300));
  return out.data;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const { users } = await gql(
    'query($n:String!){ users(first:1, filter:{displayName:{eq:$n}}){ nodes { id displayName } } }',
    { n: RUNNER }
  );
  if (!users.nodes.length) throw new Error(`no Linear user with displayName "${RUNNER}"`);
  const runnerId = users.nodes[0].id;

  const { issue } = await gql('query($i:String!){ issue(id:$i){ id identifier } }', { i: ISSUE });
  const startedAt = new Date().toISOString();

  await gql('mutation($id:String!,$d:String!){ issueUpdate(id:$id, input:{delegateId:$d}){ success } }',
    { id: issue.id, d: runnerId });
  // Delegation alone never starts a Linear agent — the kickoff comment does.
  await gql('mutation($i:String!,$b:String!){ commentCreate(input:{issueId:$i, body:$b}){ success } }', {
    i: issue.id,
    b: `@${RUNNER} runner health probe. Reply with the single word ALIVE and nothing else. Do not read the repo, do not change any code, do not open a PR.`,
  });
  console.log(`probing ${RUNNER} on ${issue.identifier} (up to ${TIMEOUT_S}s)…`);

  const deadline = Date.now() + TIMEOUT_S * 1000;
  let last = { status: 'none', verdict: 'none' };
  while (Date.now() < deadline) {
    await sleep(10000);
    // Read the activity BODIES, not just the count. Counting alone reports a
    // session whose only activity is "Blocked by …" as ALIVE — which is exactly
    // how BRO-374 was mistaken for running on 2026-08-17. assessDelegations()
    // is the shared judge, so this probe and the digest alarm cannot disagree.
    const { agentSessions } = await gql(
      `query{ agentSessions(first:6){ nodes { createdAt status appUser { displayName }
        activities { nodes { createdAt content {
          __typename
          ... on AgentActivityThoughtContent { body }
          ... on AgentActivityResponseContent { body }
          ... on AgentActivityActionContent { action }
        } } } } } }`
    );
    const mine = agentSessions.nodes.filter(
      (s) => s.appUser.displayName === RUNNER && s.createdAt >= startedAt
    );
    if (mine.length) {
      const { verdicts } = assessDelegations([{
        identifier: issue.identifier,
        delegateName: RUNNER,
        sessions: mine.map((s) => ({
          createdAt: s.createdAt,
          status: s.status,
          activities: s.activities.nodes.map((a) => ({
            createdAt: a.createdAt,
            typename: a.content.__typename,
            body: a.content.body || a.content.action || '',
          })),
        })),
      }]);
      last = { status: mine[0].status, verdict: verdicts[0]?.verdict || 'none' };
      // 'finished' is the probe's SUCCESS case, not a miss: it asks for a
      // one-word reply, so a healthy runner answers and ends its session
      // almost immediately. Accepting only 'working' meant the faster a runner
      // completed, the more certainly this reported it DEAD.
      if (last.verdict === 'working' || last.verdict === 'finished') {
        console.log(`ALIVE — ${RUNNER} ${last.verdict === 'finished' ? 'answered and completed' : 'is doing real work'} (${verdicts[0].detail}, status ${last.status})`);
        process.exit(0);
      }
      if (last.verdict === 'blocked') {
        console.log(`\nNOT RUNNING — ${RUNNER} accepted the work but is blocked: ${verdicts[0].detail}`);
        process.exit(1);
      }
    }
    process.stdout.write('.');
  }

  console.log(
    `\nDEAD — ${RUNNER} accepted the delegation but produced no real work in ${TIMEOUT_S}s ` +
      `(last status: ${last.status}, verdict: ${last.verdict}). Boilerplate openers are not work; ` +
      `a session that only greets you is a runner that is not executing, whatever the board shows.`
  );
  process.exit(1);
}

main().catch((err) => {
  console.error(`FATAL ${err.message}`);
  process.exit(2);
});
