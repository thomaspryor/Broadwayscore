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

// Goes through the shared transport rather than its own fetch (S1-T1). This
// used to hand-roll a POST to the GraphQL endpoint with its own key lookup,
// which made it the one Linear consumer that did NOT inherit the 429/5xx
// backoff added to scripts/lib/linear-client.js — and it pages through
// agentSessions in a loop, so it is exactly the shape that trips a rate limit.
// Its old key lookup also hard-coded ~/Broadwayscore/.env, which resolves to
// the wrong file when this runs from a worktree; linear-client's readEnvKeys
// finds the repo's .env either way.
const linear = require('./lib/linear-client.js');

const gql = (query) => linear.graphql(query);

// Sessions come back newest-first, so WITHOUT paging the longest-stalled
// delegations are the first to fall off the page — the alarm would go quiet
// exactly as a problem got worse. BRO-263, stalled five days, was already the
// last node on a 50-item page when this was written.
//
// The activity fragments must cover every union member. Any type not spread
// here arrives with an empty body, and an empty body used to be scored as
// substantive work, so a crashed agent read as healthy.
const SESSION_PAGE = (after) => `query {
  agentSessions(first: 50${after ? `, after: "${after}"` : ''}) {
    pageInfo { hasNextPage endCursor }
    nodes {
      createdAt status
      issue { identifier state { name type } delegate { displayName } }
      activities { nodes { createdAt content {
        __typename
        ... on AgentActivityThoughtContent { body }
        ... on AgentActivityResponseContent { body }
        ... on AgentActivityActionContent { action }
        ... on AgentActivityElicitationContent { body }
        ... on AgentActivityErrorContent { body }
      } } }
    }
  }
}`;

// Bounded so a runaway workspace cannot loop forever; 10 pages = 500 sessions.
const MAX_PAGES = 10;

async function fetchAllSessions() {
  const nodes = [];
  let after = null;
  let pages = 0;
  let truncated = false;
  for (;;) {
    const page = (await gql(SESSION_PAGE(after))).agentSessions;
    nodes.push(...page.nodes);
    pages += 1;
    if (!page.pageInfo.hasNextPage) break;
    if (pages >= MAX_PAGES) { truncated = true; break; }
    after = page.pageInfo.endCursor;
  }
  return { nodes, truncated };
}

async function main() {
  const { nodes: sessionNodes, truncated } = await fetchAllSessions();
  if (truncated) {
    console.warn(`WARN stopped after ${MAX_PAGES} pages — older sessions were not examined`);
  }

  // Group sessions by issue, keeping only issues still delegated and open.
  const byIssue = new Map();
  for (const s of sessionNodes) {
    const iss = s.issue;
    if (!iss || !iss.delegate) continue;
    // Filter on state.TYPE, not name: names are user-editable in Linear, so
    // renaming "Done" to "Shipped" would drag every finished issue back into
    // scope and alarm on it every morning forever.
    if (['completed', 'canceled', 'duplicate'].includes(iss.state?.type)) continue;
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

  // Atomic write: writeFileSync truncates in place, so the digest reading at
  // 07:30 could catch a torn file — and unparseable status renders as silence,
  // which is the failure this whole script exists to prevent.
  fs.mkdirSync(path.dirname(STATUS_PATH), { recursive: true });
  const tmp = `${STATUS_PATH}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify({ at: new Date().toISOString(), alarm, truncated, verdicts }, null, 2)}\n`);
  fs.renameSync(tmp, STATUS_PATH);

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
