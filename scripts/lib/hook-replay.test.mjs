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
  for (const f of ['land-preflight.mjs', 'content-quality.js', 'review-guards.js', 'wait-for-land.js', 'linear-client.js']) {
    assert.ok(!s.libs.includes(`scripts/lib/${f}`), `${f} is not code the Stop hook runs at load (PreToolUse-only, a watched path, message text or a lazy Linear call)`);
  }
  assert.ok(s.libs.length < 30, `scope grew to ${s.libs.length} files; a lazy or Linear-side import is probably being followed`);
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
