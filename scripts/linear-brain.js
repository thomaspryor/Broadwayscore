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

  create: --dispatch or --park "<reason>" is REQUIRED. Neither given → exit 2.
  find:   prints {"identifier": "BRO-N", ...} for the first OPEN issue whose
          title or body contains the term, or null. Sync-callable dedup seam
          for digest-autofix's fileCard (BRO-286) — filing the same
          persistent health row daily would otherwise mint one duplicate
          issue per day and reset attempt-memory each time.
`;

function parseArgs(argv) {
  const args = { _positional: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const raw = argv[i].slice(2);
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

async function main() {
  const argv = process.argv.slice(2);
  if (hasHelpFlag(argv)) {
    console.log(USAGE);
    return;
  }
  const args = parseArgs(argv);
  const command = args._positional[0];

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
