// BRO-7351: replay of real transcripts through main's and the branch's Stop hook.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  libsNamedIn, hookScope, hookScopeDiff, hookReplayWarning, stopPoints, eventsToRows,
  replayOne, compare, sameDecision, decisionOf, LEDGER, relativeImports, dirtyFiles, prepareTree,
  preToolUseHooks, matcherMatches, toolUsePoints, sampleCalls, decisionOfPre, replayTools, comparePre, inHookScope,
} from './hook-replay.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const asst = (text, extra = {}) => ({ type: 'assistant', message: { content: [{ type: 'text', text }] }, timestamp: '2026-11-11T01:00:00Z', ...extra });
const toolUse = () => ({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] } });
const user = (text) => ({ type: 'user', message: { content: text } });
const toolResult = () => ({ type: 'user', message: { content: [{ type: 'tool_result', content: 'ok' }] } });
const summary = (errs = []) => ({ type: 'system', subtype: 'stop_hook_summary', hookErrors: errs, timestamp: '2026-11-11T02:00:00Z' });
const git = (cwd, ...args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};

test('libsNamedIn: a lib the hook runs counts, as a path or as path segments; comments, echo text and watched-path lists do not', () => {
  const libs = ['root-cause-stop.mjs', 'stall-stop-gate.js', 'wait-for-land.js', 'only-in-comment.js', 'infra-review-scope.js',
    'writes.py', 'patterns.json', 'content-quality.js', 'review-guards.js', 'trailing.js'].map((f) => `scripts/lib/${f}`);
  const sh = [
    '# scripts/lib/only-in-comment.js is documented here',
    '_x=$(node "$VE_REPO_ROOT/scripts/lib/root-cause-stop.mjs" --stop-hook)',
    '  echo "run node scripts/lib/wait-for-land.js to check"',
    "python3 - <<'EOF'",
    "load('scripts/lib/stall-stop-gate.js')",
    "scope = os.path.join(root, 'scripts', 'lib', 'infra-review-scope.js')",
    "exec(open(os.path.join(lib, 'writes.py')).read()); pats = json.load(open(lib + '/patterns.json'))",
    "edited = p.endswith('/scripts/lib/content-quality.js')",
    "SCORING_LOGIC_FALLBACK = ('scripts/lib/review-guards.js', 'src/lib/scoring.ts')",
    "try:  # one source shared with scripts/lib/trailing.js",
    "x = run('not-a-lib.js')",
    'EOF',
  ].join('\n');
  assert.deepEqual(libsNamedIn(sh, libs), ['infra-review-scope.js', 'patterns.json', 'root-cause-stop.mjs', 'stall-stop-gate.js', 'writes.py'].map((f) => `scripts/lib/${f}`));
});

test('relativeImports: top-level imports and requires count, a lazy require inside a function does not', () => {
  const have = new Set(['scripts/lib/a.mjs', 'scripts/lib/b.js', 'scripts/lib/c.js', 'scripts/lib/lazy.js', 'src/lib/d.js']);
  const text = [
    "import { x } from './a.mjs';",
    "const b = require('./b');",
    "const { y } = require('./c.js'); const n = require('./missing.js');",
    "const d = require('../../src/lib/d.js');",
    'function f() {',
    "  return require('./lazy.js').go();",
    '}',
  ].join('\n');
  assert.deepEqual(relativeImports('scripts/lib/gate.js', text, have), ['scripts/lib/a.mjs', 'scripts/lib/b.js', 'scripts/lib/c.js', 'src/lib/d.js']);
});

test('hookScope of this repo includes the Stop-check libs verify-edits.sh runs', () => {
  const s = hookScope(REPO, 'HEAD');
  const want = ['root-cause-stop.mjs', 'review-coverage.mjs', 'decision-restate.js', // named as paths
    'infra-review-scope.js', 'verify_edits_writes.py', 'wake-promise-patterns.json', // named as path segments
    'transcript-scan.mjs', 'root-cause-close.js', 'visual-approval.js']; // imported by those
  for (const f of want) assert.ok(s.libs.includes(`scripts/lib/${f}`), `${f} missing from ${s.libs.join(', ')}`);
  assert.equal(s.hook, '.claude/hooks/verify-edits.sh');
  for (const f of ['content-quality.js', 'review-guards.js']) {
    assert.ok(!s.libs.includes(`scripts/lib/${f}`), `${f} is not code a replayed hook runs at load (a watched path, message text or a lazy Linear call)`);
  }
  // BRO-7352: the PreToolUse hooks registered in settings.json are in scope, with the libs they run.
  for (const f of ['.claude/hooks/pre-push-review-gate.sh', '.claude/hooks/worktree-enforce.sh', '.claude/hooks/infra-plan-review-gate.sh', '.claude/settings.json']) {
    assert.ok(s.hooks.includes(f), `${f} missing from ${s.hooks.join(', ')}`);
  }
  assert.ok(s.libs.includes('scripts/lib/land-preflight.mjs'), 'land-preflight.mjs is run by pre-push-land-preflight.sh');
  assert.ok(s.libs.length < 90, `scope grew to ${s.libs.length} files; a lazy or Linear-side import is probably being followed`);
});

test('stopPoints, recorded Stops: cut before the turn text, hook 1 errors are blocks, hook 2 errors are not', () => {
  const rows = [user('go'), toolUse(), toolResult(), asst('first close'), summary(['[command hook 1]: BLOCKED: x\n[VE:NOCHAIN]']), asst('second close'), summary(['[command hook 2]: unpushed commits'])];
  const s = stopPoints(rows);
  assert.equal(s.length, 2);
  assert.deepEqual([s[0].cut, s[0].text, s[0].recorded], [3, 'first close', 'block']);
  assert.match(s[0].recordedTag, /^BLOCKED: x/);
  assert.deepEqual([s[1].cut, s[1].text, s[1].recorded], [5, 'second close', 'allow']);
});

test('stopPoints, no recorded Stops: turn ends are the last text before a real user message, tool results do not end a turn', () => {
  const rows = [user('a'), asst('thinking'), toolUse(), toolResult(), asst('done 1'), user('b'), asst('side', { isSidechain: true }), asst('done 2')];
  const s = stopPoints(rows);
  assert.deepEqual(s.map((x) => [x.cut, x.text, x.recorded]), [[4, 'done 1', null], [7, 'done 2', null]]);
});

test('eventsToRows: list_events pages become ordered transcript rows, duplicates merged, subagent rows marked', () => {
  const page = (data) => `result: ${JSON.stringify({ ccr: { data } })}`;
  const rows = eventsToRows([
    page([{ created_at: '2026-11-11T00:00:02Z', assistant: { uuid: 'b', message: { content: [{ type: 'text', text: 'hi' }] } } }]),
    page([
      { created_at: '2026-11-11T00:00:01Z', user: { uuid: 'a', message: { content: 'go' } } },
      { created_at: '2026-11-11T00:00:02Z', assistant: { uuid: 'b', message: { content: [{ type: 'text', text: 'hi' }] } } },
      { created_at: '2026-11-11T00:00:03Z', assistant: { uuid: 'c', internal_anthropic_catchall: { agent_id: 'x', message: { content: 'sub' } } } },
    ]),
  ]);
  assert.deepEqual(rows.map((r) => [r.uuid, r.type, r.isSidechain]), [['a', 'user', false], ['b', 'assistant', false], ['c', 'assistant', true]]);
});

test('decisionOf / sameDecision: exit codes, VE tags, untagged older hooks matched on their message', () => {
  assert.equal(decisionOf({ code: 0, stderr: '' }).decision, 'allow');
  assert.deepEqual(decisionOf({ code: 2, stderr: '🛑 BLOCKED: nope\n[VE:RCOV]\n' }), { decision: 'block', tag: 'RCOV', detail: '🛑 BLOCKED: nope' });
  assert.equal(decisionOf({ code: 1, stderr: 'TypeError' }).decision, 'crash');
  assert.equal(decisionOf({ code: null, stderr: '', timedOut: true }).tag, 'TIMEOUT');
  const old = { decision: 'block', tag: '?', detail: '🛑 BLOCKED: same words' };
  assert.equal(sameDecision(old, { decision: 'block', tag: 'NOCHAIN', detail: '🛑 BLOCKED: same words' }), true);
  assert.equal(sameDecision(old, { decision: 'block', tag: 'NOCHAIN', detail: '🛑 BLOCKED: other words' }), false);
  assert.equal(sameDecision({ decision: 'block', tag: 'A', detail: 'x' }, { decision: 'block', tag: 'B', detail: 'x' }), false);
});

function fakeTree(hookBody) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-replay-tree-'));
  fs.mkdirSync(path.join(dir, '.claude', 'hooks'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude', 'hooks', 'verify-edits.sh'), `#!/bin/bash\n${hookBody}\n`, { mode: 0o755 });
  return dir;
}

test('replayOne + compare: a hook that changed its decision is reported, in a sandbox with no real HOME, keys or gh', async () => {
  // Both hooks refuse to run with a real HOME, any secret, or a working gh, so a leak shows as a crash.
  const guard = [
    'in=$(cat)',
    `[ "$HOME" = "${os.homedir()}" ] && { echo "real HOME" >&2; exit 7; }`,
    '[ -n "${LINEAR_API_KEY:-}${OPENAI_API_KEY:-}${GH_TOKEN:-}" ] && { echo "secret leaked" >&2; exit 7; }',
    'gh api user >/dev/null 2>&1 && { echo "gh works" >&2; exit 7; }',
    '[ "$HOOK_REPLAY" = 1 ] || exit 7',
    '[ -z "${CLAUDE_PROJECT_DIR:-}" ] && [ "$BOARD_GATE_DISABLED" = 1 ] || { echo "live checkout or board reachable" >&2; exit 7; }',
    'n=$(wc -l < "$(printf %s "$in" | node -e \'process.stdout.write(JSON.parse(require("fs").readFileSync(0,"utf8")).transcript_path)\')")',
    'echo "$n" >> "$TMPDIR/seen"',
  ].join('\n');
  const base = fakeTree(`${guard}\nexit 0`);
  const head = fakeTree(`${guard}\ncase "$in" in *BLOCKME*) echo "🛑 BLOCKED: blocked it" >&2; echo "[VE:FAKE]" >&2; exit 2;; esac\nexit 0`);
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-replay-bin-'));
  fs.writeFileSync(path.join(bin, 'gh'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const saved = { LINEAR_API_KEY: process.env.LINEAR_API_KEY, GH_TOKEN: process.env.GH_TOKEN, CLAUDE_PROJECT_DIR: process.env.CLAUDE_PROJECT_DIR };
  process.env.CLAUDE_PROJECT_DIR = REPO;
  process.env.LINEAR_API_KEY = 'lin_dummy';
  process.env.GH_TOKEN = 'dummy';
  try {
    const rows = [user('go'), asst('fine SAFE TO ARCHIVE'), user('more'), asst('please BLOCKME'), user('again'), asst('fine again')];
    const lines = rows.map((r) => JSON.stringify(r));
    const stops = stopPoints(rows);
    assert.equal(stops.length, 3);
    const [b, h] = await Promise.all([
      replayOne({ tree: base, lines, stops, label: 't-base', binDir: bin, timeoutMs: 20000 }),
      replayOne({ tree: head, lines, stops, label: 't-head', binDir: bin, timeoutMs: 20000 }),
    ]);
    assert.deepEqual(b.map((d) => d.decision), ['allow', 'allow', 'allow'], JSON.stringify(b));
    assert.deepEqual(h.map((d) => [d.decision, d.tag]), [['allow', ''], ['block', 'FAKE'], ['allow', '']], JSON.stringify(h));
    const c = compare(stops, b, h);
    assert.equal(c.changed.length, 1);
    assert.equal(c.changed[0].i, 1);
    assert.match(c.changed[0].message, /BLOCKME/);
    assert.deepEqual(c.crashes, { base: 0, head: 0 });
    assert.equal(c.fidelity, null);
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    for (const d of [base, head, bin]) fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test('replayOne: the hook sees the transcript growing stop by stop, without the turn text it is judging', async () => {
  const tree = fakeTree('in=$(cat)\np=$(printf %s "$in" | node -e \'process.stdout.write(JSON.parse(require("fs").readFileSync(0,"utf8")).transcript_path)\')\ngrep -q "final words" "$p" && exit 9\nexit 0');
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-replay-bin-'));
  try {
    const rows = [user('a'), asst('final words one'), summary(), user('b'), asst('final words two'), summary()];
    const res = await replayOne({ tree, lines: rows.map((r) => JSON.stringify(r)), stops: stopPoints(rows), label: 't-cut', binDir: bin, timeoutMs: 20000 });
    // Stop 2's cut includes stop 1's text (already written), so only stop 1 is clean.
    assert.deepEqual(res.map((d) => d.decision), ['allow', 'crash']);
  } finally {
    fs.rmSync(tree, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    fs.rmSync(bin, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test('hookScopeDiff + hookReplayWarning: warn on a hook-lib change with no replay row, quiet once recorded or when out of scope', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-replay-git-'));
  try {
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'config', 'user.email', 't@t');
    git(dir, 'config', 'user.name', 't');
    fs.mkdirSync(path.join(dir, '.claude', 'hooks'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'scripts', 'lib'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.claude', 'hooks', 'verify-edits.sh'), 'node "$R/scripts/lib/gate.mjs"\n# scripts/lib/doc-only.js\n');
    fs.writeFileSync(path.join(dir, 'scripts', 'lib', 'gate.mjs'), 'export default 1;\n');
    fs.writeFileSync(path.join(dir, 'scripts', 'lib', 'doc-only.js'), '1;\n');
    fs.writeFileSync(path.join(dir, 'README.md'), 'x\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'base');
    git(dir, 'checkout', '-qb', 'work');

    fs.writeFileSync(path.join(dir, 'README.md'), 'y\n');
    fs.writeFileSync(path.join(dir, 'scripts', 'lib', 'doc-only.js'), '2;\n');
    fs.writeFileSync(path.join(dir, '.claude', 'hooks', 'pre-push-other.sh'), 'node scripts/lib/doc-only.js\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'out of scope: README, a lib only a non-Stop hook runs, a new non-Stop hook');
    assert.equal(hookScopeDiff(dir, 'main', 'HEAD').hash, null);
    assert.equal(hookReplayWarning({ root: dir, src: 'HEAD', base: 'main' }), null);

    fs.writeFileSync(path.join(dir, 'scripts', 'lib', 'gate.mjs'), 'export default 2;\n');
    git(dir, 'commit', '-qam', 'gate change');
    const d = hookScopeDiff(dir, 'main', 'HEAD');
    assert.deepEqual(d.files, ['scripts/lib/gate.mjs']);
    assert.match(d.hash, /^[0-9a-f]{16}$/);
    const w = hookReplayWarning({ root: dir, src: 'HEAD', base: 'main' });
    assert.match(w, /scripts\/lib\/gate\.mjs/);
    assert.match(w, /hook-replay\.mjs --record/);

    fs.writeFileSync(path.join(dir, LEDGER), JSON.stringify({ hash: 'someotherhash' }) + '\n' + JSON.stringify({ hash: d.hash }) + '\n');
    assert.equal(hookReplayWarning({ root: dir, src: 'HEAD', base: 'main' }), null);

    fs.writeFileSync(path.join(dir, '.claude', 'hooks', 'verify-edits.sh'), 'node "$R/scripts/lib/gate.mjs" --strict\n');
    git(dir, 'commit', '-qam', 'hook change');
    assert.notEqual(hookScopeDiff(dir, 'main', 'HEAD').hash, d.hash, 'a further hook edit needs a new replay');
    assert.match(hookReplayWarning({ root: dir, src: 'HEAD', base: 'main' }), /verify-edits\.sh/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test('hookReplayWarning never throws (a broken repo is silent)', () => {
  assert.equal(hookReplayWarning({ root: '/nonexistent-dir', src: 'HEAD', base: 'main' }), null);
});

test('dirtyFiles: the first porcelain line keeps its whole path (an unstaged hook edit is caught by --record)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-replay-dirty-'));
  try {
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'config', 'user.email', 't@t');
    git(dir, 'config', 'user.name', 't');
    fs.mkdirSync(path.join(dir, '.claude', 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.claude', 'hooks', 'verify-edits.sh'), 'a\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'base');
    fs.writeFileSync(path.join(dir, '.claude', 'hooks', 'verify-edits.sh'), 'b\n');
    fs.mkdirSync(path.join(dir, 'scripts', 'lib'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'scripts', 'lib', 'new.js'), '1;\n');
    assert.deepEqual(dirtyFiles(dir).sort(), ['.claude/hooks/verify-edits.sh', 'scripts/lib/new.js']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test('prepareTree: refuses a leftover directory that is not its own worktree; the head tree gets uncommitted and new files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-replay-tree-'));
  try {
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'config', 'user.email', 't@t');
    git(dir, 'config', 'user.name', 't');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'committed\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'base');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'edited\n');
    fs.mkdirSync(path.join(dir, 'lib'));
    fs.writeFileSync(path.join(dir, 'lib', 'new.js'), 'new\n');

    fs.mkdirSync(path.join(dir, '.claude', 'worktrees', 'leftover'), { recursive: true });
    assert.throws(() => prepareTree(dir, 'leftover', 'HEAD'), /not a worktree of its own/);
    assert.equal(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8'), 'edited\n', 'the main checkout was not touched');

    const t = prepareTree(dir, 'head', 'HEAD', { withDirtyFrom: dir });
    assert.equal(fs.readFileSync(path.join(t, 'a.txt'), 'utf8'), 'edited\n');
    assert.equal(fs.readFileSync(path.join(t, 'lib', 'new.js'), 'utf8'), 'new\n');
    assert.equal(prepareTree(dir, 'head', 'HEAD'), t, 'an existing worktree is reused');
    assert.equal(fs.readFileSync(path.join(t, 'a.txt'), 'utf8'), 'committed\n');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

// ------------------------------------------------------------------ BRO-7352: PreToolUse

const settingsFor = (scripts) => JSON.stringify({
  hooks: {
    PreToolUse: scripts.map(([matcher, script]) => ({ matcher, hooks: [{ type: 'command', command: `bash "$CLAUDE_PROJECT_DIR/.claude/hooks/${script}" || bash ".claude/hooks/${script}"` }] })),
    Stop: [{ matcher: '*', hooks: [{ type: 'command', command: 'bash .claude/hooks/verify-edits.sh' }] }],
  },
});

test('preToolUseHooks + matcherMatches: PreToolUse commands only, matcher is an anchored regex, * and empty match all', () => {
  const hooks = preToolUseHooks(settingsFor([['Bash|Edit', 'a.sh'], ['mcp__github__(push_files|create_pull_request)', 'b.sh'], ['*', 'c.sh']]));
  assert.deepEqual(hooks.map((h) => [h.matcher, h.script]), [['Bash|Edit', '.claude/hooks/a.sh'], ['mcp__github__(push_files|create_pull_request)', '.claude/hooks/b.sh'], ['*', '.claude/hooks/c.sh']]);
  assert.equal(matcherMatches('Bash|Edit', 'Bash'), true);
  assert.equal(matcherMatches('Bash|Edit', 'BashOutput'), false, 'anchored: a prefix is not a match');
  assert.equal(matcherMatches('mcp__github__(push_files|create_pull_request)', 'mcp__github__push_files'), true);
  assert.equal(matcherMatches('', 'Anything'), true);
  assert.equal(matcherMatches('*', 'Anything'), true);
  assert.deepEqual(preToolUseHooks('not json'), []);
});

test('toolUsePoints: one point per tool_use block of a main-chain assistant row, cut includes the row; sampleCalls keeps order and spread', () => {
  const rows = [user('go'), { type: 'assistant', message: { content: [{ type: 'text', text: 'x' }, { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }, { type: 'tool_use', id: 't2', name: 'Edit', input: { file_path: 'a' } }] }, timestamp: 'T1' },
    toolResult(), { ...toolUse(), isSidechain: true }, { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't3', name: 'Write', input: {} }] } }];
  const pts = toolUsePoints(rows);
  assert.deepEqual(pts.map((p) => [p.id, p.name, p.cut]), [['t1', 'Bash', 2], ['t2', 'Edit', 2], ['t3', 'Write', 5]]);
  assert.equal(pts[0].ts, 'T1');
  const many = Array.from({ length: 100 }, (_, i) => ({ id: i }));
  const s = sampleCalls(many, 10);
  assert.equal(s.length, 10);
  assert.deepEqual(s.map((x) => x.id), [0, 10, 20, 30, 40, 50, 60, 70, 80, 90]);
  assert.equal(sampleCalls(many, 500), many);
});

test('decisionOfPre: exit 2 and a stdout permissionDecision deny both deny; other exits crash; plain stdout allows', () => {
  assert.deepEqual(decisionOfPre({ code: 2, stderr: '🛑 BLOCKED: no push\n' }), { decision: 'block', tag: '?', detail: '🛑 BLOCKED: no push' });
  assert.equal(decisionOfPre({ code: 2, stderr: 'BLOCKED [PG:MAIN]' }).tag, 'PG:MAIN');
  const j = decisionOfPre({ code: 0, stdout: JSON.stringify({ hookSpecificOutput: { permissionDecision: 'deny', permissionDecisionReason: 'because' } }) });
  assert.deepEqual([j.decision, j.detail], ['block', 'because']);
  assert.equal(decisionOfPre({ code: 0, stdout: JSON.stringify({ hookSpecificOutput: { permissionDecision: 'allow' } }) }).decision, 'allow');
  assert.equal(decisionOfPre({ code: 0, stdout: '{"systemMessage":"note"}' }).decision, 'allow');
  assert.equal(decisionOfPre({ code: 0, stdout: 'plain text' }).decision, 'allow');
  const pre = decisionOfPre({ code: 0, stdout: 'warming up\n' + JSON.stringify({ hookSpecificOutput: { permissionDecision: 'deny', permissionDecisionReason: 'late json' } }) + '\n' });
  assert.deepEqual([pre.decision, pre.detail], ['block', 'late json'], 'log lines before the JSON do not hide a deny');
  assert.equal(decisionOfPre({ code: 1, stderr: 'boom' }).decision, 'crash');
  assert.equal(decisionOfPre({ code: null, timedOut: true }).tag, 'TIMEOUT');
});

function fakePreTree(settings, hooks) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-replay-pre-'));
  fs.mkdirSync(path.join(dir, '.claude', 'hooks'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude', 'settings.json'), settings);
  for (const [name, body] of Object.entries(hooks)) fs.writeFileSync(path.join(dir, '.claude', 'hooks', name), `#!/bin/bash\n${body}\n`, { mode: 0o755 });
  return dir;
}

test('replayTools + comparePre: a fake PreToolUse hook that starts denying is reported as a changed decision, in the sandbox', async () => {
  const guard = [
    'in=$(cat)',
    `[ "$HOME" = "${os.homedir()}" ] && { echo "real HOME" >&2; exit 7; }`,
    '[ -n "${LINEAR_API_KEY:-}${GH_TOKEN:-}" ] && { echo "secret leaked" >&2; exit 7; }',
    '[ "$HOOK_REPLAY" = 1 ] && [ "$BOARD_GATE_DISABLED" = 1 ] && [ -z "${CLAUDE_PROJECT_DIR:-}" ] || { echo "not sandboxed" >&2; exit 7; }',
    'case "$in" in *PreToolUse*) ;; *) echo "wrong event" >&2; exit 7;; esac',
  ].join('\n');
  const settings = settingsFor([['Bash', 'fake-guard.sh'], ['Edit|Write', 'edit-guard.sh']]);
  const base = fakePreTree(settings, { 'fake-guard.sh': `${guard}\nexit 0`, 'edit-guard.sh': `${guard}\nexit 0` });
  const head = fakePreTree(settings, {
    'fake-guard.sh': `${guard}\ncase "$in" in *git\\ push*) echo "🛑 BLOCKED: no push" >&2; exit 2;; esac\nexit 0`,
    'edit-guard.sh': `${guard}\ncase "$in" in *secrets.env*) printf '{"hookSpecificOutput":{"permissionDecision":"deny","permissionDecisionReason":"no secrets"}}'; exit 0;; esac\nexit 0`,
  });
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-replay-bin-'));
  const saved = { LINEAR_API_KEY: process.env.LINEAR_API_KEY, CLAUDE_PROJECT_DIR: process.env.CLAUDE_PROJECT_DIR };
  process.env.LINEAR_API_KEY = 'lin_dummy';
  process.env.CLAUDE_PROJECT_DIR = REPO;
  try {
    const mk = (id, name, input) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } });
    const rows = [user('go'), mk('a', 'Bash', { command: 'ls' }), mk('b', 'Bash', { command: 'git push origin main' }), mk('c', 'Edit', { file_path: 'x/secrets.env' }),
      mk('d', 'Edit', { file_path: 'x/ok.txt' }), mk('e', 'Read', { file_path: 'x' })];
    const lines = rows.map((r) => JSON.stringify(r));
    const calls = toolUsePoints(rows);
    assert.equal(calls.length, 5);
    const run = (tree, label) => replayTools({ tree, hooks: preToolUseHooks(fs.readFileSync(path.join(tree, '.claude', 'settings.json'), 'utf8')), lines, calls, label, binDir: bin, timeoutMs: 20000 });
    const [b, h] = await Promise.all([run(base, 'pt-base'), run(head, 'pt-head')]);
    assert.deepEqual(b.map((per) => Object.keys(per).length), [1, 1, 1, 1, 0], 'Read matches no hook');
    assert.ok(Object.values(b).every((per) => Object.values(per).every((d) => d.decision === 'allow')), JSON.stringify(b));
    const c = comparePre(calls, b, h);
    assert.deepEqual(c.changed.map((x) => [x.i, x.tool, path.basename(x.script), x.base.decision, x.head.decision]), [[1, 'Bash', 'fake-guard.sh', 'allow', 'block'], [2, 'Edit', 'edit-guard.sh', 'allow', 'block']]);
    assert.match(c.changed[0].input, /git push origin main/);
    assert.equal(c.changed[1].head.detail, 'no secrets');
    assert.deepEqual(c.denied, { base: 0, head: 2 });
    assert.deepEqual(c.crashes, { base: 0, head: 0 });
    assert.equal(c.hookRuns, 4);
    // Identical trees: nothing changed.
    const same = comparePre(calls, b, await run(base, 'pt-same'));
    assert.equal(same.changed.length, 0);
    // A hook dropped from head's settings.json that used to deny flips deny -> allow.
    const dropped = comparePre(calls, h, b);
    assert.deepEqual(dropped.changed.map((x) => [x.base.decision, x.head.decision]), [['block', 'allow'], ['block', 'allow']]);
    const gone = comparePre(calls, h, h.map(() => ({})));
    assert.equal(gone.changed.length, 2, 'a hook missing on one side counts as allow');
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    for (const d of [base, head, bin]) fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test('replayTools: the hook sees the transcript up to and including the call, never later rows', async () => {
  const tree = fakePreTree(settingsFor([['Bash', 'peek.sh']]), { 'peek.sh': 'in=$(cat)\np=$(printf %s "$in" | node -e \'process.stdout.write(JSON.parse(require("fs").readFileSync(0,"utf8")).transcript_path)\')\ngrep -q "LATER" "$p" && exit 9\ngrep -q "THIS_CALL" "$p" || exit 8\nexit 0' });
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-replay-bin-'));
  try {
    const mk = (id, cmd) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command: cmd } }] } });
    const rows = [user('go'), mk('a', 'echo THIS_CALL'), toolResult(), asst('LATER words'), mk('b', 'echo THIS_CALL again')];
    const calls = toolUsePoints(rows);
    const res = await replayTools({ tree, hooks: preToolUseHooks(fs.readFileSync(path.join(tree, '.claude', 'settings.json'), 'utf8')), lines: rows.map((r) => JSON.stringify(r)), calls, label: 'pt-cut', binDir: bin, timeoutMs: 20000 });
    const d = res.map((per) => per['.claude/hooks/peek.sh'].decision);
    assert.deepEqual(d, ['allow', 'crash'], 'call 1 sees no LATER row; call 2 legitimately sees it');
  } finally {
    fs.rmSync(tree, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    fs.rmSync(bin, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test('hookScope + hookReplayWarning: a registered PreToolUse hook, its lib and settings.json are in scope; an unregistered hook is not', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-replay-prescope-'));
  try {
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'config', 'user.email', 't@t');
    git(dir, 'config', 'user.name', 't');
    fs.mkdirSync(path.join(dir, '.claude', 'hooks'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'scripts', 'lib'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.claude', 'settings.json'), settingsFor([['Bash', 'guard.sh']]));
    fs.writeFileSync(path.join(dir, '.claude', 'hooks', 'verify-edits.sh'), 'exit 0\n');
    fs.writeFileSync(path.join(dir, '.claude', 'hooks', 'guard.sh'), 'node "$R/scripts/lib/guard-lib.mjs"\n');
    fs.writeFileSync(path.join(dir, '.claude', 'hooks', 'unregistered.sh'), 'echo x\n');
    fs.writeFileSync(path.join(dir, 'scripts', 'lib', 'guard-lib.mjs'), 'export default 1;\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'base');
    git(dir, 'checkout', '-qb', 'work');
    const s = hookScope(dir, 'HEAD');
    assert.deepEqual(s.hooks, ['.claude/hooks/verify-edits.sh', '.claude/hooks/guard.sh', '.claude/settings.json']);
    assert.deepEqual(s.libs, ['scripts/lib/guard-lib.mjs']);
    assert.equal(inHookScope('.claude/hooks/unregistered.sh', s), false);

    fs.writeFileSync(path.join(dir, '.claude', 'hooks', 'unregistered.sh'), 'echo y\n');
    git(dir, 'commit', '-qam', 'unregistered hook');
    assert.equal(hookReplayWarning({ root: dir, src: 'HEAD', base: 'main' }), null);

    fs.writeFileSync(path.join(dir, 'scripts', 'lib', 'guard-lib.mjs'), 'export default 2;\n');
    git(dir, 'commit', '-qam', 'lib a PreToolUse hook runs');
    assert.match(hookReplayWarning({ root: dir, src: 'HEAD', base: 'main' }), /scripts\/lib\/guard-lib\.mjs/);

    fs.writeFileSync(path.join(dir, LEDGER), JSON.stringify({ hash: hookScopeDiff(dir, 'main', 'HEAD').hash }) + '\n');
    assert.equal(hookReplayWarning({ root: dir, src: 'HEAD', base: 'main' }), null);
    fs.writeFileSync(path.join(dir, '.claude', 'hooks', 'guard.sh'), 'exit 2\n');
    git(dir, 'commit', '-qam', 'the hook itself');
    assert.match(hookReplayWarning({ root: dir, src: 'HEAD', base: 'main' }), /guard\.sh/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test('prepareTree isolated: a separate git dir, so a hook writing next to the common dir cannot reach the source repo', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-replay-iso-'));
  try {
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'config', 'user.email', 't@t');
    git(dir, 'config', 'user.name', 't');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'committed\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'base');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'edited\n');
    const t = prepareTree(dir, 'iso', 'HEAD', { withDirtyFrom: dir, isolated: true });
    assert.equal(fs.readFileSync(path.join(t, 'a.txt'), 'utf8'), 'edited\n');
    const common = git(t, 'rev-parse', '--path-format=absolute', '--git-common-dir');
    assert.equal(fs.realpathSync(path.dirname(common)), fs.realpathSync(t), 'the clone is its own repo root');
    assert.equal(prepareTree(dir, 'iso', 'HEAD', { isolated: true }), t, 're-preparing replaces it cleanly');
    assert.equal(fs.readFileSync(path.join(t, 'a.txt'), 'utf8'), 'committed\n');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test('prepareTree isolated: a remote-tracking sha in a shallow source repo still checks out', () => {
  const up = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-replay-up-'));
  const sh = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-replay-sh-'));
  try {
    git(up, 'init', '-q', '-b', 'main');
    git(up, 'config', 'user.email', 't@t');
    git(up, 'config', 'user.name', 't');
    for (const n of ['one', 'two']) { fs.writeFileSync(path.join(up, 'a.txt'), `${n}\n`); git(up, 'add', '-A'); git(up, 'commit', '-qm', n); }
    fs.rmSync(sh, { recursive: true, force: true });
    spawnSync('git', ['clone', '-q', '--depth=1', `file://${up}`, sh], { encoding: 'utf8' });
    const sha = git(sh, 'rev-parse', 'origin/main');
    assert.equal(git(sh, 'rev-parse', '--is-shallow-repository'), 'true');
    git(sh, 'config', 'user.email', 't@t');
    git(sh, 'config', 'user.name', 't');
    git(sh, 'checkout', '-q', '--orphan', 'work');
    git(sh, 'commit', '-qm', 'unrelated');
    git(sh, 'branch', '-q', '-D', 'main'); // only the remote-tracking ref holds the sha, as in the cloud checkout
    const t = prepareTree(sh, 'iso', sha, { isolated: true });
    assert.equal(fs.readFileSync(path.join(t, 'a.txt'), 'utf8'), 'two\n');
  } finally {
    fs.rmSync(up, { recursive: true, force: true });
    fs.rmSync(sh, { recursive: true, force: true });
  }
});
