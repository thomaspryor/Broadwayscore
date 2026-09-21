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
 *     --summary="what changed" [--key-files="a.js,b.js"] [--verification="node --test ..."] \
 *     [--since=<ISO8601>]
 *   node scripts/linear-session.js ping
 *
 * `claim` prints a __LINEAR_ISSUE_ID__=<id> tagged marker (parsed by
 * ~/.claude/hooks/linear-issue-verify.sh to write the per-session "claimed"
 * sentinel); `report` prints the same marker to write the "reported"
 * sentinel — ~/.claude/hooks/linear-issue-required-stop.sh's refusal path
 * (evaluateSessionClose) gates on the REPORTED sentinel, not claimed, so a
 * session that claims and never reports still gets blocked at Stop.
 *
 * `report --since=<ISO8601 timestamp this session last knew the issue's
 * state>` runs scripts/lib/linear-staleness-check.js against the issue this
 * call already fetches (no extra round trip) and prints a loud stderr
 * warning — never blocks — when the card moved without this session seeing
 * it: reached a terminal state, or picked up comments after --since (BRO-3869,
 * filed after a sibling session concluded+shipped BRO-3456 while this session
 * was independently still investigating it and, on re-entry, proposed
 * reverting the already-shipped decision). Pass --since whenever this report
 * proposes or follows a production-impacting action (a flag change, a deploy,
 * an incident card) on a card you didn't just create — the warning is your
 * cue to re-read the issue's comments and surface any divergence to the
 * owner BEFORE that action lands, not after.
 *
 * Env: LINEAR_API_KEY in .env or environment (read lazily by linear-client.js).
 */

'use strict';

const linear = require('./lib/linear-client');
const { createLinearIssue } = require('./lib/linear-issue-create');
const lsr = require('./lib/linear-session-reporting');
const { checkLinearDoneTransition } = require('./lib/linear-done-gate');
const { makeVerifyEvidence } = require('./lib/done-evidence-verify');
const { makeVerifyCmdEvidence } = require('./lib/linear-cmd-execution');
const { appendBypassRow } = require('./lib/linear-gate-bypass-ledger');
const { sortedCommentBodies } = require('./lib/linear-dispatch.js');
const { checkIssueStaleness, newestComments } = require('./lib/linear-staleness-check');

const USAGE = `Usage:
  node scripts/linear-session.js claim --issue=BRO-123
  node scripts/linear-session.js claim --title="..." --description="..." [--priority=2] [--project="Name"]
  node scripts/linear-session.js report --issue=<id-or-identifier> --status=<done|in-review|paused|blocked> --summary="..." [--key-files="a,b"] [--verification="..."] [--force="<reason ≥10 chars>"] [--since=<ISO8601>]
  node scripts/linear-session.js ping

  report --status=done is REFUSED (exit 5) unless the issue carries
  done-evidence: a "PR-EVIDENCE: merged deployed checked (<url>)" line, or a
  safe-form verification command in an "## Acceptance criteria" section /
  "VERIFY: <cmd>" line — read from the issue description, its existing
  comments, and this call's own outcome comment. Bypass with
  --force="<reason ≥10 chars>", or LINEAR_DONE_GATE_DISABLED=1 for automation
  that must not block (BRO-457).

  --since=<ISO8601>: when THIS session last knew the issue's state (its own
  claim time or last read/comment) — re-checked, never blocking, against the
  issue this call fetches. Warns on stderr and sets "staleness" in the
  printed JSON if the card reached a terminal state or picked up comments
  after that timestamp (BRO-3869) — pass it before a report that proposes a
  production-impacting action.`;

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
  const team = await linear.getTeam();
  let issue = null;
  if (args.issue) {
    issue = await linear.getIssue(args.issue);
    if (!issue) throw new Error(`No Linear issue found for "${args.issue}"`);
  } else if (args.title) {
    // Exact-title dedup over ALL issues (open + closed) via linear.listIssues,
    // not linear-client.js's listOpenIssues() — that query filters OUT
    // completed/canceled issues AND its nodes don't even carry `id` (only
    // identifier/title/priority/url/updatedAt/state/labels — see
    // buildOpenIssuesQuery), so an "activate"/"noop" plan built from it would
    // pass `updateIssue(undefined, ...)`. Not linear-client.js's
    // searchIssues() either — that's built for the alert router's substring
    // conditionKey scan and would false-match a title that's merely a
    // substring of another.
    //
    // listIssues() itself returns `state` FLATTENED to a bare name string
    // plus a separate `stateType` field (see its mapping in linear-client.js)
    // — a different shape from getIssue()/listOpenIssues()'s `state:{name,
    // type}` object that planClaim expects. Verified live against BRO-387
    // (task notes: state comes back as "In Progress", stateType as
    // "started"). Re-nest before handing to findIssueByExactTitle/planClaim
    // so a Done/Canceled issue with a matching title is found and correctly
    // REOPENED, and an already-active one is correctly left as a noop
    // instead of every match being forced through 'activate'.
    const allIssues = (await linear.listIssues(team.id)).map((iss) => ({
      ...iss,
      state: { name: iss.state, type: iss.stateType },
    }));
    issue = lsr.findIssueByExactTitle(allIssues, args.title);
  } else {
    throw new Error(`claim requires --issue=BRO-N or --title="..."\n\n${USAGE}`);
  }

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
    if (!result) {
      // Read-after-write isn't guaranteed instant; the issue WAS created and
      // activated (both mutations above succeeded) — fall back to what
      // createIssue's own response gave us rather than crashing on
      // result.id below with an unhelpful TypeError.
      result = { id: created.id, identifier: created.identifier, url: null };
    }
  } else if (plan.action === 'activate') {
    if (plan.reopenedFromTerminal) {
      // BRO-3869: fires unconditionally on every claim of a previously-Done/
      // Canceled issue — no flag to remember, unlike report --since=. Print
      // BEFORE the mutation so the session reads why it was concluded
      // before doing anything else. issue.comments is only populated on the
      // --issue path (getIssue's query fetches it); the --title path's
      // listIssues() doesn't carry comments, so this degrades to the state
      // name + a pointer to the issue URL rather than silently saying nothing.
      console.error(`\n⚠️  ${issue.identifier} was "${plan.previousStateName}" (a concluded state) — you're reopening it.`);
      console.error('   Read why it was concluded before proceeding:');
      const comments = newestComments(issue, 3);
      if (comments.length > 0) {
        for (const c of comments) {
          const author = (c.user && c.user.name) || 'unknown';
          const snippet = String(c.body || '').replace(/\s+/g, ' ').slice(0, 200);
          console.error(`   [${c.createdAt}] ${author}: ${snippet}${snippet.length === 200 ? '…' : ''}`);
        }
      } else if (issue.url) {
        console.error(`   (no comment history fetched on this path — read ${issue.url} directly)`);
      }
      console.error('');
    }
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

// deps.verifyEvidence / deps.verifyCmdEvidence: tests inject stubs; the CLI
// gets the real git/gh-backed verifier from done-evidence-verify.js and the
// real command executor from linear-cmd-execution.js (see the gate call
// below).
async function cmdReport(args, deps = {}) {
  if (!args.issue) throw new Error(`report requires --issue=<id-or-identifier>\n\n${USAGE}`);
  if (!args.status) throw new Error(`report requires --status=<done|in-review|paused|blocked>\n\n${USAGE}`);
  if (!args.summary) throw new Error(`report requires --summary="..."\n\n${USAGE}`);
  // Validate the STATUS VALUE (not just presence) before anything below runs
  // an I/O side effect — planCompletion() also validates, but only after
  // createComment() would already have posted. A typo'd --status previously
  // posted a real comment, then threw with no marker printed, leaving the
  // Stop-hook sentinel unwritten and a retry double-posting the comment.
  if (!lsr.VALID_STATUSES.has(args.status)) {
    throw new Error(
      `report: unknown --status "${args.status}" — expected one of ${[...lsr.VALID_STATUSES].join(', ')}\n\n${USAGE}`
    );
  }

  const issue = await linear.getIssue(args.issue);
  if (!issue) throw new Error(`No Linear issue found for "${args.issue}"`);

  // BRO-3869: re-check the issue this call JUST fetched (no extra round
  // trip) against when this session last knew its state, BEFORE the outcome
  // comment posts — so a session about to report a conclusion or a proposed
  // action sees the warning while it can still change what it's about to
  // post, not after. Opt-in (--since) rather than always-on: this needs the
  // session's own last-known timestamp, which report has no way to infer on
  // its own, and a session filing a brand-new card has nothing to compare
  // against yet. Never blocks — see linear-staleness-check.js's header.
  let staleness = null;
  if (args.since) {
    // checkIssueStaleness throws on a malformed/future --since (fail-closed
    // by design, so a typo doesn't silently report "clean") — but this
    // check is an optional, informational hint, not the point of this call.
    // Letting that throw propagate would abort the WHOLE report before the
    // outcome comment posts, taking down the mandatory Stop-hook-required
    // report over a bad flag on an optional add-on (code-review finding,
    // BRO-3869). Degrade to a warning instead; the report still goes out.
    try {
      staleness = checkIssueStaleness(issue, args.since);
      if (staleness.stale) {
        console.error(`\n⚠️  ${issue.identifier} changed since ${args.since} — re-read before proceeding:`);
        for (const s of staleness.signals) console.error(`   - ${s.detail}`);
        console.error('');
      }
    } catch (err) {
      console.error(`⚠️  --since=${args.since} could not be checked (${err.message}) — proceeding without the staleness check.`);
    }
  }

  const body = lsr.buildOutcomeCommentBody({
    summary: args.summary,
    keyFiles: splitKeyFiles(args['key-files']),
    verification: args.verification,
    status: args.status,
  });
  await linear.createComment(issue.id, body);
  // Marker IMMEDIATELY after the comment lands — before getTeam()'s network
  // round-trip and before the (now git/gh-heavy) Done gate. The Stop-hook
  // sentinel keys on this marker to know the comment was posted; anything
  // that dies between the post and the marker forces a retry that would
  // double-post it. A later gate refusal or state-move failure is reported by
  // the JSON line / exit code, as before.
  console.log(lsr.buildIssueIdMarker(issue.id));

  const team = await linear.getTeam();
  const completion = lsr.planCompletion({ status: args.status, states: team.states });

  // BRO-457: this is the OTHER call site that ever moves a Linear issue to a
  // completed state (the one --status=done sessions actually use, not
  // linear-brain.js's `update`) — done-semantics-gate.js had zero real-world
  // effect until both were wired. Gated on the literal 'done' status, not a
  // resolved state `type`: planCompletion() only returns {stateId,
  // stateName}, and every completion this branch ever runs for was already
  // requested via status==='done', so the semantic intent is unambiguous
  // without adding a type field to that return shape.
  let stateMoved = false;
  let refusal = null;
  if (completion.stateId) {
    if (args.status === 'done') {
      const bypassReason =
        args.force && typeof args.force === 'string' && args.force.length >= 10 ? args.force : null;
      if (args.force && !bypassReason) {
        console.error('⚠️  --force ignored by done-semantics gate: the reason must be a string of ≥10 characters.');
      }
      // Ship-check finding (Codex adversarial review, 2026-09-21): this is
      // the OTHER call site that can bypass the Done gate — the one this
      // file's own comment above says is "the one --status=done sessions
      // actually use" — and linear-brain.js's bypass ledger only instrumented
      // its own `update` command. Logging only one of two live bypass paths
      // would make the ledger's counts wrong in the direction that matters:
      // undercounting the path actually used, i.e. the exact "unmeasured
      // premise" the ledger exists to fix.
      const sessionEnvDisabled = !bypassReason && process.env.LINEAR_DONE_GATE_DISABLED === '1';
      if (bypassReason || sessionEnvDisabled) {
        try {
          (deps.appendBypassRow || appendBypassRow)({
            identifier: issue.identifier,
            gate: 'done',
            mechanism: bypassReason ? 'force' : 'env-disabled',
            reason: bypassReason,
            targetState: completion.stateName,
          });
        } catch { /* diagnostic only — never block the report */ }
      }
      if (!bypassReason && process.env.LINEAR_DONE_GATE_DISABLED !== '1') {
        // Same three text sources linear-brain.js's update gate reads:
        // description, prior comments (already on `issue` from getIssue()'s
        // comments(first: 20)), and this call's own outcome comment — which
        // was already posted above, so it counts as commentText here too.
        // sortedCommentBodies (oldest-first by createdAt) — see
        // linear-done-gate.js's header (BRO-3155) for why raw connection
        // order is not safe to treat as chronological.
        const existingComments = sortedCommentBodies(issue);
        const verifyEvidence = deps.verifyEvidence
          || makeVerifyEvidence({ cwd: process.cwd(), issueIdentifier: issue.identifier, log: (m) => console.error(m) });
        // BRO-3885: actually RUNS a recorded VERIFY command against a fresh
        // origin/main checkout — see linear-cmd-execution.js's header.
        const verifyCmdEvidence = deps.verifyCmdEvidence || makeVerifyCmdEvidence({ log: (m) => console.error(m) });
        const gate = checkLinearDoneTransition({
          targetStateType: 'completed',
          description: issue.description || '',
          commentText: body,
          existingComments,
          verifyEvidence,
          verifyCmdEvidence,
        });
        if (gate.warning) console.error(`⚠️  ${gate.warning}`);
        if (gate.gated && !gate.allowed) refusal = gate;
      }
    }
    if (!refusal) {
      await linear.updateIssue(issue.id, { stateId: completion.stateId });
      stateMoved = true;
    }
  }

  // (Marker was printed before the gate — see above.) A refused Done still
  // means this session communicated status honestly; it just didn't get to
  // change the issue's state.
  console.log(
    JSON.stringify({
      id: issue.id,
      identifier: issue.identifier,
      status: args.status,
      stateName: stateMoved ? completion.stateName : (issue.state && issue.state.name) || null,
      doneGateRefused: !!refusal,
      staleness,
    })
  );

  if (refusal) {
    console.error(
      `\n❌ REFUSED (${refusal.verdict}) — ${issue.identifier} stays in "${
        (issue.state && issue.state.name) || 'its current state'
      }", not moved to ${completion.stateName}\n`
    );
    console.error(refusal.reason);
    console.error(
      `\nTo move it anyway, pass --force="<reason ≥10 chars>", ` +
        `or set LINEAR_DONE_GATE_DISABLED=1 for automation that must not block.\n`
    );
    process.exit(5);
  }
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
