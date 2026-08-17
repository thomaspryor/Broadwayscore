#!/usr/bin/env node
/**
 * linear-session.js — session-level Linear reporting CLI (BRO-387 Phase 1).
 *
 * The Linear twin of scripts/notion-brain.js's create/update loop. Notion
 * enforces "every session has a card" with 13 hooks; Linear had nothing —
 * sessions could do real work and the board would never learn it happened.
 * This CLI is the I/O layer over scripts/lib/linear-session-reporting.js's
 * pure decision functions (planClaim/planCompletion/buildOutcomeCommentBody/
 * findIssueByExactTitle) and scripts/lib/linear-client.js's GraphQL calls —
 * same split as notion-brain.js (CLI + I/O) vs the pure guards it calls into.
 *
 * Usage:
 *   node scripts/linear-session.js claim --issue=BRO-123
 *   node scripts/linear-session.js claim --title="Ad hoc fix" --description="..." [--priority=2] [--project="Data"]
 *   node scripts/linear-session.js report --issue=<id-or-identifier> --status=<done|in-review|paused|blocked> \
 *     --summary="what changed" [--key-files="a.js,b.js"] [--verification="node --test ..."]
 *   node scripts/linear-session.js ping
 *
 * `claim` prints a __LINEAR_ISSUE_ID__=<id> tagged marker (parsed by
 * ~/.claude/hooks/linear-issue-verify.sh to write the per-session "claimed"
 * sentinel); `report` prints the same marker to write the "reported"
 * sentinel — ~/.claude/hooks/linear-issue-required-stop.sh's refusal path
 * (evaluateSessionClose) gates on the REPORTED sentinel, not claimed, so a
 * session that claims and never reports still gets blocked at Stop.
 *
 * Env: LINEAR_API_KEY in .env or environment (read lazily by linear-client.js).
 */

'use strict';

const linear = require('./lib/linear-client');
const { createLinearIssue } = require('./lib/linear-issue-create');
const lsr = require('./lib/linear-session-reporting');

const USAGE = `Usage:
  node scripts/linear-session.js claim --issue=BRO-123
  node scripts/linear-session.js claim --title="..." --description="..." [--priority=2] [--project="Name"]
  node scripts/linear-session.js report --issue=<id-or-identifier> --status=<done|in-review|paused|blocked> --summary="..." [--key-files="a,b"] [--verification="..."]
  node scripts/linear-session.js ping`;

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok.startsWith('--')) {
      const raw = tok.slice(2);
      const eq = raw.indexOf('=');
      if (eq !== -1) {
        args[raw.slice(0, eq)] = raw.slice(eq + 1);
        continue;
      }
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        args[raw] = true;
      } else {
        args[raw] = next;
        i++;
      }
    } else {
      args._.push(tok);
    }
  }
  return args;
}

async function resolveProjectId(name) {
  const projects = await linear.listProjects();
  const target = String(name).trim().toLowerCase();
  const match = projects.find((p) => p && String(p.name).trim().toLowerCase() === target);
  if (!match) {
    throw new Error(
      `No Linear project named "${name}" — known projects: ${projects.map((p) => p.name).join(', ') || '(none)'}`
    );
  }
  return match.id;
}

function splitKeyFiles(raw) {
  if (!raw) return [];
  return String(raw)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

async function cmdClaim(args) {
  let issue = null;
  if (args.issue) {
    issue = await linear.getIssue(args.issue);
    if (!issue) throw new Error(`No Linear issue found for "${args.issue}"`);
  } else if (args.title) {
    // Exact-title dedup, not linear-client.js's searchIssues() — that helper
    // is built for the alert router's substring conditionKey scan and would
    // false-match a different issue whose title merely contains this one.
    const openIssues = await linear.listOpenIssues();
    issue = lsr.findIssueByExactTitle(openIssues, args.title);
  } else {
    throw new Error(`claim requires --issue=BRO-N or --title="..."\n\n${USAGE}`);
  }

  const team = await linear.getTeam();
  const plan = lsr.planClaim({
    issue,
    states: team.states,
    requestedTitle: args.title,
    requestedDescription: args.description,
  });

  let result;
  if (plan.action === 'create') {
    const projectId = args.project ? await resolveProjectId(args.project) : undefined;
    const priority = args.priority !== undefined ? Number(args.priority) : undefined;
    // createLinearIssue({dispatch:true}) always lands the new issue in the
    // 'unstarted' (Todo) state (linear-issue-create.js's pickStateForMode
    // contract — dispatch mode deliberately never picks 'started', see that
    // file's header). A claim means "start it now", so immediately move it
    // to the state planClaim already resolved (In Progress).
    const { issue: created } = await createLinearIssue({
      title: plan.title,
      description: plan.description,
      dispatch: true,
      priority,
      projectId,
    });
    await linear.updateIssue(created.id, { stateId: plan.stateId });
    result = await linear.getIssue(created.identifier);
  } else if (plan.action === 'activate') {
    await linear.updateIssue(plan.issueId, { stateId: plan.stateId });
    result = issue;
  } else {
    result = issue;
  }

  console.log(lsr.buildIssueIdMarker(result.id));
  console.log(
    JSON.stringify({
      id: result.id,
      identifier: result.identifier,
      url: result.url,
      action: plan.action,
      stateName: plan.stateName,
    })
  );
}

async function cmdReport(args) {
  if (!args.issue) throw new Error(`report requires --issue=<id-or-identifier>\n\n${USAGE}`);
  if (!args.status) throw new Error(`report requires --status=<done|in-review|paused|blocked>\n\n${USAGE}`);
  if (!args.summary) throw new Error(`report requires --summary="..."\n\n${USAGE}`);

  const issue = await linear.getIssue(args.issue);
  if (!issue) throw new Error(`No Linear issue found for "${args.issue}"`);

  const body = lsr.buildOutcomeCommentBody({
    summary: args.summary,
    keyFiles: splitKeyFiles(args['key-files']),
    verification: args.verification,
    status: args.status,
  });
  await linear.createComment(issue.id, body);

  const team = await linear.getTeam();
  const completion = lsr.planCompletion({ status: args.status, states: team.states });
  if (completion.stateId) {
    await linear.updateIssue(issue.id, { stateId: completion.stateId });
  }

  console.log(lsr.buildIssueIdMarker(issue.id));
  console.log(
    JSON.stringify({
      id: issue.id,
      identifier: issue.identifier,
      status: args.status,
      stateName: completion.stateName || (issue.state && issue.state.name) || null,
    })
  );
}

async function cmdPing() {
  await linear.getTeam();
  console.log('OK');
}

async function main(argv = process.argv.slice(2)) {
  const [cmd, ...rest] = argv;
  const args = parseArgs(rest);
  if (!cmd || args.help || args.h) {
    console.log(USAGE);
    return;
  }
  if (cmd === 'claim') return cmdClaim(args);
  if (cmd === 'report') return cmdReport(args);
  if (cmd === 'ping') return cmdPing();
  throw new Error(`Unknown command "${cmd}".\n\n${USAGE}`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { parseArgs, resolveProjectId, splitKeyFiles, cmdClaim, cmdReport, cmdPing, main, USAGE };
