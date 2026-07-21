#!/usr/bin/env node
/**
 * bsc-conductor — one word, one fresh orchestrator session.
 *
 * The 3-day interactive "Fable" session (2026-07-11 → 2026-07-14) proved the
 * conductor ROLE is valuable (dispatch, forensics, cross-session judgment,
 * single point of conversation) but an immortal session is the costliest way
 * to host it: a long-lived context re-read every turn, at the most expensive
 * model tier by default. All orchestration state already lives OUTSIDE any
 * one session's context — shared task list, autonomous-ledger.jsonl, Notion
 * cards, cmux workspaces — so a fresh session can reconstruct it in ~1 min.
 *
 * bsc-conductor runs that orientation sweep itself (plain child_process
 * calls, no LLM turns spent gathering data), embeds the results in a seed
 * prompt, and opens an interactive `claude` session on it — pinned to
 * --model opus (never the interactive default; see FORBIDDEN_MODEL_RE in
 * scripts/lib/autonomous-budget.js) and --effort high, in THIS terminal.
 *
 *   bsc-conductor                 run the sweep, open a session on it
 *   bsc-conductor --model sonnet  override the default model (opus)
 *   bsc-conductor --effort xhigh  override the default effort (high)
 *   bsc-conductor --dry-run       print the sweep + seed prompt, launch nothing
 */

const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync: realSpawnSync } = require('child_process');

const REPO = '/Users/tompryor/Broadwayscore';
const cmuxws = require('./lib/cmux-workspaces.js');
const { execErrorDetail } = require('./lib/exec-error-detail.js');
const { hasHelpFlag } = require('./lib/cli-help.js');

const USAGE = `bsc-conductor — one word, one fresh orchestrator session.

Usage:
  bsc-conductor                 run the sweep, open a session on it
  bsc-conductor --model sonnet  override the default model (opus)
  bsc-conductor --effort xhigh  override the default effort (high)
  bsc-conductor --dry-run       print the sweep + seed prompt, launch nothing
  bsc-conductor --help, -h      show this message, do nothing else
`;

function parseArgs(argv) {
  const a = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t.startsWith('--')) {
      const k = t.slice(2);
      const n = argv[i + 1];
      if (n === undefined || n.startsWith('--')) a[k] = true;
      else { a[k] = n; i++; }
    } else a._.push(t);
  }
  return a;
}

// ── sweep (pure-ish: runFn is a test seam so the real orientation commands
// never run under `node --test`) ────────────────────────────────────────────
function tailLines(filePath, n, readFn = fs.readFileSync) {
  try {
    const text = readFn(filePath, 'utf8');
    const lines = text.trim().split('\n').filter(Boolean);
    return lines.length ? lines.slice(-n).join('\n') : '(empty — no runs logged yet)';
  } catch {
    return '(no ledger file yet — nightly loop has not run)';
  }
}

function formatWorkspaces(list) {
  if (!list.length) return '  (none open)';
  return list.map(w => `  ${w.ref}${w.selected ? ' [selected]' : ''}  ${w.title}`).join('\n');
}

// runFn(cmd, args) -> stdout string | throws. Isolated so callers can stub it.
function runOrientationSweep(runFn, opts = {}) {
  const repo = opts.repo || REPO;
  // Keeps the real stderr, not the useless "Command failed: <cmd>" echo — see
  // scripts/lib/exec-error-detail.js (ship-check finding, 2026-07-14). Without
  // this a genuine sweep failure was indistinguishable from "nothing to report".
  const safe = (label, fn) => {
    try { return fn(); } catch (e) { return `(${label} failed: ${execErrorDetail(e, 500)})`; }
  };
  const nextList = safe('bsc-next --list', () => runFn('node', ['scripts/bsc-next.js', '--list']));
  const ledgerTail = safe('ledger tail', () =>
    tailLines(path.join(repo, 'data', 'audit', 'autonomous-ledger.jsonl'), 20, opts.readFn));
  const pruneDry = safe('bsc-prune --dry-run', () => runFn('node', ['scripts/bsc-prune.js', '--dry-run']));
  const workspaces = safe('cmux list-workspaces', () => {
    const listFn = opts.listWorkspacesFn || cmuxws.listWorkspaces;
    const availFn = opts.cmuxAvailableFn || cmuxws.cmuxAvailable;
    if (!availFn()) return '(cmux CLI not found)';
    return formatWorkspaces(listFn());
  });
  const radar = safe('morning-radar', () => runFn('node', ['scripts/morning-radar.js']));
  const needsApproval = safe('notion needs-approval sweep', () =>
    runFn('node', ['scripts/notion-brain.js', 'list', '--auto', 'needs-approval,queued', '--limit', '15']));
  const urgent = safe('notion P0 sweep', () =>
    runFn('node', ['scripts/notion-brain.js', 'list', '--priority', 'P0 Now', '--status', 'Not started', '--limit', '10']));
  // Backlog-relevance sweep (owner ask 2026-07-19: "do we only have real and
  // relevant cards?"): Not-started cards untouched for 90+ days are prime
  // dead-feature/expired-window candidates — 11 obsolete cards (ended Beat
  // the Critics + post-Tonys + expired soak checks) sat invisible until the
  // owner stumbled on them. The conductor proposes kill/keep; only the owner
  // decides.
  const staleCards = safe('notion stale-card sweep', () =>
    runFn('node', ['scripts/notion-brain.js', 'list', '--status', 'Not started', '--stale-days', '90', '--limit', '15']));
  return { nextList, ledgerTail, pruneDry, workspaces, radar, needsApproval, urgent, staleCards };
}

// ── seed prompt (pure — takes the sweep result, no side effects) ───────────
const STANDING_RULES = [
  `1. DISPATCH, DON'T IMPLEMENT. You orchestrate; concrete work happens in a separate session/worktree. Dispatch via ` +
  `\`node scripts/bsc-next.js --id <n> --model <model>\` (opens a Cmux workspace) — never edit code directly in this ` +
  `session unless the fix is genuinely trivial (single file, under ~2 minutes).`,
  `2. PIN MODELS ON EVERY FAN-OUT. Never dispatch without an explicit --model. A dispatched session with no --model ` +
  `silently inherits the interactive default (the expensive Fable/Mythos tier — 9 Fable workspaces burned in one ` +
  `night, 2026-07-13). Default to sonnet for mechanical/bounded work, opus for architecture or adversarial ` +
  `debugging — bsc-next.js's own resolveModel() already applies this judgment when you omit --model.`,
  `3. CARD EVERY DISCOVERY. Any new bug, gap, or follow-up you find gets a Notion card immediately: ` +
  `\`node scripts/notion-brain.js create "Title" --priority P... --category ... --notes "..."\`. Don't hold it in ` +
  `your own context as a mental TODO — this session is disposable, the card is not.`,
  `4. CONVERSE WITH THE OWNER. You're the single point of conversation — report state changes concisely. Reserve ` +
  `questions for genuine owner decisions (money, product direction, irreversible actions), formatted as: ` +
  `"DECISION NEEDED: <plain-English stakes>. My recommendation: X because Y. Default: doing X unless you say otherwise."`,
  `5. NO PASTE-PROMPTS. Never end a turn by telling the owner to paste a prompt into another session. If work needs ` +
  `to happen elsewhere, dispatch it yourself via bsc-next.js (or queue it as a Notion card for the nightly loop).`,
  `6. NO HUMAN-TERRITORY PICKS. Never dispatch or act on Marketing/Partnerships/human-action cards (see ` +
  `EXCLUDED_CATEGORIES in scripts/lib/autonomous-eligibility.js) — surface them to the owner, don't act on them.`,
  `7. STAY DISPOSABLE. Don't try to hold multi-day context yourself — rely on the externalized state (task list, ` +
  `ledger, Notion, cmux workspaces) each time you orient, the same way this session just did. If this conversation ` +
  `runs long, a fresh \`bsc-conductor\` re-orients in about a minute; that's cheaper than an immortal session.`,
].join('\n\n');

function buildSeed(sweep, fetchedAt) {
  return [
    `bsc-conductor: fresh orchestrator session —`,
    ``,
    `You are the conductor. Your job is dispatch, forensics, and cross-session judgment — not implementation. ` +
    `Everything below was gathered by bsc-conductor.js itself just before this session opened (finished ${fetchedAt}, ` +
    `no tool calls spent gathering it) — each section came from its own quick command a moment apart, not one atomic ` +
    `snapshot, so treat anything time-sensitive (cmux workspace state, in-flight dispatches) as approximate.`,
    ``,
    `## Top actionable tasks (bsc-next --list)`,
    sweep.nextList,
    ``,
    `## Last 20 autonomous-ledger.jsonl entries`,
    sweep.ledgerTail,
    ``,
    `## Cmux workspace prune check (bsc-prune --dry-run)`,
    sweep.pruneDry,
    ``,
    `## Open cmux workspaces`,
    sweep.workspaces,
    ``,
    `## Morning radar (shows opening soon)`,
    sweep.radar,
    ``,
    `## Notion: needs-approval / queued cards`,
    sweep.needsApproval,
    ``,
    `## Notion: P0 Now / Not started cards`,
    sweep.urgent,
    ``,
    `## Notion: stale cards (Not started, untouched 90+ days) — propose kill/keep`,
    `Split the cards below into two lists. Cards tagged \`owner-action\` are the owner's personal queue — render ` +
    `them as a compact "Waiting on you" list (no kill/keep editorializing unless one's feature clearly no longer ` +
    `exists). For the rest, say in ONE line whether each still looks relevant (check if its feature/window still ` +
    `exists) and recommend kill or keep. Close only the ones the owner confirms.`,
    sweep.staleCards,
    ``,
    `---`,
    ``,
    `Your first message: a 5-line state-of-the-world synthesized from the sweep above (in-flight work, anything ` +
    `stuck/stale, anything needing owner approval, CI/deploy health if visible in the ledger, and your recommended ` +
    `next dispatch). Do not re-run the sweep commands yourself unless something above looks stale or contradictory.`,
    ``,
    `Then operate as orchestrator under these standing rules:`,
    ``,
    STANDING_RULES,
  ].join('\n');
}

// ── main ─────────────────────────────────────────────────────────────────
function realRun(cmd, args) {
  return execFileSync(cmd, args, { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

// argv/runFn/spawnSync are test seams (defaults are the real argv + real
// child_process calls) — a --help/-h check is the FIRST thing that happens,
// before runFn or spawnSync are ever touched (2026-07-14 incident: --help ran
// the full sweep + opened a real session instead of printing usage).
function main(argv = process.argv.slice(2), runFn = realRun, spawnSync = realSpawnSync) {
  if (hasHelpFlag(argv)) { console.log(USAGE); return; }

  const args = parseArgs(argv);
  const model = typeof args.model === 'string' ? args.model : 'opus';
  const effort = typeof args.effort === 'string' ? args.effort : 'high';

  const sweep = runOrientationSweep(runFn);
  const seed = buildSeed(sweep, new Date().toISOString());

  if (args['dry-run'] || args['print-prompt']) {
    console.log(seed);
    return;
  }

  console.log(`[bsc-conductor] orientation sweep done — opening session (--model ${model} --effort ${effort})`);
  const r = spawnSync('claude', ['--model', model, '--effort', effort, '-n', 'bsc-conductor', seed],
    { stdio: 'inherit', cwd: REPO });
  if (r.error) { console.error(`[bsc-conductor] failed to launch claude: ${r.error.message}`); process.exit(1); }
  process.exit(r.status == null ? 1 : r.status); // null = killed by signal → non-zero
}

if (require.main === module) main();

module.exports = { parseArgs, tailLines, formatWorkspaces, runOrientationSweep, buildSeed, STANDING_RULES, main, USAGE };
