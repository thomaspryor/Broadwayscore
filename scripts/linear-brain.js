#!/usr/bin/env node
/**
 * linear-brain.js — CLI for filing a Linear issue through the one chokepoint
 * (scripts/lib/linear-issue-create.js) instead of hand-rolling a GraphQL
 * call. See that file's header for why this exists (task #1310).
 *
 * Usage:
 *   node scripts/linear-brain.js create "Issue title" --notes "description" \
 *     [--dispatch | --self | --child "<what>" | --park "<reason>"] [--priority 0-4] [--project-id <id>] \
 *     [--model opus|sonnet] [--source <filer>] [--new-anyway "<reason>"] [--dedupe-opt-out <name>]
 *     [--mac-only "<what needs the Mac and why>"]
 *
 * BRO-6080: --mac-only (with --dispatch) adds the 'mac-only' label and a "MAC-ONLY: <why>" line. The cloud
 * worker skips the card; the Mac's parked drain (linear-drain-parked.js, launchd) runs it headless on the Mac.
 *
 * BRO-5626: a session --park whose reason is technical (no owner/access/Mac/date block) and whose notes carry
 * a safe VERIFY line files in Todo (auto-Todo), so the workers pick it; a real block stays in Backlog.
 *
 * --dispatch or --park "<reason>" is REQUIRED — there is no default
 * disposition. Neither given → exit 2, usage message names both.
 *
 * Output: JSON to stdout. A tagged marker line to stderr on success —
 * `ISSUE-FILED:` (not `DISPATCHED:`, deliberately: bsc-next.js cannot yet
 * resolve a Linear issue id into a live workspace — task #1303 is building
 * that separately — so nothing is actually running yet even in --dispatch
 * mode. Using `DISPATCHED:` here would misrepresent that to anything
 * grepping for it, including the CLAUDE.md exit-status-gate convention).
 */

require('./lib/load-env').loadEnv();

const { createLinearIssue } = require('./lib/linear-issue-create');
const { warnPriorAnswers } = require('./lib/owner-decision-recall');
const { hasHelpFlag } = require('./lib/cli-help');
const linearClient = require('./lib/linear-client');
const { checkLinearDoneTransition } = require('./lib/linear-done-gate');
const { makeVerifyEvidence } = require('./lib/done-evidence-verify');
const { makeVerifyCmdEvidence } = require('./lib/linear-cmd-execution');
const { appendBypassRow, bypassCommentLine } = require('./lib/linear-gate-bypass-ledger');
const { sortedCommentBodies } = require('./lib/linear-dispatch.js');
const { TERMINAL_STATE_TYPES, newestComments } = require('./lib/linear-staleness-check');

const USAGE = `linear-brain.js — file a Linear issue through the one creation chokepoint.

Usage:
  node scripts/linear-brain.js create "Issue title" --notes "description" \\
    [--dispatch | --self | --child "<what>" | --park "<reason>"] [--priority 0-4] [--project-id <id>] \\
    [--model opus|sonnet] [--source <filer>] [--new-anyway "<reason>"] [--dedupe-opt-out <name>]
    [--no-verify "<reason>"] [--mac-only "<what needs the Mac and why>"]
  node scripts/linear-brain.js find "search term"
  node scripts/linear-brain.js get <BRO-N>
  node scripts/linear-brain.js update <BRO-N> [--state "<name>"] [--comment "<text>"] \\
    [--force "<reason ≥10 chars>"] [--duplicate-of <BRO-N>] [--cancel-reason "<reason ≥20 chars>"]

  node scripts/linear-brain.js --probe [--timeout-ms N]

  create: --dispatch, --self or --park "<reason>" is REQUIRED. None given → exit 2.
          --child "<child session title>" (BRO-6359): a create_session child is starting on this card now.
          Filed like --self (In Progress, claimed) so no worker takes it; CLOUD.md § Starting a worker session.
          --self (BRO-6130): this session is already doing the work (an owner request, a
          fix it is making now). Files the card In Progress with the claim comment, the
          same trace "linear-session.js claim" leaves. The card is never swapped for
          someone else's twin; a near-duplicate open card is still refused. Not a park:
          do not write "PARKED: doing it now".
          Technical work with a safe VERIFY files --dispatch (Todo, any
          priority). --park only for a real block: owner call, missing key
          or access, Mac-only, a date or event, spend (BRO-5626).
          Work only the owner's Mac can do (launchd, its cookies/keychain, a
          local-only file) files --dispatch --mac-only "<why>": the cloud
          worker skips it and the Mac's drain runs it headless (Mac awake,
          08:30-22:30 Mac time; needs a safe VERIFY on its own line; BRO-6080).
          Work needing the owner's own hands (a browser login to renew a
          cookie) still goes to the owner, not a card.
          A session card with no safe VERIFY (and no real-block park or
          owner-judgment marker) prints VERIFY-ADVISORY; --no-verify
          "<reason>" files it with the reason on the card.
          --model stamps "Model: Opus|Sonnet" on the card; the worker that
          picks it up uses that model (an Opus line spends the daily Opus
          budget, BRO-6684; a card that failed before still moves up to Opus).
          Opus: multi-file, architectural, adversarial debugging. Sonnet:
          mechanical, single-file, data fixes. Anything else → exit 2.
          Only a Model line in the description counts; one in a comment
          is ignored.
          Repeats (BRO-5488): a --park card whose title repeats an open
          card (same subject, reworded, or only a count changed; a different
          date is a different card) is added there as a comment instead
          (ISSUE-REUSED); --new-anyway "<reason>" files anyway. A workflow filer's 3+ same-kind parked findings in
          24h go onto one "Rollup (...)" card (ROLLED-UP). --source names the
          filer (default workflow:$GITHUB_WORKFLOW, else session); it is
          stamped as a "Filed by:" line the morning digest counts.
          A --dispatch card whose title repeats an open card is refused
          (ALREADY-OPEN, exit 8): claim that card, or --new-anyway "<why>".
          --dedupe-opt-out <name> is only for a filer listed in
          scripts/lib/card-dedupe.js DEDUPE_OPT_OUTS (it groups its own).
  find:   prints {"identifier": "BRO-N", ...} for the first OPEN issue whose
          title or body contains the term, or null. Sync-callable dedup seam
          for digest-autofix's fileCard (BRO-286) — filing the same
          persistent health row daily would otherwise mint one duplicate
          issue per day and reset attempt-memory each time.
  get:    read-only status read (BRO-3018, parity with notion-brain.js get).
          Prints {"identifier","title","url","state":{"name","type"},
          "terminal":bool}; terminal = completed|canceled|duplicate. Exit 2 if
          the issue does not exist. Lets callers poll an issue they escalated.
  --probe: read-only three-way health verdict for the gate hooks. Prints one
          BOARD_PROBE: line and exits 0 healthy / 3 erroring / 4 unreachable.
  update: moves an issue's workflow state and/or posts a comment. --state takes
          a REAL Linear state name (not notion-brain's Done|Paused vocabulary);
          an unknown name exits 1 and lists the team's actual states.
          Moving into a completed-type state is REFUSED (exit 5) unless the
          issue carries done-evidence: a PR recorded via a "PR-EVIDENCE:
          merged deployed checked (<url>)" line (issue description or this
          call's --comment), or a safe-form verification command in an
          "## Acceptance criteria" section / "VERIFY: <cmd>" line. Bypass
          with --force "<reason ≥10 chars>", or LINEAR_DONE_GATE_DISABLED=1
          for automation that must not block (BRO-457).
          Moving into a DUPLICATE-type state is REFUSED (exit 6) unless the
          issue already owns an outgoing duplicate relation, because Linear
          rejects that mutation with "missing duplicate relation" AFTER any
          --comment has already been posted. Pass --duplicate-of <BRO-N> to
          create the relation and move the state in one call; the success
          JSON then carries duplicateOf. Exit 6 also covers a --duplicate-of
          that DISAGREES with the twin already on the issue. Exit 1 if
          --duplicate-of is passed without a duplicate-type --state, rather
          than ignoring it. Kill switch: LINEAR_DUPLICATE_GATE_DISABLED=1
          (BRO-343).
          Moving into a CANCELED-type state is REFUSED (exit 7) unless
          --cancel-reason "<reason ≥20 chars>" is given — a card refused a
          Done close can otherwise leave the open board via Cancel with zero
          evidence ever checked. Kill switch: LINEAR_CANCEL_GATE_DISABLED=1
          (BRO-3435). Every --force / *_GATE_DISABLED=1 bypass of the Done
          gate is logged to data/audit/linear-gate-bypass.jsonl.
`;

function parseArgs(argv) {
  const args = { _positional: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const raw = argv[i].slice(2);
      // `--flag=value` as well as `--flag value`. Without this the equals form
      // parses as a flag literally named "timeout-ms=4000" whose value is true,
      // so args['timeout-ms'] is undefined and the option is SILENTLY ignored —
      // the caller sees a successful run that did not do what they asked.
      // Caught by a probe guard that failed to fire on `--timeout-ms=abc`.
      const eq = raw.indexOf('=');
      if (eq > 0) {
        args[raw.slice(0, eq)] = raw.slice(eq + 1);
        continue;
      }
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        args[raw] = next;
        i++;
      } else {
        args[raw] = true;
      }
    } else {
      args._positional.push(argv[i]);
    }
  }
  return args;
}

/**
 * Read-only health check with a THREE-way verdict — healthy /
 * reachable-but-erroring / unreachable. Sprint 4's gate-hook rewrite branches
 * on this; see scripts/lib/board-probe.js for why the two failure worlds must
 * not be collapsed.
 *
 * Deliberate choices:
 *  - `viewer { id }`, not a team or issue read. It is the cheapest possible
 *    authenticated query, and it exercises exactly what the gate cares about:
 *    can this machine talk to Linear as somebody.
 *  - maxAttempts 1. A probe that retries is a probe that lies about latency,
 *    and every `git commit` fleet-wide would pay for it.
 *  - a 4s default budget, matching the existing Notion probe's `alarm 4`
 *    in notion-card-required-commit.sh:56, so the hook's cost does not change
 *    when Sprint 4 repoints it here.
 *  - never throws. A health check that crashes has no verdict, and no verdict
 *    is the one answer the hooks cannot act on.
 */
async function runProbe(args) {
  const probe = require('./lib/board-probe');
  // A non-numeric --timeout-ms used to become NaN, which graphql() rejects as
  // not-finite and replaces with its 30s default — silently blowing the 4s hook
  // budget this probe exists to respect, on every gated command.
  const rawTimeout = args['timeout-ms'];
  const parsedTimeout = rawTimeout === undefined ? 4000 : Number(rawTimeout);
  if (!Number.isFinite(parsedTimeout) || parsedTimeout <= 0) {
    console.error(`BOARD_PROBE: erroring board=linear reason=bad-timeout-ms — --timeout-ms=${rawTimeout} is not a positive number`);
    process.exit(require('./lib/board-probe').EXIT_CODES.erroring);
  }
  const timeoutMs = parsedTimeout;
  let verdict = probe.VERDICTS.HEALTHY;
  let reason = 'ok';
  let detail = '';
  const startedAt = Date.now();
  try {
    const linearClient = require('./lib/linear-client');
    const data = await linearClient.graphql('query { viewer { id name } }', {}, {
      maxAttempts: 1,
      timeoutMs,
      onRetry: () => {},
    });
    if (!data || !data.viewer || !data.viewer.id) {
      // A 200 with no viewer is not healthy, and calling it healthy is how a
      // gate ends up enforcing against a board it never actually read.
      verdict = probe.VERDICTS.ERRORING;
      reason = 'empty-viewer';
    } else {
      detail = `authenticated as ${data.viewer.name || data.viewer.id}`;
    }
  } catch (err) {
    ({ verdict, reason } = probe.classifyProbeError(err));
    detail = String(err && err.message ? err.message : err).slice(0, 200);
  }
  const line = probe.formatProbeLine('linear', verdict, reason, `${detail} (${Date.now() - startedAt}ms)`);
  // stdout, not stderr: this is the command's ANSWER, and hooks capture it.
  console.log(line);
  process.exit(probe.EXIT_CODES[verdict]);
}

const { armingWarning } = require('./lib/card-arming-warning.js');

// BRO-6083: a card about an area with a coordinator card (opening night ->
// BRO-5955) prints that card's latest coordinator note to stderr on create and
// get, so the session reads it before starting. Skipped in CI and under
// node --test (no live Linear read there); tests inject their own.
async function defaultCoordinatorReminder(text, exclude) {
  if (process.env.GITHUB_ACTIONS === 'true' || process.env.NODE_TEST_CONTEXT) return '';
  return require('./coordinator-check.js').startReminder(text, { exclude });
}

async function printCoordinatorReminder(fn, text, exclude) {
  try {
    const reminder = await fn(text, exclude);
    if (reminder) console.error(`\n${reminder}\n`);
  } catch {
    // Advisory only: never let it fail a create or a get.
  }
}

function printBoardCardId(identifier) {
  console.error(`__BOARD_CARD_ID__=${identifier}`);
}

async function main(argv = process.argv.slice(2), deps = {}) {
  // Injectable I/O seams — real Linear client by default, same convention
  // scripts/linear-next.js's main() uses (deps default to the live module,
  // tests pass stubs so no live Linear API call or gate side effect happens
  // under `node --test`). Create injects filing and advisory recall; update
  // injects the reads and writes needed by its transition gates.
  const {
    createLinearIssue: createLinearIssueFn = createLinearIssue,
    getIssue: getIssueFn = linearClient.getIssue,
    getTeam: getTeamFn = linearClient.getTeam,
    updateIssue: updateIssueFn = linearClient.updateIssue,
    createComment: createCommentFn = linearClient.createComment,
    createIssueRelation: createIssueRelationFn = linearClient.createIssueRelation,
    coordinatorReminder: coordinatorReminderFn = defaultCoordinatorReminder,
  } = deps;

  if (hasHelpFlag(argv)) {
    console.log(USAGE);
    return;
  }
  const args = parseArgs(argv);
  const command = args._positional[0];

  // --probe is a FLAG, not a subcommand, so it is checked before the
  // positional dispatch below (which would otherwise print USAGE and exit 1).
  if (args.probe) {
    await runProbe(args);
    return;
  }

  if (command === 'get') {
    const identifier = args._positional[1];
    if (!identifier) {
      console.error('Usage: linear-brain get <BRO-N>');
      process.exit(1);
    }
    try {
      const issue = await getIssueFn(identifier);
      if (!issue) {
        console.error(`❌ no such issue: ${identifier}`);
        process.exit(2);
      }
      const { isTerminalStateType } = require('./lib/linear-state-types');
      const state = issue.state || {};
      console.log(JSON.stringify({
        identifier: issue.identifier,
        title: issue.title,
        url: issue.url,
        state: { name: state.name || null, type: state.type || null },
        terminal: isTerminalStateType(state.type),
      }, null, 2));
      await printCoordinatorReminder(coordinatorReminderFn, `${issue.title || ''}\n${issue.description || ''}`, issue.identifier);
    } catch (err) {
      console.error(`\n❌ ${err.message}\n`);
      process.exit(2);
    }
    return;
  }

  if (command === 'find') {
    const term = args._positional[1];
    if (!term) {
      console.error('Usage: linear-brain find "search term" [--exact-title [--ignore-numbers]]');
      process.exit(1);
    }
    // Read-only. Two modes (verify-pass P2, 2026-08-12):
    //  --exact-title: issue.title === term over the paginated open-issue list
    //    — the dedup mode digest-autofix's fileCard needs. Substring matching
    //    here misrouted: a hand-filed issue QUOTING a row title in its body,
    //    or a superset title ("Cron failed: X (WE)" vs "Cron failed: X"),
    //    would reattach the row to the wrong issue and silently never file.
    //  default: searchIssues' first title/body substring match — the
    //    conditionKey-marker semantics the alert-router dedupe uses.
    const linearClient = require('./lib/linear-client');
    try {
      let match;
      if (args['exact-title']) {
        const open = await linearClient.listOpenIssues();
        match = open.find((i) => i && i.title === term) || null;
        // --ignore-numbers (BRO-6081): a health row whose title carries a live
        // count ("breaker TRIPPED: web_unlocker2 (2194/1750 reqs)") changes
        // daily, so exact match filed a fresh card each morning (5 for one
        // breaker). Exact match still wins; this is the fallback.
        if (!match && args['ignore-numbers']) {
          const { numberFreeTitle } = require('./lib/card-dedupe');
          const key = numberFreeTitle(term);
          match = key === term ? null : open.find((i) => i && numberFreeTitle(i.title) === key) || null;
        }
      } else {
        match = await linearClient.searchIssues(term);
      }
      // state (BRO-6081): digest-autofix's fileCard reads it so a reattached
      // card that is already being worked (or Paused for a re-check) is not
      // re-dispatched only to be refused by startedStateGuard.
      console.log(match ? JSON.stringify({ identifier: match.identifier, title: match.title, url: match.url,
        ...(match.state ? { stateType: match.state.type, stateName: match.state.name } : {}) }, null, 2) : 'null');
    } catch (err) {
      console.error(`\n❌ ${err.message}\n`);
      process.exit(2);
    }
    return;
  }

  if (command === 'update') {
    // S4-T1. Moves an issue's workflow state and/or posts a comment.
    //
    // Deliberately NOT a `--status Done|Paused` mirror of notion-brain.js: see
    // scripts/lib/linear-state-resolve.js for why translating the Notion
    // vocabulary is a guess that silently files work into the wrong column.
    // The caller names a real Linear state; an unknown one lists the real set.
    const identifier = args._positional[1];
    if (!identifier) {
      console.error('Usage: linear-brain update <BRO-N> [--state "<name>"] [--comment "<text>"] [--duplicate-of <BRO-N>]');
      process.exit(1);
    }
    if (args.state === undefined && args.comment === undefined) {
      console.error('linear-brain update: nothing to do — pass --state and/or --comment');
      process.exit(1);
    }
    // A valueless flag parses to boolean `true`, and so does one whose value
    // begins with `--`. Both reach here as `comment === true`, and
    // String(true) would post the literal text "true" onto the issue —
    // `--comment` last on the line, or a markdown body starting with `---`,
    // silently lands junk on the board. An empty string is refused for the
    // same reason: Linear rejects an empty body at mutation time, i.e. AFTER
    // any state write has already landed.
    if (args.comment !== undefined && (typeof args.comment !== 'string' || !args.comment.trim())) {
      console.error('linear-brain update: --comment needs a non-empty text value, e.g. --comment "what changed"');
      process.exit(1);
    }

    const { resolveState, formatStateError } = require('./lib/linear-state-resolve');
    const {
      DUPLICATE_STATE_TYPE,
      checkLinearDuplicateTransition,
    } = require('./lib/linear-duplicate-gate');
    const {
      CANCELED_STATE_TYPE,
      checkLinearCancelTransition,
    } = require('./lib/linear-cancel-gate');
    try {
      const issue = await getIssueFn(identifier);
      if (!issue) {
        console.error(`❌ no such issue: ${identifier}`);
        process.exit(2);
      }

      // Resolve BEFORE any write, so an unknown state name costs nothing.
      // `team.states` is passed whole — resolveState normalizes both shapes.
      let target = null;
      if (args.state !== undefined) {
        const team = await getTeamFn();
        const resolved = resolveState(args.state, team.states);
        if (!resolved.ok) {
          console.error(`❌ ${formatStateError(resolved)}`);
          process.exit(1);
        }
        target = resolved.state;
      }

      // BRO-6635: a pause written here skips linear-session.js report's hand-off check, so warn too (advisory).
      if (target && /^paused$/i.test(target.name) && typeof args.comment === 'string') {
        const pause = require('./lib/pause-report-guard').classifyPauseReport({ status: 'paused', summary: args.comment });
        if (pause.wouldRefuse) console.error(`\n⚠️  pause-handoff (advisory) — ${identifier}:\n${pause.reason}\n`);
      }

      // --duplicate-of only means anything on a move into a duplicate-type
      // state. Silently ignoring it elsewhere let `update BRO-1 --comment x
      // --duplicate-of BRO-2` exit 0 having created no relation, while the
      // operator reasonably believed the advertised option had been applied
      // (adversarial-review finding). Refuse before any write instead.
      if (args['duplicate-of'] !== undefined && (!target || target.type !== DUPLICATE_STATE_TYPE)) {
        console.error(
          `❌ --duplicate-of only applies to a move into a duplicate-type state.\n` +
            (target
              ? `   --state "${target.name}" is a ${target.type}-type state, so the flag would do nothing.`
              : `   No --state was given, so the flag would do nothing.`) +
            `\n   Drop --duplicate-of, or pass the team's duplicate state via --state.`
        );
        process.exit(1);
      }

      // Same shape as --duplicate-of above (ship-check finding, 2026-09-21):
      // without this, `update BRO-1 --state Done --cancel-reason "..."` would
      // exit 0 having silently discarded the flag, matching the exact
      // adversarial-review failure --duplicate-of was already fixed for.
      if (args['cancel-reason'] !== undefined && (!target || target.type !== CANCELED_STATE_TYPE)) {
        console.error(
          `❌ --cancel-reason only applies to a move into a canceled-type state.\n` +
            (target
              ? `   --state "${target.name}" is a ${target.type}-type state, so the flag would do nothing.`
              : `   No --state was given, so the flag would do nothing.`) +
            `\n   Drop --cancel-reason, or pass the team's canceled state via --state.`
        );
        process.exit(1);
      }

      // BRO-457: refuse a move into a completed-type state unless the issue
      // carries one of done-semantics-gate.js's two accepted evidence shapes.
      // Resolved (not written) so far — same "costs nothing on refusal" shape
      // as the state-name resolve above. Gated on `target.type`, not the
      // literal state NAME, so a team rename of "Done" doesn't silently stop
      // gating (see linear-done-gate.js's header).
      if (target && target.type === 'completed') {
        const bypassReason =
          args.force && typeof args.force === 'string' && args.force.length >= 10 ? args.force : null;
        if (args.force && !bypassReason) {
          console.error('⚠️  --force ignored by done-semantics gate: the reason must be a string of ≥10 characters.');
        }
        // BRO-3435: record every bypass, whether or not the gate would have
        // refused anyway — the open question this exists to answer
        // ("is --force the ROUTINE path for a whole class of work, e.g.
        // data-repo closes the gate's own ancestry check can never verify?")
        // needs USE counted, not just refusals dodged. Best-effort: a ledger
        // write must never block or fail a real state transition.
        const envDisabled = !bypassReason && process.env.LINEAR_DONE_GATE_DISABLED === '1';
        if (bypassReason || envDisabled) {
          try {
            (deps.appendBypassRow || appendBypassRow)({
              identifier: issue.identifier,
              gate: 'done',
              mechanism: bypassReason ? 'force' : 'env-disabled',
              reason: bypassReason,
              targetState: target.name,
            });
          } catch { /* diagnostic only — never block the transition */ }
          // BRO-4241: record the bypass on the issue too. The comment posts
          // before the state move (see ORDER MATTERS below), and in cloud
          // sessions it is the only record (the ledger file is skipped there).
          // Only when the card actually moves: re-running a close on a card
          // already in the target state bypasses nothing (ship-check finding).
          if (!(issue.state && issue.state.id === target.id)) {
            const line = bypassCommentLine({ mechanism: bypassReason ? 'force' : 'env-disabled', reason: bypassReason, targetState: target.name });
            args.comment = args.comment !== undefined ? `${args.comment}\n\n${line}` : line;
          }
        }
        if (!bypassReason && process.env.LINEAR_DONE_GATE_DISABLED !== '1') {
          const commentText = typeof args.comment === 'string' ? args.comment : '';
          // getIssue()'s query already fetches comments(first: 20) — reuse
          // that read rather than a second round-trip. Evidence posted as a
          // PAST comment (a prior session's "PR-EVIDENCE: ..." or a VERIFY:
          // line) must count too, not just this call's own --comment.
          // sortedCommentBodies (not a raw .map) — linear-done-gate.js's
          // newest-first precedence (BRO-3155) needs these oldest-first by
          // createdAt, and Linear's comments connection is not
          // createdAt-ascending by default (see that helper's own header).
          const existingComments = sortedCommentBodies(issue);
          // Real verifier by default (git ancestry / gh merge commit); tests
          // inject a stub through deps so no unit test ever shells out.
          const verifyEvidence = deps.verifyEvidence
            || makeVerifyEvidence({ cwd: process.cwd(), issueIdentifier: issue.identifier, log: (m) => console.error(m) });
          // BRO-3885: actually RUNS a recorded VERIFY command against a fresh
          // origin/main checkout — see linear-cmd-execution.js's header for
          // why a shape-only check (evaluateVerifiability) let BRO-3471 close
          // Done twice on a command naming a file that never existed.
          const verifyCmdEvidence = deps.verifyCmdEvidence || makeVerifyCmdEvidence({ log: (m) => console.error(m) });
          const gate = checkLinearDoneTransition({
            targetStateType: target.type,
            description: issue.description || '',
            commentText,
            existingComments,
            verifyEvidence,
            verifyCmdEvidence,
          });
          if (gate.warning) console.error(`⚠️  ${gate.warning}`);
          if (gate.gated && !gate.allowed) {
            console.error(`\n❌ REFUSED (${gate.verdict}) — ${issue.identifier} not moved to ${target.name}\n`);
            console.error(gate.reason);
            console.error(
              `\nTo move it anyway, pass --force "<reason ≥10 chars>", ` +
                `or set LINEAR_DONE_GATE_DISABLED=1 for automation that must not block.\n`
            );
            process.exit(5);
          }
        }
      }

      // Crown BRO-343 2026-09-05: refuse a move into a duplicate-type state
      // that Linear itself will refuse. `--state Duplicate` is advertised as
      // valid (the unknown-state error lists it), but the mutation fails with
      // "missing duplicate relation" unless the issue owns an outgoing
      // duplicate relation — and it fails AFTER the --comment below has
      // landed, so the operator reads the non-zero exit as "nothing
      // happened", re-runs, and double-posts onto a still-open card. Resolved
      // here, before the first write, from the `relations` the same getIssue()
      // read already fetched. `--duplicate-of BRO-N` creates the relation
      // instead of refusing.
      let duplicateRelation = null;
      // The canonical twin this call ends up naming — either one already on
      // the issue or one --duplicate-of creates. Reported in the success JSON.
      let duplicateTwin = null;
      // `target && ...` alone treated a re-run on an issue ALREADY in the
      // duplicate state as a fresh transition and refused it, suppressing the
      // --comment on a card whose state was already correct (adversarial-review
      // finding). No state change is being requested, so there is nothing for
      // Linear to validate and nothing for this gate to guard.
      const isRealTransition = Boolean(target && issue.state && issue.state.id !== target.id);
      if (isRealTransition && target.type === DUPLICATE_STATE_TYPE) {
        const dupGate = checkLinearDuplicateTransition({
          targetStateType: target.type,
          relations: issue.relations,
          duplicateOf: args['duplicate-of'],
        });
        // The kill switch suppresses the REFUSAL, never the relation work
        // below. Wiring it around the whole block made
        // `LINEAR_DUPLICATE_GATE_DISABLED=1 ... --duplicate-of BRO-N` silently
        // drop the flag, so the one escape hatch also removed the one way to
        // satisfy the rule it was escaping (codebase review, 2026-09-05).
        const gateDisabled = process.env.LINEAR_DUPLICATE_GATE_DISABLED === '1';
        if (!dupGate.allowed && gateDisabled) {
          console.error(
            `⚠️  LINEAR_DUPLICATE_GATE_DISABLED=1 — proceeding past ${dupGate.verdict}.\n` +
              `   If Linear still enforces the rule, the state write below will fail AFTER any\n` +
              `   --comment has posted; that partial write is exactly what this gate prevents.`
          );
        }
        if (!dupGate.allowed && !gateDisabled) {
          console.error(`\n❌ REFUSED (${dupGate.verdict}) — ${issue.identifier} not moved to ${target.name}\n`);
          console.error(dupGate.reason);
          // Only print the fill-in-the-blank command for the MISSING-relation
          // case. On a target mismatch the operator already passed a
          // --duplicate-of, and echoing a `<BRO-N>` placeholder there reads as
          // if the flag were absent.
          if (dupGate.verdict === 'no-duplicate-relation') {
            console.error(
              `\n  node scripts/linear-brain.js update ${issue.identifier} ` +
                `--state ${target.name} --duplicate-of <BRO-N>\n`
            );
          } else {
            console.error('');
          }
          process.exit(6);
        }
        if (dupGate.needsRelation) {
          // Resolve the canonical twin to a UUID up front: issueRelationCreate
          // takes UUIDs, not BRO-N identifiers, and a typo'd identifier must
          // fail HERE (nothing written) rather than mid-way through the write
          // block with a comment already posted.
          const canonicalRef = String(args['duplicate-of']).trim();
          const canonical = await getIssueFn(canonicalRef);
          if (!canonical) {
            console.error(`❌ --duplicate-of: no such issue: ${canonicalRef}`);
            process.exit(2);
          }
          if (canonical.id === issue.id) {
            console.error(`❌ --duplicate-of: ${issue.identifier} cannot be a duplicate of itself`);
            process.exit(1);
          }
          duplicateRelation = { id: canonical.id, identifier: canonical.identifier || canonicalRef };
          duplicateTwin = duplicateRelation.identifier;
        } else {
          duplicateTwin = dupGate.existingTarget;
        }
      }

      // BRO-3435: a card refused a Done close by the completed-type gate
      // above could otherwise leave the open board via Cancel with zero
      // evidence ever checked — same practical outcome (off the board), and
      // audit-done-evidence.js's nightly sweep only re-verifies Done cards,
      // so a Canceled one is invisible to it too. Require a reason instead;
      // see linear-cancel-gate.js's header for the full rationale and why
      // this is deliberately narrower than the done-gate (no server-side
      // precondition to mirror, so no partial-write ordering hazard).
      if (isRealTransition && target.type === CANCELED_STATE_TYPE) {
        const cancelGate = checkLinearCancelTransition({
          targetStateType: target.type,
          cancelReason: args['cancel-reason'],
        });
        const cancelGateDisabled = process.env.LINEAR_CANCEL_GATE_DISABLED === '1';
        if (!cancelGate.allowed && cancelGateDisabled) {
          console.error(`⚠️  LINEAR_CANCEL_GATE_DISABLED=1 — proceeding past ${cancelGate.verdict}.`);
          try {
            (deps.appendBypassRow || appendBypassRow)({
              identifier: issue.identifier,
              gate: 'cancel',
              mechanism: 'env-disabled',
              targetState: target.name,
            });
          } catch { /* diagnostic only — never block the transition */ }
        }
        if (!cancelGate.allowed && !cancelGateDisabled) {
          console.error(`\n❌ REFUSED (${cancelGate.verdict}) — ${issue.identifier} not moved to ${target.name}\n`);
          console.error(cancelGate.reason);
          console.error(
            `\n  node scripts/linear-brain.js update ${issue.identifier} ` +
              `--state ${target.name} --cancel-reason "<at least 20 characters>" ` +
              `(or set LINEAR_CANCEL_GATE_DISABLED=1 for automation that must not block)\n`
          );
          process.exit(7);
        }
        // Ship-check finding, 2026-09-21 (both reviewers independently, and
        // correctly): a PASSING gate here recorded the reason in `cancelGate`
        // and then discarded it — nothing wrote it to the card, the ledger,
        // or the success JSON. The operator typed 20 mandatory characters
        // that lived only in shell history, so the audit trail this gate
        // exists to create didn't exist. Reuses the EXISTING comment-then-
        // state write path below rather than adding a second write call
        // (Codex's own suggested fix) — folded into any --comment the caller
        // already gave rather than replacing it, so neither is lost.
        if (cancelGate.gated && cancelGate.allowed) {
          const reasonLine = `Canceled: ${cancelGate.reason}`;
          args.comment = args.comment !== undefined ? `${args.comment}\n\n${reasonLine}` : reasonLine;
        }
      }

      // BRO-3869 cousin: `linear-session.js claim` warns automatically when
      // reopening a Done/Canceled issue (the exact shape of the incident that
      // filed BRO-3869 — a sibling session concluded+shipped a card while
      // this session was still investigating it), but `update --state` is
      // this repo's OTHER, more general path that can move an issue OUT of a
      // terminal state, and had no equivalent warning. Fires whenever this
      // call is a real transition (isRealTransition, computed above) FROM a
      // terminal type TO a non-terminal one — never blocks, matches the
      // done-gate's own "warn, then still allow the write" precedent above.
      if (isRealTransition && TERMINAL_STATE_TYPES.has(issue.state && issue.state.type) && !TERMINAL_STATE_TYPES.has(target.type)) {
        console.error(`\n⚠️  ${issue.identifier} was "${issue.state.name}" (a concluded state) — you're reopening it.`);
        console.error('   Read why it was concluded before proceeding:');
        const recent = newestComments(issue, 3);
        if (recent.length > 0) {
          for (const c of recent) {
            const author = (c.user && c.user.name) || 'unknown';
            const snippet = String(c.body || '').replace(/\s+/g, ' ').slice(0, 200);
            console.error(`   [${c.createdAt}] ${author}: ${snippet}${snippet.length === 200 ? '…' : ''}`);
          }
        } else if (issue.url) {
          console.error(`   (no comments fetched — read ${issue.url} directly)`);
        }
        console.error('');
      }

      // ORDER MATTERS, and the first version had it backwards. It moved the
      // state first, so a failing createComment exited 2 having ALREADY moved
      // the issue — the operator reads a non-zero exit as "nothing happened"
      // while the card sits in Done with no explanation. Comment first: a
      // stray comment is visible and recoverable; a silent state move is not.
      let commented = false;
      const landed = [];
      try {
        // The relation goes FIRST because it is the precondition for the
        // state move — creating it after the comment would reproduce the
        // partial-write the gate above exists to prevent, and a stray
        // relation (like a stray comment) is visible and reversible in
        // Linear's UI, unlike a silent state move.
        if (duplicateRelation) {
          await createIssueRelationFn(issue.id, duplicateRelation.id, DUPLICATE_STATE_TYPE);
          landed.push(`marked duplicate of ${duplicateRelation.identifier}`);
        }
        if (args.comment !== undefined) {
          // BRO-6067: an "Opening-night audit" comment carries the press-night verdict when it is not PASS.
          const note = require('./lib/press-night-audit-note').annotateAuditCard(issue.title, args.comment, require('path').join(__dirname, '..'), { onlyIfCleanClaim: true });
          if (note.changed) {
            args.comment = note.text;
            console.error(`PRESS-NIGHT: ${note.notPassing.length} record(s) not PASS for this audit; the comment now says so.`);
          }
          await createCommentFn(issue.id, args.comment);
          commented = true;
          landed.push('comment posted');
        }
        if (target && !isRealTransition && target.type === DUPLICATE_STATE_TYPE) {
          // Already in the requested duplicate state. The gate deliberately
          // skips a non-transition, so sending the write anyway would hand
          // Linear a duplicate-state mutation the gate never validated —
          // reopening the BRO-2711 partial write on the exact case the skip
          // exists for (codebase review, 2026-09-05).
          //
          // Scoped to duplicate-type targets ON PURPOSE. Suppressing every
          // no-op state write looked like a free win and was not: it broke
          // tests/unit/linear-brain-done-gate.test.mjs's "not gated: moving to
          // a non-completed state" case, whose fixture moves an In-Progress
          // issue to In Progress and asserts the write fires. Only the
          // duplicate mutation carries a server-side precondition, so only it
          // is dangerous to send unvalidated; changing the other state types'
          // long-standing behaviour is not this change's business.
          landed.push(`state already ${target.name} — no write needed`);
        } else if (target) {
          await updateIssueFn(issue.id, { stateId: target.id });
          landed.push(`state → ${target.name}`);
        }
      } catch (err) {
        // Say what DID land. A partial write reported as a bare failure is how
        // an operator ends up re-running and double-posting.
        if (landed.length) console.error(`⚠️  partially applied before the error: ${landed.join('; ')}`);
        throw err;
      }

      console.log(JSON.stringify({
        identifier: issue.identifier,
        url: issue.url,
        state: target ? target.name : (issue.state && issue.state.name) || null,
        commented,
        // Name the canonical twin whenever this was a duplicate move. Without
        // it the operator could not tell from the output whether the relation
        // — the part that makes the state move legal at all — actually
        // happened, or which issue it pointed at (fresh-eyes review finding).
        ...(duplicateTwin ? { duplicateOf: duplicateTwin } : {}),
      }, null, 2));
      // NOT __BOARD_CARD_ID__. That marker is the gate hooks' proof that a card
      // was FILED (notion-brain.js:669, consumed by notion-create-verify.sh),
      // and S4-T3c repoints those hooks onto it. Emitting it here would let
      // `update <any pre-existing issue> --comment "…"` satisfy the
      // "file a card before you commit" gate without filing anything — a
      // bypass built by the very sprint that hardens the gate.
      console.error(`ISSUE-UPDATED: ${issue.identifier}${target ? ` — state=${target.name}` : ''}${commented ? ' — commented' : ''}`);
      // BRO-2857: the state-type-based "card closed" proof (printed after
      // the write succeeded). Hooks grep this instead of state names.
      const reported = target ? require('./lib/linear-state-types').reportedMarker(issue.identifier, target.type) : '';
      if (reported) console.error(reported);
    } catch (err) {
      console.error(`\n❌ ${err.message}\n`);
      process.exit(2);
    }
    return;
  }

  if (command !== 'create') {
    console.error(USAGE);
    process.exit(1);
  }

  const title = args._positional[1];
  if (!title) {
    console.error('Usage: linear-brain create "Issue title" --notes "..." [--dispatch|--self|--park "<reason>"]');
    process.exit(1);
  }

  // BRO-5488: --new-anyway "<reason>" files even when an open card repeats this
  // one; the reason is kept on the card so the override is visible later.
  const newAnyway = args['new-anyway'];
  if (newAnyway === true || (typeof newAnyway === 'string' && newAnyway.trim().length < 10)) {
    console.error('--new-anyway needs a reason of at least 10 characters (why this is not the open card it matched).');
    process.exit(1);
  }
  // BRO-5626: --no-verify "<reason>" files a session card with no safe VERIFY; the reason stays on the card.
  const noVerify = args['no-verify'];
  if (noVerify === true || (typeof noVerify === 'string' && noVerify.trim().length < 10)) {
    console.error('--no-verify needs a reason of at least 10 characters (why this card has no safe VERIFY command).');
    process.exit(1);
  }
  if (args['dedupe-opt-out'] === true) {
    console.error('--dedupe-opt-out needs a name from scripts/lib/card-dedupe.js DEDUPE_OPT_OUTS.');
    process.exit(1);
  }
  // BRO-6080: --mac-only "<what needs the Mac and why>" routes the card to the Mac's drain, not the cloud worker.
  const macOnly = args['mac-only'];
  if (macOnly !== undefined && (macOnly === true || String(macOnly).trim().length < 10)) {
    console.error('--mac-only needs a reason of at least 10 characters (what needs the Mac and why).');
    process.exit(1);
  }
  // BRO-6359: --child "<child session title/task>": a child session (create_session) is starting on this card now.
  // Filed like --self (In Progress + claim comment) so the Mac worker, cloud-worker-pick and linear-next skip it.
  const childArg = args.child;
  if (childArg !== undefined && (childArg === true || String(childArg).trim().length < 10)) {
    console.error('--child needs the child session title or task, at least 10 characters (e.g. "BRO-N: <short>").');
    process.exit(1);
  }
  if (childArg !== undefined && (args.self || macOnly !== undefined)) {
    console.error('--child conflicts with --self and --mac-only: a child-claimed card is worked now by the child session.');
    process.exit(1);
  }
  if (args.self && macOnly !== undefined) {
    console.error('--self and --mac-only conflict: a self-claimed card is worked now by this session. Use --dispatch --mac-only for Mac work.');
    process.exit(1);
  }
  let notes = newAnyway ? `${args.notes || ''}\n\nFiled with --new-anyway: ${newAnyway}`.trim() : (args.notes || '');
  if (noVerify) notes = `${notes}\n\nFiled with --no-verify: ${noVerify}`.trim();
  // BRO-6067: the morning-after audit card must not read "no fixes needed" over a FAIL/UNKNOWN press-night record.
  const pressNight = require('./lib/press-night-audit-note').annotateAuditCard(title, notes, require('path').join(__dirname, '..'));
  if (pressNight.changed) {
    notes = pressNight.text;
    console.error(`PRESS-NIGHT: ${pressNight.notPassing.length} record(s) not PASS for this audit night (${pressNight.notPassing.map((r) => `${r.showId} ${r.verdict}`).join(', ')}); the card now says so.`);
  }
  // BRO-6130/BRO-6151: dated logs go to the local ledger and its durable parent-card comments.
  // LINEAR_ROUTINE_LOG_DIVERT=0 files it as a card again.
  const rlog = require('./lib/routine-log-ledger');
  // An audit with a not-PASS press-night record is a warning the owner must see: it stays a card.
  if (rlog.isRoutineLogTitle(title) && !pressNight.changed && process.env.LINEAR_ROUTINE_LOG_DIVERT !== '0') {
    let record = null;
    try {
      record = await rlog.recordRoutineLog({ title, notes, source: typeof args.source === 'string' ? args.source : undefined }, { getIssue: getIssueFn, createComment: createCommentFn });
    } catch (e) {
      // A failed local or durable write must not lose the record: file the card.
      console.error(`ROUTINE-LOG: ledger write failed (${e.message}); filing the card instead.`);
    }
    if (record) {
      console.error(`ROUTINE-LOG: "${title}" recorded in ${rlog.LEDGER_REL} and as a comment on ${record.identifier}; no new Linear card filed (dated logs are records).`);
      console.log(JSON.stringify({ routineLog: true, title, ledger: rlog.LEDGER_REL, identifier: record.identifier, notes }));
      printBoardCardId(record.identifier);
      process.exit(0);
    }
  }
  try {
    const result = await createLinearIssueFn({
      title,
      description: notes,
      dispatch: args.dispatch,
      park: args.park,
      self: args.self,
      child: childArg,
      priority: args.priority !== undefined ? Number(args.priority) : undefined,
      projectId: args['project-id'],
      model: args.model,
      reuseTwin: !newAnyway,
      source: typeof args.source === 'string' ? args.source
        : (process.env.GITHUB_WORKFLOW ? `workflow:${process.env.GITHUB_WORKFLOW}` : 'session'),
      newAnyway: newAnyway || undefined,
      noVerify: noVerify || undefined,
      macOnly: macOnly === undefined ? undefined : String(macOnly),
      dedupeOptOut: typeof args['dedupe-opt-out'] === 'string' ? args['dedupe-opt-out'] : undefined,
    });
    console.log(JSON.stringify(result.issue, null, 2));
    // Board-neutral marker (S1-T5, notion→linear cutover). Emitted BEFORE the
    // mode branch and in both modes, exactly like notion-brain.js emits
    // __NOTION_CARD_ID__ ahead of its own dispatch/park branch: the gate hooks
    // ask "does a card exist for this session", not "is it being worked", so
    // parking must satisfy the marker contract too or `--park` would wedge the
    // commit gate. Carries the human identifier (BRO-123) rather than the UUID
    // because that is what every Linear-side reader — linear-brain find,
    // linear-client getIssue, the issue URL — already keys on.
    printBoardCardId(result.issue.identifier);
    if (result.mode === 'reused' && result.nearDuplicate) {
      console.error(`ISSUE-REUSED: ${result.issue.identifier} ("${result.issue.title}") is already open and this title repeats it (score ${result.nearDuplicate.score.toFixed(2)}); the notes were added there as a comment (state=${result.stateName}). If it is really different work, re-run with --new-anyway "<reason>".`);
    } else if (result.mode === 'reused') {
      console.error(`ISSUE-REUSED: ${result.issue.identifier} ("${result.issue.title}") is already open ${result.countOnly ? 'with this title except for a count' : 'with this title'}; the notes were added there as a comment (state=${result.stateName})`);
    } else if (result.mode === 'rolled-up') {
      console.error(`ROLLED-UP: ${result.issue.identifier} ("${result.issue.title}") collects this filer's repeated findings of this kind; the notes were added there as a comment, no new card`);
    } else if (result.mode === 'self') {
      // BRO-6130: same trace `linear-session.js claim` leaves, so the next claimer sees who holds it.
      const lsr = require('./lib/linear-session-reporting');
      try {
        const childLine = childArg !== undefined ? `\nChild session starting on this card now: ${String(childArg).trim()}. Workers: do not take it.` : '';
        await createCommentFn(result.issue.id, lsr.buildClaimComment({ sessionRef: lsr.claimSessionRef(), ts: new Date().toISOString() }) + childLine);
      } catch (e) {
        console.error(`[linear-brain] WARN could not post the claim comment: ${e.message}`);
      }
      console.log(lsr.buildIssueIdMarker(result.issue.id));
      console.error(`ISSUE-FILED: ${result.issue.identifier} ("${result.issue.title}") — state=${result.stateName}, claimed by this session (${childArg !== undefined ? '--child' : '--self'})`);
    } else if (result.mode === 'dispatch') {
      console.error(`ISSUE-FILED: ${result.issue.identifier} ("${result.issue.title}") — state=${result.stateName}, not yet running (bsc-next Linear support pending #1303)`);
    } else if (result.autoTodo) {
      console.error(`ISSUE-FILED: ${result.issue.identifier} ("${result.issue.title}") — state=${result.stateName} (auto-Todo: the park reason is technical and the notes carry a safe VERIFY, so a worker can pick it up; BRO-5626)`);
    } else {
      console.error(`PARKED: ${result.issue.identifier} ("${result.issue.title}") — state=${result.stateName}`);
    }
    // Un-closable-by-construction check (BRO-3060). notion-brain.js has warned
    // about this at create time since 2026-07-26; this chokepoint, which
    // REPLACES it, never did — so 17 of the board's open issues carry an
    // acceptance command the Done gate refuses outright, and nobody learns
    // that until they try to close one. Warn-only and AFTER the create, on
    // purpose: automated filers (owner-alert-router.js, digest-autofix.js)
    // generate prose criteria, and a reject here would break the alert->card
    // chain. The hard stops stay downstream at dispatch and at the Done gate.
    //
    // Wrapped in its own try (ship-check finding): this sits INSIDE the create
    // try whose catch calls process.exit(2). Without this guard a throw in the
    // advisory warning — after the issue was already created — would report
    // the create as FAILED, and the caller would file it again. An advisory
    // must never be able to invalidate the thing it is advising about.
    try {
      const warning = armingWarning(args.notes || '');
      if (warning) console.error(`\n${warning}\n`);
    } catch (e) {
      console.error(`[linear-brain] acceptance-arming check failed (issue was still created): ${e.message}`);
    }
    await printCoordinatorReminder(coordinatorReminderFn, `${title}\n${args.notes || ''}`, result.issue.identifier);
    await warnPriorAnswers(title, {
      fetchCards: deps.fetchAnsweredCards,
      timeoutMs: deps.ownerRecallTimeoutMs,
    });
    // One-line nudge (owner 2026-10-03: the filer knows best how hard a card
    // is). Advisory only: without it the dispatcher's P0/retry rule decides.
    if (args.model === undefined) {
      console.error('[linear-brain] tip: add --model opus|sonnet to pick the worker model for this card (default: Opus for P0s and retries, else Sonnet)');
    }
  } catch (err) {
    if (err.code === 'NEAR_DUPLICATE_OPEN') {
      // BRO-5488: a --dispatch card that repeats an open card is refused (exit 8).
      console.error(`ALREADY-OPEN: ${err.message}`);
      if (err.twin) console.error(`__BOARD_CARD_MATCH__=${err.twin.identifier}`);
      process.exit(8);
    }
    console.error(`\n❌ ${err.message}\n`);
    process.exit(2);
  }
}

// Exported (not auto-invoked) when required as a module — the injectable
// `deps` param above lets tests drive create and update's Done-gate
// end-to-end without a live LINEAR_API_KEY, same convention as
// scripts/linear-next.js's main(argv, deps).
if (require.main === module) {
  main();
}

module.exports = { main };
