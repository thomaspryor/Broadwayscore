#!/usr/bin/env node
/**
 * linear-brain.js — CLI for filing a Linear issue through the one chokepoint
 * (scripts/lib/linear-issue-create.js) instead of hand-rolling a GraphQL
 * call. See that file's header for why this exists (task #1310).
 *
 * Usage:
 *   node scripts/linear-brain.js create "Issue title" --notes "description" \
 *     [--dispatch | --park "<reason>"] [--priority 0-4] [--project-id <id>]
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
const { hasHelpFlag } = require('./lib/cli-help');

const USAGE = `linear-brain.js — file a Linear issue through the one creation chokepoint.

Usage:
  node scripts/linear-brain.js create "Issue title" --notes "description" \\
    [--dispatch | --park "<reason>"] [--priority 0-4] [--project-id <id>]
  node scripts/linear-brain.js find "search term"

  node scripts/linear-brain.js --probe [--timeout-ms N]

  create: --dispatch or --park "<reason>" is REQUIRED. Neither given → exit 2.
  find:   prints {"identifier": "BRO-N", ...} for the first OPEN issue whose
          title or body contains the term, or null. Sync-callable dedup seam
          for digest-autofix's fileCard (BRO-286) — filing the same
          persistent health row daily would otherwise mint one duplicate
          issue per day and reset attempt-memory each time.
  --probe: read-only three-way health verdict for the gate hooks. Prints one
          BOARD_PROBE: line and exits 0 healthy / 3 erroring / 4 unreachable.
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

async function main() {
  const argv = process.argv.slice(2);
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

  if (command === 'find') {
    const term = args._positional[1];
    if (!term) {
      console.error('Usage: linear-brain find "search term" [--exact-title]');
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
      } else {
        match = await linearClient.searchIssues(term);
      }
      console.log(match ? JSON.stringify({ identifier: match.identifier, title: match.title, url: match.url }, null, 2) : 'null');
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
    console.error('Usage: linear-brain create "Issue title" --notes "..." [--dispatch|--park "<reason>"]');
    process.exit(1);
  }

  try {
    const result = await createLinearIssue({
      title,
      description: args.notes || '',
      dispatch: args.dispatch,
      park: args.park,
      priority: args.priority !== undefined ? Number(args.priority) : undefined,
      projectId: args['project-id'],
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
    console.error(`__BOARD_CARD_ID__=${result.issue.identifier}`);
    if (result.mode === 'dispatch') {
      console.error(`ISSUE-FILED: ${result.issue.identifier} ("${result.issue.title}") — state=${result.stateName}, not yet running (bsc-next Linear support pending #1303)`);
    } else {
      console.error(`PARKED: ${result.issue.identifier} ("${result.issue.title}") — state=${result.stateName}`);
    }
  } catch (err) {
    console.error(`\n❌ ${err.message}\n`);
    process.exit(2);
  }
}

main();
