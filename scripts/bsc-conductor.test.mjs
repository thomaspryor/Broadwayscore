import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
const require = createRequire(import.meta.url);
const { parseArgs, tailLines, formatWorkspaces, runOrientationSweep, buildSeed, STANDING_RULES, main, USAGE } =
  require('./bsc-conductor.js');

test('parseArgs: flags with values vs bare boolean flags', () => {
  assert.deepEqual(parseArgs(['--model', 'sonnet', '--dry-run']), { _: [], model: 'sonnet', 'dry-run': true });
  assert.deepEqual(parseArgs([]), { _: [] });
});

test('tailLines: returns last N lines, oldest dropped', () => {
  const readFn = () => 'a\nb\nc\nd\n';
  assert.equal(tailLines('/x', 2, readFn), 'c\nd');
  assert.equal(tailLines('/x', 10, readFn), 'a\nb\nc\nd');
});

test('tailLines: empty file vs missing file get distinct messages', () => {
  assert.match(tailLines('/x', 5, () => ''), /empty/);
  assert.match(tailLines('/x', 5, () => { throw new Error('ENOENT'); }), /no ledger file yet/);
});

test('formatWorkspaces: empty list, selected marker, ref+title rendered', () => {
  assert.match(formatWorkspaces([]), /none open/);
  const out = formatWorkspaces([
    { ref: 'workspace:1', title: 'Fix scraper', selected: false },
    { ref: 'workspace:2', title: 'Build thing', selected: true },
  ]);
  assert.match(out, /workspace:1 {2}Fix scraper/);
  assert.match(out, /workspace:2 \[selected\] {2}Build thing/);
});

test('runOrientationSweep: happy path threads runFn calls through to named fields', () => {
  const calls = [];
  const runFn = (cmd, args) => { calls.push(args.join(' ')); return `stub:${args.join(' ')}`; };
  const sweep = runOrientationSweep(runFn, {
    readFn: () => 'line1\nline2\n',
    cmuxAvailableFn: () => true,
    listWorkspacesFn: () => [{ ref: 'workspace:1', title: 'T', selected: false }],
  });
  assert.match(sweep.nextList, /^stub:scripts\/bsc-next\.js --list$/);
  assert.match(sweep.pruneDry, /^stub:scripts\/bsc-prune\.js --dry-run$/);
  assert.match(sweep.radar, /^stub:scripts\/morning-radar\.js$/);
  assert.match(sweep.needsApproval, /notion-brain\.js list --auto needs-approval,queued/);
  assert.match(sweep.urgent, /notion-brain\.js list --priority P0 Now/);
  assert.equal(sweep.ledgerTail, 'line1\nline2');
  assert.match(sweep.workspaces, /workspace:1 {2}T/);
});

test('runOrientationSweep: cmux unavailable is reported, not thrown', () => {
  const sweep = runOrientationSweep(() => 'x', { cmuxAvailableFn: () => false });
  assert.match(sweep.workspaces, /cmux CLI not found/);
});

test('runOrientationSweep: a failing sub-command degrades to a labeled message, not a crash', () => {
  const runFn = (cmd, args) => {
    if (args.includes('scripts/morning-radar.js')) throw new Error('boom\nstack trace');
    return 'ok';
  };
  const sweep = runOrientationSweep(runFn, { cmuxAvailableFn: () => false });
  assert.match(sweep.radar, /morning-radar failed: boom/);
  assert.equal(sweep.nextList, 'ok'); // unrelated fields unaffected
});

// ship-check P1: execFileSync's real Error.message shape is
// "Command failed: <cmd>\n<actual stderr>" — the diagnostic text is on line 2+,
// not line 1. A naive split('\n')[0] discarded exactly the useful part and left
// the seed prompt unable to distinguish a real failure from "nothing to report".
test('runOrientationSweep: execFileSync-shaped errors keep the real stderr, not the command echo', () => {
  const runFn = () => {
    throw new Error("Command failed: node scripts/bsc-next.js --list\n[bsc-next] shared task list 'x' is empty.\n");
  };
  const sweep = runOrientationSweep(runFn, { cmuxAvailableFn: () => false });
  assert.doesNotMatch(sweep.nextList, /^\(bsc-next --list failed: Command failed/);
  assert.match(sweep.nextList, /shared task list 'x' is empty/);
});

test('runOrientationSweep: a plain (non-execFileSync-shaped) error message passes through unchanged', () => {
  const runFn = () => { throw new Error('ENOENT: no such file'); };
  const sweep = runOrientationSweep(runFn, { cmuxAvailableFn: () => false });
  assert.match(sweep.nextList, /bsc-next --list failed: ENOENT: no such file/);
});

const SAMPLE_SWEEP = {
  nextList: '1. #7 [pending] [sonnet] Fix thing',
  ledgerTail: '{"event":"run-end"}',
  pruneDry: 'nothing to prune',
  workspaces: '  (none open)',
  radar: '[]',
  needsApproval: '[]',
  urgent: '[]',
  staleCards: '[{"name":"Ancient card"}]',
};

test('buildSeed embeds every sweep section under its own heading', () => {
  const seed = buildSeed(SAMPLE_SWEEP, '2026-07-14T21:30:00.000Z');
  assert.match(seed, /## Top actionable tasks \(bsc-next --list\)\n1\. #7 \[pending\] \[sonnet\] Fix thing/);
  assert.match(seed, /## Last 20 autonomous-ledger\.jsonl entries\n\{"event":"run-end"\}/);
  assert.match(seed, /## Cmux workspace prune check/);
  assert.match(seed, /## Open cmux workspaces\n {2}\(none open\)/);
  assert.match(seed, /## Morning radar/);
  assert.match(seed, /## Notion: needs-approval \/ queued cards/);
  assert.match(seed, /## Notion: P0 Now \/ Not started cards/);
  assert.match(seed, /2026-07-14T21:30:00\.000Z/);
});

test('buildSeed asks for a 5-line report first and defers re-running the sweep', () => {
  const seed = buildSeed(SAMPLE_SWEEP, 'now');
  assert.match(seed, /5-line state-of-the-world/);
  assert.match(seed, /Do not re-run the sweep commands yourself unless something above looks stale/);
});

test('buildSeed carries all 7 standing rules by number', () => {
  const seed = buildSeed(SAMPLE_SWEEP, 'now');
  for (let i = 1; i <= 7; i++) assert.match(seed, new RegExp(`${i}\\. [A-Z]`));
  assert.match(STANDING_RULES, /DISPATCH, DON'T IMPLEMENT/);
  assert.match(STANDING_RULES, /PIN MODELS ON EVERY FAN-OUT/);
  assert.match(STANDING_RULES, /CARD EVERY DISCOVERY/);
  assert.match(STANDING_RULES, /CONVERSE WITH THE OWNER/);
  assert.match(STANDING_RULES, /NO PASTE-PROMPTS/);
  assert.match(STANDING_RULES, /NO HUMAN-TERRITORY PICKS/);
  assert.match(STANDING_RULES, /STAY DISPOSABLE/);
});

// Behavior test (task #1438 — replaces a source-regex that pinned the exact
// ternary/ call-arg formatting, same fragile class as #1432/#1434). main()
// already takes spawnSync as a test seam; call it for real and capture what
// it was actually invoked with, instead of matching this file's source text.
test('main() defaults to --model opus --effort high, never a bare/inherited model', () => {
  let spawnCall = null;
  const spawnFn = (cmd, args, opts) => { spawnCall = { cmd, args, opts }; return { status: 0 }; };
  const origExit = process.exit;
  let exitCode = null;
  process.exit = (code) => { exitCode = code; throw new Error('__EXIT__'); };
  try {
    assert.throws(() => main([], () => 'ok', spawnFn), /__EXIT__/);
  } finally {
    process.exit = origExit;
  }
  assert.equal(exitCode, 0);
  assert.equal(spawnCall.cmd, 'claude');
  assert.deepEqual(spawnCall.args.slice(0, 4), ['--model', 'opus', '--effort', 'high']);
  // no --dangerously-skip-permissions: this is the owner's own interactive
  // session, unlike bsc-next's unattended dispatch targets.
  assert.ok(!spawnCall.args.includes('--dangerously-skip-permissions'));
});

test('main(): --model/--effort flags override the opus/high defaults, threaded to the real spawnSync call', () => {
  let spawnCall = null;
  const spawnFn = (cmd, args) => { spawnCall = { cmd, args }; return { status: 0 }; };
  const origExit = process.exit;
  process.exit = (code) => { throw new Error('__EXIT__'); };
  try {
    assert.throws(() => main(['--model', 'sonnet', '--effort', 'xhigh'], () => 'ok', spawnFn), /__EXIT__/);
  } finally {
    process.exit = origExit;
  }
  assert.deepEqual(spawnCall.args.slice(0, 4), ['--model', 'sonnet', '--effort', 'xhigh']);
});

// 2026-07-14 incident + scope add: `--help` used to run the full orientation
// sweep and open a real session. Guard: stub runFn/spawnSync and prove
// neither is ever invoked when --help/-h is passed.
test('--help exits before the orientation sweep or claude launch (zero cmux/LLM calls)', () => {
  const calls = [];
  const runFn = (...a) => { calls.push(a); throw new Error('runFn must not be called for --help'); };
  const spawnFn = () => { throw new Error('spawnSync must not be called for --help'); };
  assert.doesNotThrow(() => main(['--help'], runFn, spawnFn));
  assert.equal(calls.length, 0);
  assert.doesNotThrow(() => main(['--model', 'sonnet', '--help'], runFn, spawnFn));
  assert.equal(calls.length, 0);
});

test('-h is recognized the same as --help', () => {
  const runFn = () => { throw new Error('runFn must not be called for -h'); };
  const spawnFn = () => { throw new Error('spawnSync must not be called for -h'); };
  assert.doesNotThrow(() => main(['-h'], runFn, spawnFn));
});

test('USAGE mentions every documented flag', () => {
  assert.match(USAGE, /--model/);
  assert.match(USAGE, /--effort/);
  assert.match(USAGE, /--dry-run/);
  assert.match(USAGE, /--help, -h/);
});

// Belt-and-suspenders: run the real CLI as a subprocess. If the --help guard
// were ever removed, this would fall through to a real orientation sweep and
// then spawnSync('claude', ..., { stdio: 'inherit' }) — an interactive
// launch that would hang this test until the timeout killed it, instead of
// exiting immediately with usage text.
test('node scripts/bsc-conductor.js --help prints usage and exits 0 (real process)', () => {
  const out = execFileSync('node', [new URL('./bsc-conductor.js', import.meta.url).pathname, '--help'],
    { encoding: 'utf8', timeout: 10_000 });
  assert.match(out, /Usage:/);
  assert.match(out, /--dry-run/);
  assert.doesNotMatch(out, /orientation sweep done/);
});

test('seed embeds the stale-card kill/keep section (review gap fix)', () => {
  const seed = buildSeed(SAMPLE_SWEEP, 'now');
  assert.match(seed, /## Notion: stale cards \(Not started, untouched 90\+ days\)/);
  assert.match(seed, /Ancient card/);
  assert.match(seed, /owner-action/);
});
