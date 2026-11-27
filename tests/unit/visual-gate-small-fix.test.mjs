// BRO-7298: the visual gate's small-fix lane (owner option A, 2026-11-10) and its screenshot Stop check.
// Pure checks are require()d from scripts/lib/visual-small-fix.mjs (CLAUDE.md 15); the hook cases run the REAL
// .claude/hooks/pre-push-visual-gate.sh against a throwaway repo (same hermetic shape as
// scripts/pre-push-visual-gate.test.mjs), and one red case strips the lane block to prove the cases depend on it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { spawnSyncStdinFile } from '../helpers/spawn-stdin-file.mjs';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync, realpathSync, appendFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseMarker, pushSource, pageProblem, headlessProblem, ownerQuoteProblem, diffSize, decide, claimsClosing,
  screenshotSentSince, stopDecision, enforcementProblem, reuseProblem, MAX_LINES, STOP_BLOCK_BUDGET,
} from '../../scripts/lib/visual-small-fix.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOK = join(REPO_ROOT, '.claude', 'hooks', 'pre-push-visual-gate.sh');
const SETTINGS = join(REPO_ROOT, '.claude', 'settings.json');
// The Stop check runs at the top of verify-edits.sh, before its Mac self-skip (no new hook file: the budget is capped).
const VERIFY_EDITS = join(REPO_ROOT, '.claude', 'hooks', 'verify-edits.sh');
const OWNER = 'The score badge text is too small on show pages, please make it a little bigger';
const QUOTE = 'please make it a little bigger';
const PAGE = 'https://broadwayscorecard.com/shows/hamilton';
const owner = (text, extra = {}) => ({ kind: 'user_text', text, synthetic: false, ts: '2026-11-27T00:00:00Z', ...extra });

// ── pure checks ────────────────────────────────────────────────────────────────
test('parseMarker reads the shell comment only', () => {
  assert.deepEqual(parseMarker(`git push origin HEAD:refs/heads/land/x  # SMALL-FIX: page=${PAGE} owner="${QUOTE}"`), { page: PAGE, quote: QUOTE });
  assert.equal(parseMarker('git push origin main'), null);
  assert.equal(parseMarker('git push origin main #SMALL-FIX page=x'), null);
  assert.equal(parseMarker(`cat <<EOF\n# SMALL-FIX: page=${PAGE} owner="${QUOTE}"\nEOF\ngit push origin main`), null, 'one line only');
});

test('pushSource: one plain push, source side of a refspec, nothing chained', () => {
  const m = `  # SMALL-FIX: page=${PAGE} owner="${QUOTE}"`;
  assert.equal(pushSource(`git push origin feat-ui${m}`), 'feat-ui');
  assert.equal(pushSource(`git push -u origin big:refs/heads/land/x${m}`), 'big', 'sizes what is pushed, not HEAD');
  assert.equal(pushSource(`git push origin small && git push origin big${m}`), null);
  assert.equal(pushSource(`git push origin a; git push origin b${m}`), null);
  assert.equal(pushSource(`git push origin $(git branch --show-current)${m}`), null);
  assert.equal(pushSource(`git push --force origin a${m}`), null);
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
  assert.match(ownerQuoteProblem([owner('hi'), { kind: 'tool_result', content: OWNER }, { kind: 'assistant_text', text: OWNER }], QUOTE), /not in the owner's latest message/);
  // Only the owner's latest message: an old request (or one they took back) cannot be reused.
  assert.match(ownerQuoteProblem([owner(OWNER), owner('wait, do not change that')], QUOTE), /latest message/);
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
  const ok = { marker, source: 'feat', events: [owner(OWNER)], size, env, cwd: '/r', patchId: 'p1' };
  assert.equal(decide(ok).allowed, true);
  assert.equal(decide({ ...ok, env: { ...env, VISUAL_SMALL_FIX_DISABLED: '1' } }).allowed, false);
  assert.equal(decide({ ...ok, marker: null }).allowed, false);
  assert.equal(decide({ ...ok, source: null }).allowed, false);
  assert.equal(decide({ ...ok, enforcement: 'no stop check' }).allowed, false);
  assert.equal(decide({ ...ok, size: { files: 2, lines: 90, problem: 'big' } }).allowed, false);
  // One request, one change: a retry of the same patch passes, a different patch does not.
  const key = decide(ok).ownerKey;
  assert.equal(decide({ ...ok, obligation: { pushes: [{ ownerKey: key, patchId: 'p1' }] } }).allowed, true);
  assert.match(decide({ ...ok, obligation: { pushes: [{ ownerKey: key, patchId: 'p0' }] } }).reason, /already shipped a different change/);
  assert.equal(reuseProblem(null, key, 'p1'), null);
});

test('enforcementProblem: the session must run the Stop check', () => {
  const files = (map) => (f) => { for (const [k, v] of Object.entries(map)) if (f.endsWith(k)) return v; throw new Error('ENOENT'); };
  const settings = JSON.stringify({ hooks: { Stop: [{ hooks: [{ command: 'bash "$R/.claude/hooks/verify-edits.sh"' }] }] } });
  const good = { 'settings.json': settings, 'verify-edits.sh': 'node "$_vsf" --stop-hook ... visual-small-fix.mjs" --stop-hook' };
  assert.equal(enforcementProblem({ projectDir: '/p', read: files(good) }), null);
  assert.equal(enforcementProblem({ projectDir: '/p', read: files({ 'settings.json': readFileSync(SETTINGS, 'utf8'), 'verify-edits.sh': readFileSync(VERIFY_EDITS, 'utf8') }) }), null, 'this checkout passes');
  assert.match(enforcementProblem({ projectDir: '/p', read: files({ ...good, 'settings.json': '{}' }) }), /does not run the screenshot Stop check/);
  assert.match(enforcementProblem({ projectDir: '/p', read: files({ ...good, 'settings.json': 'not json' }) }), /does not run the screenshot Stop check/);
  assert.match(enforcementProblem({ projectDir: '/p', read: files({ ...good, 'verify-edits.sh': 'old' }) }), /Stop check/);
});

test('claimsClosing: cloud, Mac and machine verdicts; not a mid-session update', () => {
  assert.equal(claimsClosing('Done.\nSAFE TO ARCHIVE — all landed'), true);
  assert.equal(claimsClosing('Fixed it.\nYou can close this tab.'), true);
  assert.equal(claimsClosing('x\nNothing is running here; keep this tab only if you want to continue the badge.'), true);
  assert.equal(claimsClosing('DONE x\nTHIS SESSION: CLOSE ME — done'), true);
  assert.equal(claimsClosing('Pushed. Waiting for the deploy.\nKeep this tab open.'), false);
  assert.equal(claimsClosing('```\nSAFE TO ARCHIVE\n```\nstill working'), false);
  assert.equal(claimsClosing('SAFE TO ARCHIVE — done\n\nDeployed: https://broadwayscorecard.com/'), true, 'a line under the verdict does not hide it');
});

test('screenshotSentSince / stopDecision', () => {
  const ob = { pushes: [{ page: PAGE, pushedAt: '2026-11-27T10:00:00Z' }], blocks: 0 };
  const after = Date.parse('2026-11-27T10:04:00Z');
  const mtime = (f) => (f.includes('old') ? Date.parse('2026-11-01T00:00:00Z') : f.includes('missing') ? null : after);
  let n = 0;
  const shot = (ts, files = ['/Users/x/Documents/claude-outputs/badge-390.png'], { isError = false, result = true } = {}) => {
    const id = `t${++n}`;
    return [{ kind: 'assistant_tool_use', name: 'SendUserFile', input: { files }, ts, id }, ...(result ? [{ kind: 'tool_result', tool_use_id: id, isError, content: 'sent' }] : [])];
  };
  const closing = 'Bigger badge is live.\nYou can close this tab.';
  const sd = (events, o = {}) => stopDecision({ events, lastMessage: closing, obligation: ob, env: {}, mtime, ...o }).block;
  assert.equal(sd([]), true);
  assert.equal(sd(shot('2026-11-27T10:05:00Z')), false);
  assert.equal(sd(shot('2026-11-27T09:59:00Z')), true, 'a send from before the push is not of the fix');
  assert.equal(sd(shot('2026-11-27T10:05:00Z', ['/x/report.md'])), true, 'must be an image');
  assert.equal(sd(shot('2026-11-27T10:05:00Z', undefined, { isError: true })), true, 'a failed send does not count');
  assert.equal(sd(shot('2026-11-27T10:05:00Z', undefined, { result: false })), true, 'a send with no result does not count');
  assert.equal(sd(shot('2026-11-27T10:05:00Z', ['/x/old-shot.png'])), true, 'an image written before the push does not count');
  assert.equal(sd(shot('2026-11-27T10:05:00Z', ['/x/missing.png'])), true, 'a file that does not exist does not count');
  assert.equal(sd([], { lastMessage: 'Deploying now.\nKeep this tab open.' }), false);
  assert.equal(sd([], { obligation: { ...ob, waived: { reason: 'r' } } }), false);
  assert.equal(sd([], { obligation: { ...ob, blocks: STOP_BLOCK_BUDGET } }), false, 'budget caps the loop');
  assert.equal(sd([], { env: { VISUAL_SMALL_FIX_STOP_DISABLED: '1' } }), false);
  assert.equal(sd([], { env: { VISUAL_SMALL_FIX_DISABLED: '1' } }), true, 'closing the lane does not forgive a debt already owed');
  assert.equal(screenshotSentSince(shot('2026-11-27T10:05:00Z'), '2026-11-27T10:00:00Z', { mtime }), '/Users/x/Documents/claude-outputs/badge-390.png');
  const seen = [];
  screenshotSentSince(shot('2026-11-27T10:05:00Z', ['~/Documents/claude-outputs/b.png']), '2026-11-27T10:00:00Z', { mtime: (f) => { seen.push(f); return after; } });
  assert.equal(seen[0], join(homedir(), 'Documents/claude-outputs/b.png'), '~/ paths are expanded');
});

// ── the real hook ──────────────────────────────────────────────────────────────
function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: cleanEnv({ GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }), stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function cleanEnv(extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith('GIT_') || k.startsWith('VISUAL_') || k === 'CLAUDE_CODE_REMOTE' || k === 'CLAUDE_PROJECT_DIR') continue;
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

function fixture(t, { uiLines = 3, stopWired = true } = {}) {
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
  if (stopWired) { // this session's checkout runs the Stop check (enforcementProblem reads these)
    mkdirSync(join(repo, '.claude', 'hooks'), { recursive: true });
    writeFileSync(join(repo, '.claude', 'settings.json'), readFileSync(SETTINGS));
    writeFileSync(join(repo, '.claude', 'hooks', 'verify-edits.sh'), readFileSync(VERIFY_EDITS));
  }
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
  const r = spawnSyncStdinFile('bash', [hook], {
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
  assert.match(r.stderr, /Small-fix lane refused: owner="\.\.\." is not in the owner's latest message/);
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

test('hook: a refspec push is sized on its source, not HEAD (big branch, small HEAD)', (t) => {
  const fx = fixture(t);
  git(fx.repo, 'checkout', '-q', '-b', 'big');
  commitFile(fx.repo, 'src/components/Big.tsx', `${Array.from({ length: MAX_LINES + 5 }, (_, i) => `export const B${i} = 1;`).join('\n')}\n`, 'ui: big');
  git(fx.repo, 'checkout', '-q', 'feat-ui');
  const r = push(fx, transcript(fx, OWNER), { command: `git push origin big:refs/heads/land/x  # SMALL-FIX: page=${PAGE} owner="${QUOTE}"` });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /Small-fix lane refused: \d+ UI lines changed/);
});

test('hook: a chained second push is refused', (t) => {
  const fx = fixture(t);
  const r = push(fx, transcript(fx, OWNER), { command: `git push origin feat-ui && git push origin main  # SMALL-FIX: page=${PAGE} owner="${QUOTE}"` });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /Small-fix lane refused: the push command must be ONE plain/);
});

test('hook: a checkout whose settings do not run the Stop check is refused', (t) => {
  const fx = fixture(t, { stopWired: false });
  const r = push(fx, transcript(fx, OWNER));
  assert.equal(r.status, 2);
  assert.match(r.stderr, /does not run the screenshot Stop check/);
});

test('hook: one owner request ships one change (a retry passes, a new change does not)', (t) => {
  const fx = fixture(t);
  const tp = transcript(fx, OWNER);
  assert.equal(push(fx, tp).status, 0);
  assert.equal(push(fx, tp).status, 0, 'retrying the same change is fine');
  commitFile(fx.repo, 'src/components/Other.tsx', 'export const O = 1;\n', 'ui: another change');
  const r = push(fx, tp);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /already shipped a different change/);
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
  const macHome = join(fx.root, 'machome');
  mkdirSync(join(macHome, '.claude', 'hooks'), { recursive: true });
  writeFileSync(join(macHome, '.claude', 'hooks', 'verify-edits.sh'), '#!/usr/bin/env bash\nexit 0\n');
  const stop = (last, rows = []) => {
    writeFileSync(tp, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
    // HOME holds a stand-in master verify-edits.sh, exactly the Mac shape: the block runs, then the self-skip exits 0.
    return spawnSyncStdinFile('bash', [VERIFY_EDITS], { encoding: 'utf8', env: env(fx, { HOME: macHome }), input: JSON.stringify({ session_id: 'sess-small-fix', transcript_path: tp, last_assistant_message: last, stop_hook_active: false }) });
  };
  const closing = 'The badge is bigger now.\nYou can close this tab.';
  const r1 = stop(closing);
  assert.equal(r1.status, 2, r1.stderr);
  assert.match(r1.stderr, /owe them a screenshot of the live page/);
  assert.equal(stop('Waiting for the deploy.\nKeep this tab open.').status, 0, 'a mid-session message is not refused');
  const png = join(fx.root, 'badge-390.png');
  writeFileSync(png, 'not really a png');
  const sentAt = new Date(Date.now() + 1000).toISOString();
  const sent = { type: 'assistant', timestamp: sentAt, message: { id: 'm9', role: 'assistant', content: [{ type: 'tool_use', id: 'tu9', name: 'SendUserFile', input: { files: [png], display: 'render' } }] } };
  const ok = { type: 'user', timestamp: sentAt, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu9', content: 'File sent' }] } };
  assert.equal(stop(closing, [sent]).status, 2, 'a send with no successful result does not pay the debt');
  assert.equal(stop(closing, [sent, ok]).status, 0);
  // Budget: after STOP_BLOCK_BUDGET refusals (two so far) it lets the session go (never an endless loop).
  assert.equal(STOP_BLOCK_BUDGET, 2);
  assert.equal(stop(closing).status, 0);
  // Kill switch silences it.
  const off = spawnSyncStdinFile('bash', [VERIFY_EDITS], { encoding: 'utf8', env: env(fx, { HOME: macHome, VISUAL_SMALL_FIX_STOP_DISABLED: '1' }), input: '{}' });
  assert.equal(off.status, 0);
});

test('wiring: verify-edits.sh is the registered Stop hook and runs the check before its Mac self-skip', () => {
  const settings = JSON.parse(readFileSync(join(REPO_ROOT, '.claude', 'settings.json'), 'utf8'));
  const stops = settings.hooks.Stop.flatMap((g) => g.hooks.map((h) => h.command));
  assert.ok(stops.some((c) => c.includes('verify-edits.sh')), 'verify-edits.sh is not a registered Stop hook');
  const ve = readFileSync(VERIFY_EDITS, 'utf8');
  const call = ve.indexOf('node "$_vsf" --stop-hook');
  assert.ok(ve.includes('scripts/lib/visual-small-fix.mjs') && call > 0 && call < ve.indexOf('# Self-skip if the user-level master'), 'the check must run before the Mac self-skip');
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
