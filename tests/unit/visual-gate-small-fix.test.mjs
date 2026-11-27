// BRO-7298: the visual gate's small-fix lane (owner option A, 2026-11-10) and its screenshot Stop check.
// Pure checks are require()d from scripts/lib/visual-small-fix.mjs (CLAUDE.md 15); the hook cases run the REAL
// .claude/hooks/pre-push-visual-gate.sh against a throwaway repo (same hermetic shape as
// scripts/pre-push-visual-gate.test.mjs), and one red case strips the lane block to prove the cases depend on it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync, realpathSync, appendFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseMarker, pageProblem, headlessProblem, ownerQuoteProblem, diffSize, decide, claimsClosing,
  screenshotSentSince, stopDecision, MAX_LINES, STOP_BLOCK_BUDGET,
} from '../../scripts/lib/visual-small-fix.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOK = join(REPO_ROOT, '.claude', 'hooks', 'pre-push-visual-gate.sh');
const STOP_HOOK = join(REPO_ROOT, '.claude', 'hooks', 'visual-small-fix-stop.sh');
const OWNER = 'The score badge text is too small on show pages, please make it a little bigger';
const QUOTE = 'please make it a little bigger';
const PAGE = 'https://broadwayscorecard.com/shows/hamilton';
const owner = (text, extra = {}) => ({ kind: 'user_text', text, synthetic: false, ts: '2026-11-27T00:00:00Z', ...extra });

// ── pure checks ────────────────────────────────────────────────────────────────
test('parseMarker reads the shell comment only', () => {
  assert.deepEqual(parseMarker(`git push origin HEAD:refs/heads/land/x  # SMALL-FIX: page=${PAGE} owner="${QUOTE}"`), { page: PAGE, quote: QUOTE });
  assert.equal(parseMarker('git push origin main'), null);
  assert.equal(parseMarker('git push origin main #SMALL-FIX page=x'), null);
});

test('pageProblem: exact broadwayscorecard.com host over https', () => {
  assert.equal(pageProblem(PAGE), null);
  assert.equal(pageProblem('https://www.broadwayscorecard.com/'), null);
  assert.match(pageProblem('https://broadwayscorecard.com.evil.com/x'), /must be on broadwayscorecard\.com/);
  assert.match(pageProblem('https://u:p@broadwayscorecard.com/x'), /user name/);
  assert.match(pageProblem('http://broadwayscorecard.com/x'), /https/);
  assert.match(pageProblem('not a url'), /not a URL/);
});

test('headlessProblem refuses SDK/headless sessions and job worktrees', () => {
  assert.match(headlessProblem({ env: { CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' }, cwd: '/x' }), /headless/);
  assert.match(headlessProblem({ env: { CLAUDE_CODE_ENTRYPOINT: 'cli' }, cwd: '/Users/a/Broadwayscore/.claude/worktrees/job-linear-BRO-1-abc' }), /job worktree/);
  assert.equal(headlessProblem({ env: { CLAUDE_CODE_ENTRYPOINT: 'cli' }, cwd: '/Users/a/Broadwayscore/.claude/worktrees/feature' }), null);
});

test('ownerQuoteProblem: only the owner\'s own recent words count', () => {
  assert.equal(ownerQuoteProblem([owner(OWNER)], QUOTE), null);
  assert.equal(ownerQuoteProblem([owner(OWNER.replace(/ /g, '\n  '))], QUOTE.toUpperCase()), null, 'case and whitespace are ignored');
  assert.match(ownerQuoteProblem([owner(OWNER)], 'bigger'), /too short/);
  // Synthetic records (hook feedback, notifications, compaction) and tool output never count.
  assert.match(ownerQuoteProblem([owner(OWNER, { synthetic: true })], QUOTE), /no message from the owner/);
  assert.match(ownerQuoteProblem([owner('hi'), { kind: 'tool_result', content: OWNER }, { kind: 'assistant_text', text: OWNER }], QUOTE), /not in the owner's last/);
  // Only the last 3 owner messages: an old request cannot be reused for a later push.
  assert.match(ownerQuoteProblem([owner(OWNER), owner('ok'), owner('next thing'), owner('and another')], QUOTE), /not in the owner's last 3/);
});

test('diffSize: files, lines, binary, limits', () => {
  assert.deepEqual(diffSize('3\t1\tsrc/a.tsx\n'), { files: 1, lines: 4, problem: null });
  assert.match(diffSize('-\t-\tsrc/logo.css\n').problem, /binary/);
  assert.match(diffSize(`${MAX_LINES}\t1\tsrc/a.tsx\n`).problem, /UI lines changed/);
  assert.match(diffSize('1\t0\ta.tsx\n1\t0\tb.tsx\n1\t0\tc.tsx\n1\t0\td.tsx\n').problem, /4 UI files/);
  assert.match(diffSize('').problem, /no UI lines/);
});

test('decide: kill switch and every condition', () => {
  const marker = { page: PAGE, quote: QUOTE };
  const size = { files: 1, lines: 4, problem: null };
  const env = { CLAUDE_CODE_ENTRYPOINT: 'cli' };
  assert.equal(decide({ marker, events: [owner(OWNER)], size, env, cwd: '/r' }).allowed, true);
  assert.equal(decide({ marker, events: [owner(OWNER)], size, env: { ...env, VISUAL_SMALL_FIX_DISABLED: '1' }, cwd: '/r' }).allowed, false);
  assert.equal(decide({ marker: null, events: [owner(OWNER)], size, env, cwd: '/r' }).allowed, false);
  assert.equal(decide({ marker, events: [owner(OWNER)], size: { files: 2, lines: 90, problem: 'big' }, env, cwd: '/r' }).allowed, false);
});

test('claimsClosing: cloud, Mac and machine verdicts; not a mid-session update', () => {
  assert.equal(claimsClosing('Done.\nSAFE TO ARCHIVE — all landed'), true);
  assert.equal(claimsClosing('Fixed it.\nYou can close this tab.'), true);
  assert.equal(claimsClosing('x\nNothing is running here; keep this tab only if you want to continue the badge.'), true);
  assert.equal(claimsClosing('DONE x\nTHIS SESSION: CLOSE ME — done'), true);
  assert.equal(claimsClosing('Pushed. Waiting for the deploy.\nKeep this tab open.'), false);
  assert.equal(claimsClosing('```\nSAFE TO ARCHIVE\n```\nstill working'), false);
});

test('screenshotSentSince / stopDecision', () => {
  const ob = { pushes: [{ page: PAGE, pushedAt: '2026-11-27T10:00:00Z' }], blocks: 0 };
  const shot = (ts, files = ['/Users/x/Documents/claude-outputs/badge-390.png']) => ({ kind: 'assistant_tool_use', name: 'SendUserFile', input: { files }, ts });
  const closing = 'Bigger badge is live.\nYou can close this tab.';
  assert.equal(stopDecision({ events: [], lastMessage: closing, obligation: ob, env: {} }).block, true);
  assert.equal(stopDecision({ events: [shot('2026-11-27T10:05:00Z')], lastMessage: closing, obligation: ob, env: {} }).block, false);
  assert.equal(stopDecision({ events: [shot('2026-11-27T09:59:00Z')], lastMessage: closing, obligation: ob, env: {} }).block, true, 'a shot from before the push is not of the fix');
  assert.equal(stopDecision({ events: [shot('2026-11-27T10:05:00Z', ['/x/report.md'])], lastMessage: closing, obligation: ob, env: {} }).block, true, 'must be an image');
  assert.equal(stopDecision({ events: [], lastMessage: 'Deploying now.\nKeep this tab open.', obligation: ob, env: {} }).block, false);
  assert.equal(stopDecision({ events: [], lastMessage: closing, obligation: { ...ob, waived: { reason: 'r' } }, env: {} }).block, false);
  assert.equal(stopDecision({ events: [], lastMessage: closing, obligation: { ...ob, blocks: STOP_BLOCK_BUDGET }, env: {} }).block, false, 'budget caps the loop');
  assert.equal(stopDecision({ events: [], lastMessage: closing, obligation: ob, env: { VISUAL_SMALL_FIX_DISABLED: '1' } }).block, false);
  assert.equal(screenshotSentSince([shot('2026-11-27T10:05:00Z')], '2026-11-27T10:00:00Z'), '/Users/x/Documents/claude-outputs/badge-390.png');
});

// ── the real hook ──────────────────────────────────────────────────────────────
function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: cleanEnv({ GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }), stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function cleanEnv(extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith('GIT_') || k.startsWith('VISUAL_') || k === 'CLAUDE_CODE_REMOTE') continue;
    env[k] = v;
  }
  return { ...env, ...extra };
}
function commitFile(repo, rel, body, msg) {
  mkdirSync(join(repo, dirname(rel)), { recursive: true });
  writeFileSync(join(repo, rel), body);
  git(repo, 'add', '--', rel);
  git(repo, 'commit', '-q', '-m', msg);
}

function fixture(t, { uiLines = 3 } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'visual-small-fix-')));
  t.after(() => { try { rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); } catch { /* best effort */ } });
  const repo = join(root, 'repo'); const origin = join(root, 'origin.git');
  const fx = { root, repo, home: join(root, 'home'), logs: join(root, 'logs'), state: join(root, 'state'), tmp: join(root, 'tmp') };
  for (const d of [repo, fx.home, fx.logs, fx.tmp]) mkdirSync(d, { recursive: true });
  git(root, 'init', '-q', '--bare', '-b', 'main', origin);
  for (const [k, v] of [['gc.auto', '0'], ['receive.autogc', 'false']]) git(origin, 'config', k, v);
  git(repo, 'init', '-q', '-b', 'main');
  for (const [k, v] of [['user.email', 't@example.com'], ['user.name', 'T'], ['commit.gpgsign', 'false'], ['gc.auto', '0']]) git(repo, 'config', k, v);
  git(repo, 'remote', 'add', 'origin', origin);
  symlinkSync(join(REPO_ROOT, 'scripts'), join(repo, 'scripts'), 'dir');
  appendFileSync(join(repo, '.git', 'info', 'exclude'), '/scripts\n/.claude/\n');
  commitFile(repo, 'README.md', '# f\n', 'base');
  git(repo, 'push', '-q', 'origin', 'main');
  git(repo, 'fetch', '-q', 'origin');
  git(repo, 'checkout', '-q', '-b', 'feat-ui');
  const body = Array.from({ length: uiLines }, (_, i) => `export const Badge${i} = () => <span className="text-lg">{${i}}</span>;`).join('\n');
  commitFile(repo, 'src/components/Badge.tsx', `${body}\n`, 'ui: bigger badge');
  return fx;
}

function transcript(fx, userText, assistantText = 'On it.') {
  const p = join(fx.root, 'transcript.jsonl');
  const rows = [
    { type: 'user', timestamp: '2026-11-27T00:00:00Z', message: { role: 'user', content: [{ type: 'text', text: userText }] } },
    { type: 'assistant', timestamp: '2026-11-27T00:00:01Z', message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: assistantText }, { type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'git push origin feat-ui' } }] } },
  ];
  writeFileSync(p, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return p;
}

function env(fx, extra = {}) {
  return cleanEnv({ HOME: fx.home, CLAUDE_LOG_DIR: fx.logs, TMPDIR: fx.tmp, VISUAL_SMALL_FIX_STATE_DIR: fx.state, CLAUDE_CODE_ENTRYPOINT: 'cli', ...extra });
}

const MARKED = `git push origin feat-ui  # SMALL-FIX: page=${PAGE} owner="${QUOTE}"`;
function push(fx, tp, { command = MARKED, hook = HOOK, extraEnv = {} } = {}) {
  const r = spawnSync('bash', [hook], {
    cwd: fx.repo, encoding: 'utf8', timeout: 90_000, env: env(fx, extraEnv),
    input: JSON.stringify({ tool_input: { command }, session_id: 'sess-small-fix', transcript_path: tp, tool_use_id: 'tu1' }),
  });
  if (r.error) throw r.error;
  return r;
}

test('precondition: jq is installed (the hook fails open without it)', () => {
  assert.equal(spawnSync('sh', ['-c', 'command -v jq']).status, 0, 'install jq: every hook case below would pass vacuously');
});

test('hook: a small fix the owner asked for ships without the yes, and records a screenshot debt', (t) => {
  const fx = fixture(t);
  const r = push(fx, transcript(fx, OWNER));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /small-fix lane/);
  const ob = JSON.parse(readFileSync(join(fx.state, 'sess-small-fix.json'), 'utf8'));
  assert.equal(ob.pushes[0].page, PAGE);
  assert.match(readFileSync(join(fx.logs, 'visual-gate-bypass.log'), 'utf8'), /small-fix-lane/);
  assert.equal(existsSync(join(fx.repo, '.claude', 'visual-qa', 'approvals.jsonl')), false, 'the lane never records a ledger approval');
});

test('hook: words the owner never wrote do not open the lane', (t) => {
  const fx = fixture(t);
  const r = push(fx, transcript(fx, 'what is the weather', `Sure, ${QUOTE}.`));
  assert.equal(r.status, 2);
  assert.match(r.stderr, /Small-fix lane refused: owner="\.\.\." is not in the owner's last/);
  assert.equal(existsSync(join(fx.state, 'sess-small-fix.json')), false);
});

test('hook: a headless session cannot use the lane', (t) => {
  const fx = fixture(t);
  const r = push(fx, transcript(fx, OWNER), { extraEnv: { CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' } });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /Small-fix lane refused: headless session/);
});

test('hook: a big change keeps the pre-push yes', (t) => {
  const fx = fixture(t, { uiLines: MAX_LINES + 5 });
  const r = push(fx, transcript(fx, OWNER));
  assert.equal(r.status, 2);
  assert.match(r.stderr, /Small-fix lane refused: \d+ UI lines changed/);
});

test('hook: an unmarked small push is blocked and told about the lane', (t) => {
  const fx = fixture(t);
  const r = push(fx, transcript(fx, OWNER), { command: 'git push origin feat-ui' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /Small-fix lane \(BRO-7298\): this diff is small \(1 file\(s\), 3 line\(s\)\)/);
});

test('hook: kill switch closes the lane', (t) => {
  const fx = fixture(t);
  const r = push(fx, transcript(fx, OWNER), { extraEnv: { VISUAL_SMALL_FIX_DISABLED: '1' } });
  assert.equal(r.status, 2);
});

test('red case: with the lane block stripped, the same push is blocked', (t) => {
  const fx = fixture(t);
  const src = readFileSync(HOOK, 'utf8');
  const stripped = src.replace(/# >>> BRO-7298 small-fix lane[\s\S]*?# <<< BRO-7298 small-fix lane\n/, '_SMALL_LINE() { :; }\n');
  assert.notEqual(stripped, src, 'lane markers not found in the hook');
  const hook = join(fx.root, 'pre-push-visual-gate.sh');
  writeFileSync(hook, stripped);
  assert.equal(push(fx, transcript(fx, OWNER), { hook }).status, 2);
});

test('Stop hook: refuses the closing until a screenshot was sent, then passes; budget caps it', (t) => {
  const fx = fixture(t);
  assert.equal(push(fx, transcript(fx, OWNER)).status, 0);
  const tp = join(fx.root, 'stop.jsonl');
  const stop = (last, rows = []) => {
    writeFileSync(tp, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
    return spawnSync('bash', [STOP_HOOK], { encoding: 'utf8', env: env(fx), input: JSON.stringify({ session_id: 'sess-small-fix', transcript_path: tp, last_assistant_message: last, stop_hook_active: false }) });
  };
  const closing = 'The badge is bigger now.\nYou can close this tab.';
  const r1 = stop(closing);
  assert.equal(r1.status, 2, r1.stderr);
  assert.match(r1.stderr, /owe them a screenshot of the live page/);
  assert.equal(stop('Waiting for the deploy.\nKeep this tab open.').status, 0, 'a mid-session message is not refused');
  const sent = { type: 'assistant', timestamp: new Date(Date.now() + 1000).toISOString(), message: { id: 'm9', role: 'assistant', content: [{ type: 'tool_use', id: 'tu9', name: 'SendUserFile', input: { files: [join(fx.root, 'badge-390.png')], display: 'render' } }] } };
  assert.equal(stop(closing, [sent]).status, 0);
  // Budget: after STOP_BLOCK_BUDGET refusals it lets the session go (never an endless loop).
  assert.equal(stop(closing).status, 2);
  assert.equal(stop(closing).status, 0);
  // Cloud skips this file (verify-edits.sh runs the same check there).
  const cloud = spawnSync('bash', [STOP_HOOK], { encoding: 'utf8', env: env(fx, { CLAUDE_CODE_REMOTE: 'true' }), input: '{}' });
  assert.equal(cloud.status, 0);
});

test('wiring: Stop hook registered, verify-edits.sh carries the cloud copy', () => {
  const settings = JSON.parse(readFileSync(join(REPO_ROOT, '.claude', 'settings.json'), 'utf8'));
  const stops = settings.hooks.Stop.flatMap((g) => g.hooks.map((h) => h.command));
  assert.ok(stops.some((c) => c.includes('visual-small-fix-stop.sh')), 'visual-small-fix-stop.sh is not a registered Stop hook');
  assert.match(readFileSync(join(REPO_ROOT, '.claude', 'hooks', 'verify-edits.sh'), 'utf8'), /visual-small-fix\.mjs" --stop-hook[\s\S]*VE:SMALLFIXSHOT/);
});

// Cousin (BRO-7298): on the Mac the REGISTERED gate is the user-level master; the repo copy self-skips when it exists.
// The master had silently fallen behind (BRO-7849, BRO-7850, BRO-8156 missing), so a repo-only change never ran there.
// When a master exists it must equal the repo copy minus its self-skip block. Skips where there is no master (CI, cloud).
test('Mac master pre-push-visual-gate.sh matches the repo copy (minus self-skip)', (t) => {
  const master = join(homedir(), '.claude', 'hooks', 'pre-push-visual-gate.sh');
  if (!existsSync(master)) { t.skip('no user-level master on this machine'); return; }
  const expected = readFileSync(HOOK, 'utf8').replace(/# Self-skip if user-level master exists[^\n]*\nif \[ -f "\$HOME\/\.claude\/hooks\/\$\(basename "\$0"\)" \]; then\n  exit 0\nfi\n/, '');
  assert.ok(readFileSync(master, 'utf8') === expected, `~/.claude/hooks/pre-push-visual-gate.sh has drifted from the repo copy (the Mac runs the master, so repo-only gate changes never apply there). Re-sync from an up-to-date main checkout: sed '/^# Self-skip if user-level master exists/,/^fi$/d' .claude/hooks/pre-push-visual-gate.sh > ~/.claude/hooks/pre-push-visual-gate.sh`);
});
