// BRO-4745: decisions of the daily unattended Codex runner (scripts/codex/daily-runner.js).
// Requires the real helpers (CLAUDE.md §15), never a copy.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const r = require('../../scripts/lib/codex-runner.js');
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const AUTH = JSON.stringify({ auth_mode: 'chatgpt', last_refresh: '2026-10-05T22:26:32Z', tokens: { id_token: 'x' } });

test('login store: encrypt/decrypt roundtrip, fresh IV each time', () => {
  const a = r.encryptAuth(AUTH, 'key-material-1');
  const b = r.encryptAuth(AUTH, 'key-material-1');
  assert.notEqual(a, b);
  assert.equal(r.decryptAuth(a, 'key-material-1'), AUTH);
  assert.ok(!a.includes('chatgpt'));
});

test('login store: wrong key, tampered or truncated blob all throw', () => {
  const blob = r.encryptAuth(AUTH, 'key-material-1');
  assert.throws(() => r.decryptAuth(blob, 'key-material-2'));
  const buf = Buffer.from(blob, 'base64'); buf[buf.length - 1] ^= 1;
  assert.throws(() => r.decryptAuth(buf.toString('base64'), 'key-material-1'));
  assert.throws(() => r.decryptAuth('AAAA', 'key-material-1'), /truncated/);
  assert.throws(() => r.encryptAuth(AUTH, ''), /no key material/);
});

test('login store: comment body roundtrips through parseAuthComment', () => {
  const blob = r.encryptAuth(AUTH, 'k');
  const body = r.authCommentBody(blob, r.authLastRefresh(AUTH), '2026-10-06T14:00:00Z');
  assert.deepEqual(r.parseAuthComment(body), { blob, lastRefresh: '2026-10-05T22:26:32Z' });
  assert.equal(r.parseAuthComment('ordinary comment'), null);
  assert.equal(r.parseAuthComment(null), null);
  assert.equal(r.parseAuthComment(r.authCommentBody(blob, '', 'now')).lastRefresh, '');
  assert.equal(r.authLastRefresh('not json'), '');
});

test('syncDirection: newer last_refresh wins (refresh tokens rotate)', () => {
  assert.equal(r.syncDirection('', ''), 'none');
  assert.equal(r.syncDirection('2026-10-06T00:00:00Z', ''), 'save');
  assert.equal(r.syncDirection('', '2026-10-06T00:00:00Z'), 'restore');
  assert.equal(r.syncDirection('2026-10-06T00:00:00Z', '2026-10-06T00:00:00Z'), 'none');
  assert.equal(r.syncDirection('2026-10-07T00:00:00Z', '2026-10-06T00:00:00Z'), 'save');
  assert.equal(r.syncDirection('2026-10-05T00:00:00Z', '2026-10-06T00:00:00Z'), 'restore');
});

test('parseVerdict: last VERDICT line wins, markdown tolerated, missing is NONE', () => {
  assert.equal(r.parseVerdict('blah\nVERDICT: SHIP'), 'SHIP');
  assert.equal(r.parseVerdict('**VERDICT:** SHIP-WITH-FIXES'), 'SHIP-WITH-FIXES');
  assert.equal(r.parseVerdict('VERDICT: REJECT\nlater\nVERDICT: SHIP'), 'SHIP');
  assert.equal(r.parseVerdict('Options: SHIP | SHIP-WITH-FIXES | REJECT'), 'NONE');
  assert.equal(r.parseVerdict(''), 'NONE');
  assert.equal(r.parseVerdict(undefined), 'NONE');
  // Mid-sentence mentions do not count: only a line that starts with VERDICT.
  assert.equal(r.parseVerdict('VERDICT: REJECT\n- after fixing X this would be VERDICT: SHIP'), 'REJECT');
  assert.equal(r.parseVerdict('I would say VERDICT: SHIP if it had tests'), 'NONE');
});

test('latestWeeklyPercent: reads the real Codex rollout rate_limits shape', () => {
  // Shape copied from a real ~/.codex/sessions rollout line (2026-10-06), tokens stripped.
  const line = JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', rate_limits: {
    limit_id: 'codex', primary: { used_percent: 3.0, window_minutes: 10080, resets_at: 1791588501 }, secondary: null, plan_type: 'pro' } } });
  const short = JSON.stringify({ payload: { rate_limits: { primary: { used_percent: 40, window_minutes: 300 }, secondary: { used_percent: 7, window_minutes: 10080 } } } });
  assert.equal(r.latestWeeklyPercent(line), 3);
  assert.equal(r.latestWeeklyPercent(short), 7, 'a 5-hour window is not the weekly one');
  assert.equal(r.latestWeeklyPercent(`${line}\n${short}`), 7, 'latest line wins');
  assert.equal(r.latestWeeklyPercent('{"no":"limits"}\nnot json rate_limits'), null);
});

test('nextStep: only a clean SHIP lands; REJECT gets one fix round, SHIP-WITH-FIXES two', () => {
  assert.equal(r.nextStep({ verdict: 'SHIP', hasDiff: true, attempt: 1 }), 'land');
  assert.equal(r.nextStep({ verdict: 'SHIP', hasDiff: false, attempt: 1 }), 'close-already-fixed');
  assert.equal(r.nextStep({ verdict: 'SHIP-WITH-FIXES', hasDiff: true, attempt: 1 }), 'fix-round');
  assert.equal(r.nextStep({ verdict: 'SHIP-WITH-FIXES', hasDiff: true, attempt: 2 }), 'fix-round');
  assert.equal(r.nextStep({ verdict: 'SHIP-WITH-FIXES', hasDiff: true, attempt: 3 }), 'bounce');
  assert.equal(r.nextStep({ verdict: 'NONE', hasDiff: true, attempt: 1 }), 'fix-round');
  assert.equal(r.nextStep({ verdict: 'REJECT', hasDiff: true, attempt: 2 }), 'bounce');
  assert.equal(r.nextStep({ verdict: 'SHIP', hasDiff: true, attempt: 2 }), 'land');
});

test('nextStep: a no-diff run the environment blocked retries once without using a round', () => {
  assert.equal(r.nextStep({ verdict: 'REJECT', hasDiff: false, attempt: 1, envBlocked: true }), 'env-retry');
  assert.equal(r.nextStep({ verdict: 'REJECT', hasDiff: false, attempt: 2, envBlocked: true }), 'env-retry');
  assert.equal(r.nextStep({ verdict: 'REJECT', hasDiff: false, attempt: 1, envBlocked: true, envRetryUsed: true }), 'fix-round');
  assert.equal(r.nextStep({ verdict: 'REJECT', hasDiff: false, attempt: 2, envBlocked: true, envRetryUsed: true }), 'bounce');
  // A diff means Codex was not blocked; a SHIP needs no retry.
  assert.equal(r.nextStep({ verdict: 'REJECT', hasDiff: true, attempt: 2, envBlocked: true }), 'bounce');
  assert.equal(r.nextStep({ verdict: 'SHIP', hasDiff: false, attempt: 1, envBlocked: true }), 'close-already-fixed');
});

test('parseEnvBlocked / parseRemaining: line-anchored, "none" means nothing', () => {
  assert.equal(r.parseEnvBlocked('report\nENVIRONMENT-BLOCKED: sandbox denied read of data/review-texts\n'), 'sandbox denied read of data/review-texts');
  assert.equal(r.parseEnvBlocked('**ENVIRONMENT-BLOCKED:** none'), null);
  assert.equal(r.parseEnvBlocked('I was not ENVIRONMENT-BLOCKED: at all, mid-sentence'), null);
  assert.equal(r.parseEnvBlocked(''), null);
  assert.deepEqual(r.parseRemaining('VERDICT: SHIP\nREMAINING: backfill 12 review files (needs the private repo)\n- REMAINING: rerun the audit'), ['backfill 12 review files (needs the private repo)', 'rerun the audit']);
  assert.deepEqual(r.parseRemaining('VERDICT: SHIP\nREMAINING: none'), []);
  assert.deepEqual(r.parseRemaining('nothing remaining: here'), []);
});

test('landingIsPartial: a partial note since the claim, never an older one', () => {
  const since = Date.parse('2026-10-09T10:00:00Z');
  const partial = { body: `## Codex runner: landing a partial fix\n\n${r.PARTIAL_MARKER}`, createdAt: '2026-10-09T11:00:00Z' };
  const old = { ...partial, createdAt: '2026-10-01T11:00:00Z' };
  assert.equal(r.landingIsPartial([partial], since), true);
  assert.equal(r.landingIsPartial([old], since), false);
  assert.equal(r.landingIsPartial([partial], NaN), false);
  assert.equal(r.landingIsPartial([{ body: '## Codex runner: landed', createdAt: '2026-10-09T11:00:00Z' }], since), false);
});

test('data allow-list: core files and review-texts only; credentialed clones are refused', () => {
  assert.ok(r.DATA_FILES.includes('shows.json') && r.DATA_FILES.includes('reviews.json'));
  for (const bad of ['subscribers.json', 'followers.json', 'finances', 'aggregator-archive', 'audit']) {
    assert.ok(!r.DATA_FILES.includes(bad) && !r.DATA_DIRS.includes(bad), bad);
  }
  assert.deepEqual(r.DATA_DIRS, ['review-texts']);
  assert.equal(r.hasCredentialRemote('[remote "origin"]\n\turl = https://x-access-token:ghp_abc@github.com/o/r.git'), true);
  assert.equal(r.hasCredentialRemote('[remote "origin"]\n\turl = https://github.com/o/r.git'), false);
  assert.equal(r.hasCredentialRemote('[remote "origin"]\n\turl = git@github.com:o/r.git'), false);
  // Every allow-listed file is gitignored, so a provided copy can never be committed.
  const ign = spawnSync('git', ['check-ignore', '--no-index', ...r.DATA_FILES.map((f) => `data/${f}`), 'data/review-texts'], { cwd: ROOT, encoding: 'utf8' });
  assert.deepEqual(ign.stdout.split('\n').filter(Boolean).sort(), [...r.DATA_FILES.map((f) => `data/${f}`), 'data/review-texts'].sort());
});

test('land-gauntlet GAUNTLET_GATES: unset runs every gate, a list runs exactly those', () => {
  const fn = readFileSync(join(ROOT, 'scripts/lib/land-gauntlet.sh'), 'utf8').split('\n').find((l) => l.startsWith('want_gate()'));
  assert.ok(fn, 'want_gate() is defined on one line in land-gauntlet.sh');
  const probe = (env) => spawnSync('bash', ['-c', `${fn}\nfor g in tsc unit-tests-node lint-workflows lint; do want_gate "$g" && echo "$g"; done`], { encoding: 'utf8', env: { PATH: process.env.PATH, ...env } }).stdout.trim().split('\n');
  assert.deepEqual(probe({}), ['tsc', 'unit-tests-node', 'lint-workflows', 'lint']);
  assert.deepEqual(probe({ GAUNTLET_GATES: 'lint-workflows' }), ['lint-workflows']);
  assert.deepEqual(probe({ GAUNTLET_GATES: 'tsc,unit-tests-node' }), ['tsc', 'unit-tests-node']);
});

test('looksLikeSecretLeak: added token lines block, removed lines and prose do not', () => {
  assert.equal(r.looksLikeSecretLeak('+  "refresh_token": "abc"'), true);
  assert.equal(r.looksLikeSecretLeak('+const k = "sk-proj-abcdefghijklmnopqrstuvwxyz"'), true);
  assert.equal(r.looksLikeSecretLeak('+x = "lin_api_abcdefghijklmnopqrstuvwxyz12"'), true);
  assert.equal(r.looksLikeSecretLeak(`+t="eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI"`), true);
  assert.equal(r.looksLikeSecretLeak('-  "refresh_token": "abc"'), false);
  assert.equal(r.looksLikeSecretLeak('+// refresh tokens rotate, so save the newest file'), false);
  assert.equal(r.looksLikeSecretLeak('+++ b/"refresh_token":'), false);
});

test('fillPrompt fills every placeholder, repeatedly, and never expands one inside a value', () => {
  const out = r.fillPrompt('{{ID}} {{TITLE}}\n{{BODY}}\n{{EXTRA}} {{ID}}', { id: 'BRO-1', title: 'T', body: 'B' });
  assert.equal(out, 'BRO-1 T\nB\n BRO-1');
  assert.equal(r.fillPrompt('{{DATA}}|{{WORKTREE}}|{{BODY}}', { id: 'x', data: 'D', worktree: '/wt', body: 'card says {{EXTRA}}' }), 'D|/wt|card says {{EXTRA}}');
  // The real prompts carry no placeholder the runner does not fill.
  for (const f of ['scripts/codex/runner-prompt.md', 'scripts/codex/check-prompt.md']) {
    const left = r.fillPrompt(readFileSync(join(ROOT, f), 'utf8'), { id: 'BRO-1', title: 't', body: 'b', extra: 'e', data: 'd', worktree: '/w' });
    assert.doesNotMatch(left, /\{\{[A-Z]+\}\}/, f);
  }
});

test('stopReason: time, weekly cap, reject streak, Done refusal', () => {
  const base = { startedMs: 0, nowMs: 60_000, maxMinutes: 300, weeklyPct: 10, maxWeeklyPct: 60, rejectStreak: 0, doneRefusals: 0 };
  assert.equal(r.stopReason(base), null);
  assert.match(r.stopReason({ ...base, nowMs: 301 * 60_000 }), /time budget/);
  assert.match(r.stopReason({ ...base, weeklyPct: 60 }), /weekly allowance/);
  assert.equal(r.stopReason({ ...base, weeklyPct: null }), null);
  assert.match(r.stopReason({ ...base, rejectStreak: 3 }), /REJECT/);
  assert.match(r.stopReason({ ...base, doneRefusals: 1 }), /Done gate/);
});

test('codexBouncedRecently: only the runner marker, only for 14 days', () => {
  const now = Date.parse('2026-10-20T00:00:00Z');
  const c = (body, at) => ({ body, createdAt: at });
  assert.equal(r.codexBouncedRecently([c(`${r.BOUNCED_MARKER}\nfindings`, '2026-10-10T00:00:00Z')], now), true);
  assert.equal(r.codexBouncedRecently([c(`${r.BOUNCED_MARKER}\nold`, '2026-10-01T00:00:00Z')], now), false);
  assert.equal(r.codexBouncedRecently([c('a human mentions codex-runner-bounced', '2026-10-19T00:00:00Z')], now), false);
  assert.equal(r.codexBouncedRecently(undefined, now), false);
});

test('scrubEnv: drops secrets, keeps git env config whole, Claude auth only for the reviewer', () => {
  const env = {
    OPENAI_API_KEY: 'x', LINEAR_API_KEY: 'x', GITHUB_TOKEN: 'x', SESSION_COOKIE: 'x', DISCORD_WEBHOOK_ALERTS: 'x', GIT_ASKPASS: 'x',
    CLAUDE_CODE_OAUTH_TOKEN: 'reviewer-only', CLAUDE_CODE_REMOTE: 'true', ANTHROPIC_BASE_URL: 'keep', PATH: '/bin',
    GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'url.https://github.com/.insteadOf', GIT_CONFIG_VALUE_0: 'git@github.com:',
  };
  const codex = r.scrubEnv(env);
  const reviewer = r.scrubEnv(env, { reviewer: true });
  for (const out of [codex, reviewer]) {
    for (const k of ['OPENAI_API_KEY', 'LINEAR_API_KEY', 'GITHUB_TOKEN', 'SESSION_COOKIE', 'DISCORD_WEBHOOK_ALERTS', 'GIT_ASKPASS']) assert.ok(!(k in out), k);
    assert.equal(out.PATH, '/bin');
    assert.equal(out.GIT_CONFIG_KEY_0, 'url.https://github.com/.insteadOf'); // the proxy rewrite survives
    // Every GIT_CONFIG_KEY_n the count promises must exist, or git refuses to run.
    for (let i = 0; i < Number(out.GIT_CONFIG_COUNT); i++) assert.ok(`GIT_CONFIG_KEY_${i}` in out && `GIT_CONFIG_VALUE_${i}` in out);
    // Pushes to github are rewritten to nowhere.
    const pushRewrites = Object.keys(out).filter((k) => /^GIT_CONFIG_KEY_/.test(k) && /pushInsteadOf$/.test(out[k])).map((k) => out[k.replace('KEY', 'VALUE')]);
    assert.ok(pushRewrites.includes('https://github.com/') && pushRewrites.includes('git@github.com:'));
  }
  assert.ok(!('CLAUDE_CODE_OAUTH_TOKEN' in codex));
  assert.equal(codex.CLAUDE_CODE_REMOTE, 'true');
  assert.equal(reviewer.CLAUDE_CODE_OAUTH_TOKEN, 'reviewer-only');
});

test('redactSecrets: env secret values and token shapes never reach a comment', () => {
  const env = { LINEAR_API_KEY: 'lin_api_abcdefghijklmnopqrstuvwxyz', OPENAI_API_KEY: 'plainsecretvalue123', SHORT_TOKEN: 'abc', PATH: '/usr/bin/longpathvalue' };
  const out = r.redactSecrets('key plainsecretvalue123 and lin_api_abcdefghijklmnopqrstuvwxyz; path /usr/bin/longpathvalue; "refresh_token": "rt_123" sk-proj-ABCDEFGHIJKLMNOPQRSTUV ghp_ABCDEFGHIJKLMNOPQRSTUVWX eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghij', env);
  assert.ok(!out.includes('plainsecretvalue123'));
  assert.ok(!out.includes('lin_api_'));
  assert.ok(!out.includes('rt_123'));
  assert.ok(!out.includes('sk-proj-'));
  assert.ok(!out.includes('ghp_'));
  assert.ok(!out.includes('eyJhbGci'));
  assert.ok(out.includes('/usr/bin/longpathvalue')); // non-secret env values stay
  assert.equal(r.redactSecrets(undefined, env), '');
});

test('cardBody: comments reach the prompt oldest first, newest kept when over budget', () => {
  const comments = [
    { body: 'newest: VERIFY: node --test x.test.mjs', createdAt: '2026-10-05T00:00:00Z' },
    { body: '   ', createdAt: '2026-10-04T00:00:00Z' },
    { body: 'oldest note', createdAt: '2026-10-01T00:00:00Z' },
  ];
  const body = r.cardBody('the description', comments);
  assert.ok(body.startsWith('the description'));
  assert.ok(body.indexOf('oldest note') < body.indexOf('newest: VERIFY'));
  assert.equal(r.cardBody('only desc', []), 'only desc');
  const tight = r.cardBody('d', comments, { maxComments: 80 });
  assert.ok(tight.includes('newest: VERIFY') && !tight.includes('oldest note') && tight.includes('1 older omitted'));
  assert.equal(r.cardBody('x'.repeat(40000), []).length, 30000);
});

test('lockMessage/lockCards: the run lock names unfinished cards for the next run', () => {
  assert.equal(r.lockMessage('2026-10-07T03:13:00Z'), 'locked 2026-10-07T03:13:00Z');
  const msg = r.lockMessage('2026-10-07T03:13:00Z', ['BRO-4784', 'BRO-12', 'BRO-4784', null, 'x; rm']);
  assert.equal(msg, 'locked 2026-10-07T03:13:00Z cards=BRO-4784,BRO-12');
  assert.deepEqual(r.lockCards(msg), ['BRO-4784', 'BRO-12']);
  assert.deepEqual(r.lockCards('locked 2026-10-06T21:00:00.000Z'), []);
  assert.deepEqual(r.lockCards('unlocked'), []);
  assert.deepEqual(r.lockCards(''), []);
});

test('orphanAction: only the dead run\'s own In Progress cards are touched', () => {
  const lockMs = Date.parse('2026-10-07T03:00:00Z');
  const base = { stateName: 'In Progress', startedAtMs: lockMs - 3600_000, lockMs, onMain: false, landRefMs: NaN };
  assert.equal(r.orphanAction(base), 'todo');
  assert.equal(r.orphanAction({ ...base, onMain: true }), 'done');
  assert.equal(r.orphanAction({ ...base, landRefMs: lockMs - 600_000 }), 'park');
  // a refused ref from an earlier attempt, older than this claim
  assert.equal(r.orphanAction({ ...base, landRefMs: lockMs - 86400_000 }), 'todo');
  // re-claimed by someone else after the dead run's last stamp
  assert.equal(r.orphanAction({ ...base, startedAtMs: lockMs + 10 * 60_000 }), 'skip');
  // clock skew: Linear's startedAt a few seconds after the container-clock stamp is still ours
  assert.equal(r.orphanAction({ ...base, startedAtMs: lockMs + 5_000 }), 'todo');
  assert.equal(r.orphanAction({ ...base, startedAtMs: NaN }), 'skip');
  assert.equal(r.orphanAction({ ...base, stateName: 'In Review', onMain: true }), 'skip');
  assert.equal(r.orphanAction({ ...base, stateName: 'Todo' }), 'skip');
});

test('lockMessage/lockCards: a released lock still names its unfinished cards', () => {
  const msg = r.lockMessage('2026-10-07T03:13:00Z', ['BRO-7'], 'released');
  assert.equal(msg, 'released 2026-10-07T03:13:00Z cards=BRO-7');
  assert.deepEqual(r.lockCards(msg), ['BRO-7']);
  assert.ok(!msg.startsWith('locked'), 'takeLock treats only "locked" stamps as held');
  assert.deepEqual(r.lockCards('locked 2026-10-07T03:13:00Z cards=BRO-7 '), ['BRO-7']);
});

test('parseCheckOutput: JSON result + cost, budget error, plain text fallback', () => {
  const ok = r.parseCheckOutput(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'fine\nVERDICT: SHIP', total_cost_usd: 1.234 }));
  assert.deepEqual(ok, { text: 'fine\nVERDICT: SHIP', costUsd: 1.234, error: null });
  assert.equal(r.parseVerdict(ok.text), 'SHIP');
  const capped = r.parseCheckOutput(JSON.stringify({ subtype: 'error_max_budget_usd', is_error: true, total_cost_usd: 4.01 }));
  assert.equal(capped.error, 'error_max_budget_usd');
  assert.equal(capped.costUsd, 4.01);
  assert.deepEqual(r.parseCheckOutput('Error: not logged in'), { text: 'Error: not logged in', costUsd: 0, error: null });
  assert.deepEqual(r.parseCheckOutput(''), { text: '', costUsd: 0, error: null });
});

test('stopReason: Claude check run budget', () => {
  const base = { startedMs: 0, nowMs: 1, maxMinutes: 300, weeklyPct: 10, maxWeeklyPct: 60, rejectStreak: 0, doneRefusals: 0 };
  assert.equal(r.stopReason({ ...base, checkSpentUsd: 29.9, checkBudgetUsd: 30 }), null);
  assert.match(r.stopReason({ ...base, checkSpentUsd: 30.5, checkBudgetUsd: 30 }), /Claude check spend \$30\.50/);
  assert.equal(r.stopReason({ ...base, checkSpentUsd: 99 }), null);
});

// 2026-10-10 22:47 run: a test created data/review-texts as a REAL directory while the link
// was dropped, and fs.rmSync(..., {force:true}) threw EISDIR on the next card, bouncing all
// seven. dropDataDir removes either shape, never follows a link, never leaves its root.
test('dropDataDir: unlinks the symlink (target untouched), removes a test-made dir, skips outside root', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { dropDataDir } = require('../../scripts/lib/codex-runner.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dropdata-'));
  try {
    const wt = path.join(root, 'wt'); const shared = path.join(root, 'shared');
    fs.mkdirSync(path.join(wt, 'data'), { recursive: true });
    fs.mkdirSync(path.join(shared, 'show-a'), { recursive: true });
    fs.writeFileSync(path.join(shared, 'show-a', 'r.json'), '{}');
    const link = path.join(wt, 'data', 'review-texts');
    fs.symlinkSync(shared, link);
    assert.equal(dropDataDir(link, wt), 'unlinked');
    assert.ok(fs.existsSync(path.join(shared, 'show-a', 'r.json')), 'the shared clone is never touched');
    fs.mkdirSync(path.join(link, 'show-b'), { recursive: true });
    fs.writeFileSync(path.join(link, 'show-b', 'x.json'), '{}');
    assert.equal(dropDataDir(link, wt), 'removed');
    assert.equal(fs.existsSync(link), false);
    assert.equal(dropDataDir(link, wt), 'none');
    assert.equal(dropDataDir(shared, wt), 'skipped', 'a real dir outside the worktree is never removed');
    assert.ok(fs.existsSync(shared));
  } finally { fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 }); }
});

test('emptyBatchVerdict: an empty node unit batch fails closed; empty scripts/lib batch reads clean (BRO-2483)', () => {
  const v = r.emptyBatchVerdict('unit-tests-node', []);
  assert.equal(v.exit, 1);
  assert.match(v.text, /node unit batch is empty/);
  assert.deepEqual(r.emptyBatchVerdict('scripts-lib-tests', []), { exit: 0, text: '' });
  assert.equal(r.emptyBatchVerdict('unit-tests-node', ['tests/unit/a.test.mjs']), null);
  assert.equal(r.emptyBatchVerdict('lint-workflows', null), null);
  // daily-runner wires it in and lists the node batch through the tree's collector, not the manifest file.
  const src = readFileSync(join(ROOT, 'scripts/codex/daily-runner.js'), 'utf8');
  assert.match(src, /R\.emptyBatchVerdict\(b\.gate, b\.files\)/);
  assert.match(src, /nodeUnitTestsForTree\(WT\)/);
  assert.doesNotMatch(src, /read\('tests\/unit-test-manifest\.txt'\)/);
});

// BRO-5287 (2026-10-13): runs stopped with "another run took the lock" while the remote tip was
// still their own 17:52 stamp; Codex "exited 1" on a capacity error; Mac-only and too-broad
// cards bounced off the Claude check.
test('lockTipVerdict: only a stamp this run never made means the lock is lost', () => {
  const ownShas = new Set(['aaa111', 'bbb222']);
  assert.equal(r.lockTipVerdict({ tip: 'bbb222', ownShas }), 'ours', 'tip is our own earlier stamp (the 2026-10-13 case)');
  assert.equal(r.lockTipVerdict({ tip: 'aaa111', ownShas }), 'ours', 'our push landed with the reply lost');
  assert.equal(r.lockTipVerdict({ tip: '', ownShas }), 'retry', 'ls-remote exit 0 with empty output');
  assert.equal(r.lockTipVerdict({ tip: null, ownShas }), 'retry', 'ls-remote failed');
  assert.equal(r.lockTipVerdict({ tip: 'ccc333', ownShas }), 'lost');
});

test('lockStampTooOld: a lock we cannot re-stamp is held only while it cannot go stale', () => {
  const staleMs = 90 * 60_000;
  const t0 = Date.parse('2026-10-13T17:52:29Z');
  const codex = 45 * 60_000;
  assert.equal(r.lockStampTooOld({ lastStampOkMs: t0, nowMs: t0 + 10 * 60_000, staleMs, nextBlockMs: codex }), false, '18:02: 10 min since the stamp, a Codex exec still fits');
  assert.equal(r.lockStampTooOld({ lastStampOkMs: t0, nowMs: t0 + 40 * 60_000, staleMs, nextBlockMs: codex }), true, 'another run could take it mid-exec');
  assert.equal(r.lockStampTooOld({ lastStampOkMs: t0, nowMs: t0 + 86 * 60_000, staleMs }), true, 'inside the 5 min margin');
  assert.equal(r.lockStampTooOld({ lastStampOkMs: NaN, nowMs: t0, staleMs }), true);
});

test('runnerId/lockRun: the stamp body names its run; old stamps read as unnamed', () => {
  assert.equal(r.runnerId({ CLAUDE_CODE_REMOTE_SESSION_ID: 'cse_019c371pq' }, 'h', 42), 'cse_019c371pq/42');
  assert.equal(r.runnerId({ GITHUB_RUN_ID: '123' }, 'h', 7), 'gha-123/7');
  assert.equal(r.runnerId({}, 'my host;rm', 7), 'myhostrm/7');
  assert.equal(r.lockRun('Run: cse_019c371pq/42\n'), 'cse_019c371pq/42');
  assert.equal(r.lockRun(''), '');
  // the subject keeps its shape, so lockCards still reads stamps written with a Run: body
  assert.deepEqual(r.lockCards(r.lockMessage('2026-10-13T17:52:29.700Z', ['BRO-3634'])), ['BRO-3634']);
});

test('codexExitTransient/stripHookNoise: a capacity error is retried and quoted, hooks are not', () => {
  const out = ['hook: PostToolUse', 'hook: PostToolUse Completed', 'ERROR: Selected model is at capacity. Please try a different model.', 'tokens used', '30,627'].join('\n');
  assert.match(r.codexExitTransient(out), /at capacity/);
  assert.equal(r.codexExitTransient('ERROR: unexpected argument --foo'), null);
  assert.equal(r.codexExitTransient('the 503 test fixture passed'), null, 'needs an error line');
  assert.match(r.codexExitTransient('error: stream disconnected before completion'), /stream disconnected/);
  const s = r.stripHookNoise(out);
  assert.ok(!s.includes('hook:') && s.includes('at capacity'));
});

test('codexCardFit: Mac-only and too-broad cards are skipped, one-test cards go first', () => {
  assert.equal(r.codexCardFit({ title: 'P3: opening-night monitor harness: launchd env lacks .env keys', description: '' }).skip, 'mac-only');
  assert.equal(r.codexCardFit({ title: 'cmux launcher reports ok:false on a launch that actually succeeded', description: '' }).skip, 'mac-only');
  const broad = r.codexCardFit({ title: 'Wire scripts/audit-exclusion-flags.js into a report-only weekly cron', description: 'Add .github/workflows/x.yml. Reads review-texts. Phase 2 follow-ups.', verify: 'node --test tests/unit/x.test.mjs' });
  assert.equal(broad.skip, 'workflow-edit', 'a workflow edit is a hard skip since BRO-5384');
  assert.equal(r.codexCardFit({ title: 'Wire a report-only weekly cron', description: 'Reads review-texts. Phase 2 follow-ups. Needs an API key.', verify: '' }).skip, 'too-broad');
  const small = r.codexCardFit({ title: 'isUkOutletUrl calls US sites UK', description: 'Fix the regex.\n## Acceptance criteria\n- test passes', verify: 'node --test scripts/lib/venue-classification.test.mjs' });
  assert.equal(small.skip, null);
  const vague = r.codexCardFit({ title: 'Some fix', description: 'x'.repeat(4000), verify: 'npx tsc --noEmit' });
  assert.ok(small.score > vague.score);
});

test('codexExitTransient: only Codex ERROR lines near the end count', () => {
  assert.equal(r.codexExitTransient('ran tests: Error 503 from fixture\n' + 'x\n'.repeat(50) + 'Codex timed out'), null);
  assert.equal(r.codexExitTransient('curl said error: 503\nmore'), null, 'not a line Codex itself printed as ERROR:');
});

test('landWaitMinutes: landing waits never run past the hard stop', () => {
  const now = Date.parse('2026-10-13T22:30:00Z');
  const hard = Date.parse('2026-10-13T22:43:00Z'); // 20:51 start + 112 min
  assert.equal(r.landWaitMinutes({ hardEndMs: Infinity, wrapUpMs: 480_000, nowMs: now }), 90, 'no hard stop: the usual 90');
  assert.equal(r.landWaitMinutes({ hardEndMs: hard, wrapUpMs: 480_000, nowMs: now }), 5);
  assert.ok(r.landWaitMinutes({ hardEndMs: hard, wrapUpMs: 480_000, nowMs: hard - 60_000 }) < 1, 'inside the wrap-up time: do not wait');
});

test('recovery git calls run in ROOT: they run before the runner worktree exists (BRO-5287)', () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../scripts/codex/daily-runner.js'), 'utf8');
  for (const fn of ['function landedOnMain', 'async function recoverOrphans', 'async function reconcileLanded']) {
    const start = src.indexOf(fn);
    assert.ok(start >= 0, fn);
    const body = src.slice(start, src.indexOf('\n}\n', start));
    const calls = body.match(/\bgit\(\[[^\]]*\][^)]*\)/g) || [];
    assert.ok(calls.length > 0, `${fn} has git calls`);
    for (const c of calls) assert.match(c, /,\s*ROOT\)$/, `${fn}: ${c} must pass ROOT`);
  }
});

test('lock pushes skip git hooks: the pre-push code audits refused bookkeeping stamps (BRO-5287)', () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../scripts/codex/daily-runner.js'), 'utf8');
  const pushes = src.match(/\['push',[^\]]*LOCK_REF[^\]]*\]/g) || [];
  assert.ok(pushes.length > 0, 'found the lock push');
  for (const p of pushes) assert.ok(p.includes("'--no-verify'"), p);
});

test('assessRunnerSummaries: 3 runs, none stopped on the lock, something landed', () => {
  const run = (landed, stop) => `## Codex runner 2026-10-14: 1 card(s) worked in 61 min\n- Landed and Done: ${landed}\n- Landed part, back to Todo with what is left: none\n- Stopped early: ${stop}`;
  assert.deepEqual(r.assessRunnerSummaries([run('BRO-1', 'no'), run('none', 'time budget of 105 min used'), run('none', 'under 75 min left before the 112-min hard stop')]),
    { ok: true, runs: 3, landed: 1, problems: [] });
  const bad = r.assessRunnerSummaries([run('none', 'lost the run lock (see the run log)'), run('none', 'another run took the lock'), 'unrelated comment']);
  assert.equal(bad.ok, false);
  assert.equal(bad.runs, 2);
  assert.ok(bad.problems.some((p) => p.includes('stopped on the lock')) && bad.problems.includes('no card landed'));
});

test('runner pushes of land/codex-* refs skip the session pre-push hook (BRO-5287, BRO-4530 crash)', () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../scripts/codex/daily-runner.js'), 'utf8');
  const pushes = src.match(/git\(\['push',[^\]]*refs\/heads\/\$\{ref\}[^\]]*\]/g) || [];
  assert.ok(pushes.length > 0, 'found the land push');
  for (const p of pushes) assert.ok(p.includes("'--no-verify'"), p);
});

test('a card the hard stop leaves unjudged goes back without the bounce marker or the REJECT streak (BRO-5287)', () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../scripts/codex/daily-runner.js'), 'utf8');
  const start = src.indexOf('if (outOfTime) {');
  assert.ok(start > 0, 'out-of-time path exists');
  const block = src.slice(start, src.indexOf('\n    }\n', start));
  assert.ok(!block.includes('BOUNCED_MARKER'), 'no 14-day Codex ban for a card nobody judged');
  assert.ok(block.includes("return 'done'") && start < src.indexOf('stats.rejectStreak ='), 'returns before the REJECT streak update');
});

test('runnerHealth: the daily row flags a dead, lock-stopped or non-landing runner (BRO-5287)', () => {
  const now = Date.parse('2026-10-14T13:40:00Z');
  const run = (at, { done = 'none', part = 'none', crash = 'none', stop = 'no' } = {}) => ({ createdAt: at, body: `## Codex runner 2026-10-14: 2 card(s) worked in 90 min\n- Landed and Done: ${done}\n- Landed part, back to Todo with what is left: ${part}\n- Runner error mid-card (back to Todo): ${crash}\n- Stopped early: ${stop}` });
  // the real 2026-10-14 record after the fixes
  const good = [run('2026-10-14T08:14:00Z', { part: 'BRO-4813' }), run('2026-10-14T09:51:00Z'), run('2026-10-14T12:25:00Z', { part: 'BRO-5028' })];
  assert.equal(r.runnerHealth(good, now).status, 'pass');
  assert.match(r.runnerHealth(good, now).message, /3 run\(s\), 2 card\(s\) landed, 0 crashed/);
  assert.equal(r.runnerHealth([], now).status, 'error', 'no summaries = not running');
  assert.equal(r.runnerHealth([run('2026-10-12T08:00:00Z', { done: 'BRO-1' })], now).status, 'error', 'older than 24h does not count');
  assert.equal(r.runnerHealth([run('2026-10-15T08:00:00Z', { done: 'BRO-1' })], now).status, 'error', 'a later summary does not count');
  // the 2026-10-13 failure: runs, no landings, lock stops
  const bad = [run('2026-10-13T15:31:00Z', { crash: 'BRO-3364', stop: 'another run took the lock' })];
  assert.equal(r.runnerHealth(bad, Date.parse('2026-10-13T18:00:00Z')).status, 'error');
  assert.equal(r.runnerHealth([run('2026-10-14T09:00:00Z'), run('2026-10-14T11:00:00Z')], now).status, 'error', 'nothing landed');
  assert.equal(r.runnerHealth([run('2026-10-14T09:00:00Z', { done: 'BRO-2', crash: 'BRO-3, BRO-4' })], now).status, 'warn');
  assert.equal(r.runnerHealth([{ createdAt: '2026-10-14T09:00:00Z', body: 'a human comment' }], now).status, 'error');
});

test('runnerHealth: a lapsed Codex login reads as such, and the row is internal-only', () => {
  const now = Date.parse('2026-10-14T13:40:00Z');
  const row = r.runnerHealth([{ createdAt: '2026-10-14T09:00:00Z', body: '## Codex runner did not start\n\nNo usable Codex login' }], now);
  assert.equal(row.status, 'error');
  assert.match(row.message, /login/);
  const { classifyHealthCheck } = require('../../scripts/lib/digest-audience.js');
  assert.notEqual(classifyHealthCheck({ name: 'Codex runner: landing cards', status: 'error' }), 'visitors');
});

test('runnerSummaryFacts: one parser for the acceptance probe and the daily row', () => {
  const b = '## Codex runner 2026-10-14: 2 card(s) worked in 90 min\n- Landed and Done: BRO-1, \n- Landed part, back to Todo with what is left: BRO-2\n- Runner error mid-card (back to Todo): BRO-3, BRO-4\n- Stopped early: no';
  assert.deepEqual(r.runnerSummaryFacts(b), { landed: 2, crashed: 2, stop: 'no', checkUsd: 0 });
  assert.equal(r.assessRunnerSummaries([b, b, b]).landed, 6);
  assert.match(r.runnerHealth([{ createdAt: '2026-10-14T09:00:00Z', body: b }], Date.parse('2026-10-14T10:00:00Z')).message, /2 card\(s\) landed, 2 crashed/);
});

// BRO-5287: Linear's comment pages run newest first, so `first: 50` keeps the latest
// comments and `last: N` returns the OLDEST N. The runner summaries on BRO-4745 pass 50
// comments, and a `last:` read there froze the cloud-worker check on stale summaries.
test('comment reads keep the newest page: shared query uses first:, nothing queries comments with last:', (t) => {
  const q = require('../../scripts/lib/linear-dispatch.js').buildIssueCommentsByNumberQuery();
  assert.match(q, /comments\(first: 50, orderBy: createdAt\)/);
  assert.doesNotMatch(q, /\blast:/);
  // Built from parts so this file does not match itself.
  // cloud-memory/ is the Mac's synced mirror (quotes, not code a session runs).
  const pattern = 'comments\\(' + '[^)]*\\blast:\\s*[0-9$]';
  const g = spawnSync('git', ['grep', '-nE', pattern, '--', '*.js', '*.mjs', '*.cjs', '*.ts', '*.tsx', '*.md', '*.sh', '*.yml', ':!cloud-memory/'], { cwd: ROOT, encoding: 'utf8' });
  if (g.status !== 0 && g.status !== 1) { t.skip(`git grep unavailable: ${(g.stderr || g.error || '').toString().slice(0, 200)}`); return; }
  assert.equal(g.stdout.trim(), '', `Linear comment reads with last: return the OLDEST comments; use first: (newest first) or listIssueComments:\n${g.stdout}`);
});

// ---- BRO-5384: parallel slots, routing, fix rounds, check noise ----

test('codexCardFit: the four kinds of card the sandbox cannot finish are skipped (real rejected cards)', () => {
  const fit = (title, description) => r.codexCardFit({ title, description, verify: 'node --test tests/unit/x.test.mjs' });
  // BRO-3475 (needed a workflow step), BRO-4299 (land/ pushes), BRO-4427 + BRO-4855 (hundreds of
  // shipped rows), BRO-5223 (a data repair): all rejected by the Claude check on 2026-10-14/15.
  assert.equal(fit('drift-state lastAlertTs is stamped before routing', 'stamps state before the workflow\'s alert step ever runs.').skip, 'workflow-edit');
  assert.equal(fit('Cut Actions minutes', 'Land gauntlet runs base+branch per land/** push (~10 min each).').skip, 'land-ref');
  assert.equal(fit('Temporal wrongProduction override', '464 with unhandled violations, 1003 shipped reviews in 464 shows').skip, 'corpus-wide-data');
  assert.equal(fit('Rebuild guard: drop a dateless review', 'reviews.json: 293 rows with no url AND no publishDate.').skip, 'corpus-wide-data');
  assert.equal(fit('unicode-stars-fallthrough extractor', 'Data repair through an approved-fix plan.').skip, 'private-repo-write');
  assert.equal(fit('Edit flow', 'Then edit .github/workflows/land.yml.').skip, 'workflow-edit');
  assert.equal(fit('x', 'write to broadway-review-texts').skip, 'private-repo-write');
});

test('codexCardFit: years, passing mentions of a landed ref and plain code cards still go to Codex', () => {
  const fit = (description) => r.codexCardFit({ title: 'Fix the parser', description, verify: 'node --test tests/unit/x.test.mjs' });
  assert.equal(fit('Reviews from 2024 reviews pages misparse.').skip, null, 'a year is not a count');
  assert.equal(fit('BRO-5100 landed via land/bro-5100-fix; this is the follow-up in the parser.').skip, null);
  assert.equal(fit('Add a .yml fixture for the parser test.').skip, null);
  assert.equal(fit('The regex drops 12 reviews.').skip, null, 'a small count is not corpus-wide');
});

test('codexCardFit: a CODEX-OK line overrides the hard skips; Mac-only stays a skip', () => {
  const card = { title: 'x', description: 'Then edit .github/workflows/land.yml.', verify: '' };
  assert.equal(r.codexCardFit(card).skip, 'workflow-edit');
  assert.equal(r.codexCardFit({ ...card, description: `${card.description}\nCODEX-OK: the yml change is a comment` }).skip, null);
  assert.equal(r.codexCardFit({ ...card, comments: [{ body: 'CODEX-OK' }] }).skip, null);
  assert.equal(r.codexCardFit({ title: 'launchd job', description: 'CODEX-OK' }).skip, 'mac-only');
});

test('swf carry: Codex\'s change and the attempt survive the round trip; only the newest, recent note counts', () => {
  const now = Date.parse('2026-10-15T12:00:00Z');
  const patch = 'diff --git a/scripts/x.js b/scripts/x.js\n--- a/scripts/x.js\n+++ b/scripts/x.js\n@@ -1 +1 @@\n-a\n+b\n';
  const body = r.swfCarryBody({ attempt: 2, patch, summary: '### Independent check (SHIP-WITH-FIXES)\nfix the test' });
  assert.ok(body.startsWith(r.SWF_CARRY_MARKER));
  assert.ok(!body.includes(r.BOUNCED_MARKER), 'a carry is not a bounce: the picker must keep giving the card to Codex');
  assert.ok(!r.looksLikeSecretLeak(body.split('\n').map((l) => `+${l}`).join('\n')));
  const at = (ms) => new Date(ms).toISOString();
  const back = r.parseSwfCarry([{ body, createdAt: at(now - 3600_000) }], now);
  assert.equal(back.attempt, 2);
  assert.equal(back.patch, patch);
  assert.match(back.findings, /^### Independent check \(SHIP-WITH-FIXES\)\nfix the test$/);
  assert.equal(r.parseSwfCarry([{ body, createdAt: at(now - 3600_000) }, { body: 'later note', createdAt: at(now - 60_000) }], now), null);
  assert.equal(r.parseSwfCarry([{ body, createdAt: at(now - 4 * 24 * 3600_000) }], now), null, 'older than 3 days');
  assert.equal(r.parseSwfCarry({ nodes: [{ body, createdAt: at(now) }] }, now).attempt, 2, 'Linear nodes shape');
  // Too large to carry: the note still resumes the round, with the findings only.
  const big = r.swfCarryBody({ attempt: 1, patch: require('crypto').randomBytes(80_000).toString('hex'), summary: 's' });
  assert.equal(r.parseSwfCarry([{ body: big, createdAt: at(now) }], now).patch, null);
  // Findings reach the resumed round in full: the card body clips each comment to 2500 chars.
  const longFindings = `### Independent check (SHIP-WITH-FIXES)\n${'finding '.repeat(500)}LAST-FINDING`;
  const long = r.swfCarryBody({ attempt: 1, patch, summary: longFindings });
  assert.equal(r.parseSwfCarry([{ body: long, createdAt: at(now) }], now).findings, longFindings);
  // The picker puts a carried card first.
  const plain = r.codexCardFit({ title: 'x', description: 'y', comments: [] , nowMs: now });
  const carried = r.codexCardFit({ title: 'x', description: 'y', comments: [{ body, createdAt: at(now) }], nowMs: now });
  assert.ok(carried.score > plain.score && carried.why.includes('swf-carry'));
});

test('fixRoundDeadline: a SHIP-WITH-FIXES round is not cut by the 60-min card budget (no card ever got one)', () => {
  const t0 = Date.parse('2026-10-15T10:00:00Z');
  const card = t0 + 60 * 60_000; // --card-max-minutes 60
  const runEnd = t0 + 104 * 60_000; // --hard-stop-minutes 112 minus wrap-up
  const now = t0 + 40 * 60_000; // first exec, land checks and review used 40 min
  const hard = t0 + 112 * 60_000;
  const fits = (deadline) => r.fixRoundFits({ deadlineMs: deadline, nowMs: now, hardEndMs: hard, wrapUpMs: 8 * 60_000 });
  assert.equal(fits(r.fixRoundDeadline({ verdict: 'SHIP-WITH-FIXES', swfRoundUsed: false, cardDeadlineMs: card, runEndMs: runEnd })), true);
  assert.equal(fits(r.fixRoundDeadline({ verdict: 'REJECT', swfRoundUsed: false, cardDeadlineMs: card, runEndMs: runEnd })), false, 'a REJECT keeps to the card budget');
  assert.equal(r.fixRoundDeadline({ verdict: 'SHIP-WITH-FIXES', swfRoundUsed: true, cardDeadlineMs: card, runEndMs: runEnd }), card, 'only the first one');
  // A verdict at minute 50 leaves under exec + land checks + review before the hard stop: that
  // round is carried to the next run (swfCarryBody) instead of being dropped.
  assert.equal(r.fixRoundFits({ deadlineMs: runEnd, nowMs: t0 + 50 * 60_000, hardEndMs: hard, wrapUpMs: 8 * 60_000 }), false);
  assert.equal(r.fixRoundDeadline({ verdict: 'SHIP-WITH-FIXES', swfRoundUsed: false, cardDeadlineMs: card, runEndMs: Infinity }), Infinity);
});

test('daily-runner: a SHIP-WITH-FIXES with no time left is carried, never bounced; a carry is resumed', () => {
  const src = readFileSync(join(ROOT, 'scripts/codex/daily-runner.js'), 'utf8');
  assert.match(src, /if \(swfRound\) \{ carryOver = true; break; \}/);
  assert.match(src, /R\.swfCarryBody\(\{ attempt, patch, summary \}\)/);
  assert.match(src, /const patch = R\.carryPatch\(WT, cardBase\)/, 'never a trimmed git() diff');
  assert.match(src, /execFits = \(deadline = roundDeadline\) => R\.fixRoundFits\(/);
  assert.match(src, /const carry = R\.parseSwfCarry\(comments, Date\.now\(\)\)/);
  assert.match(src, /R\.fixRoundDeadline\(/);
});

test('slotNames: slot 0 keeps the single-runner names, others get their own worktrees and lock', () => {
  assert.deepEqual(r.slotNames(0), { wt: 'codex-runner', base: 'codex-runner-base', lockRef: 'refs/heads/codex-runner-lock' });
  assert.deepEqual(r.slotNames(2), { wt: 'codex-runner-2', base: 'codex-runner-base-2', lockRef: 'refs/heads/codex-runner-lock-2' });
  assert.equal(new Set([0, 1, 2, 3].map((k) => r.slotNames(k).lockRef)).size, 4);
});

test('slotsForLogin: one Codex process whenever the login could refresh during the run', () => {
  const now = Date.parse('2026-10-15T10:00:00Z');
  const jwt = (exp) => `e30.${Buffer.from(JSON.stringify({ exp: Math.floor(exp / 1000) })).toString('base64url')}.sig`;
  const auth = (exp) => JSON.stringify({ tokens: { access_token: jwt(exp) } });
  const runMs = 112 * 60_000;
  assert.equal(r.jwtExpMs(jwt(now + 1000_000)), Math.floor((now + 1000_000) / 1000) * 1000);
  assert.deepEqual(r.slotsForLogin({ slots: 3, authText: auth(now + 5 * 24 * 3600_000), nowMs: now, runMs }), { slots: 3, why: null });
  assert.equal(r.slotsForLogin({ slots: 3, authText: auth(now + 60 * 60_000), nowMs: now, runMs }).slots, 1, 'expires mid-run');
  assert.equal(r.slotsForLogin({ slots: 3, authText: auth(now - 1000), nowMs: now, runMs }).slots, 1, 'already expired: the first exec refreshes');
  assert.equal(r.slotsForLogin({ slots: 3, authText: '{"tokens":{}}', nowMs: now, runMs }).slots, 1, 'unreadable fails safe');
  assert.equal(r.slotsForLogin({ slots: 3, authText: 'not json', nowMs: now, runMs }).slots, 1);
  assert.equal(r.slotsForLogin({ slots: 1, authText: auth(now + 9e9), nowMs: now, runMs }).slots, 1);
});

test('slotArgs: each slot gets its share of the budgets and the shared run dir, never the launcher flag', () => {
  const argv = ['--slots', '3', '--limit', '9', '--max-minutes', '105', '--check-budget-usd', '30', '--hard-stop-minutes', '112', '--no-land'];
  const a = r.slotArgs(argv, { slot: 1, runDir: '/tmp/l', runStartedMs: 5, limit: 3, checkBudgetUsd: 10 });
  assert.ok(!a.includes('--slots'));
  assert.deepEqual(a, ['--max-minutes', '105', '--hard-stop-minutes', '112', '--no-land', '--slot', '1', '--run-dir', '/tmp/l', '--run-started', '5', '--limit', '3', '--check-budget-usd', '10']);
  // The whole launch's pick list; and a launch that fell back to one slot runs as a lone runner.
  const lone = r.slotArgs([...argv, '--pick-list', '4'], { slot: 0, runDir: '', runStartedMs: 5, limit: 9, checkBudgetUsd: 30, pickList: 24 });
  assert.ok(!lone.includes('--run-dir'));
  assert.deepEqual(lone.slice(-2), ['--pick-list', '24']);
  assert.equal(lone.filter((x) => x === '--pick-list').length, 1);
});

test('launchRunDir: one slot per card, a STOP reaches every slot, the mutex serialises and frees a dead holder', async () => {
  const { mkdtempSync, writeFileSync, existsSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(join(tmpdir(), 'codex-launch-'));
  const a = r.launchRunDir(dir, 0, { pollMs: 50 });
  const b = r.launchRunDir(dir, 1, { pollMs: 50 });
  assert.equal(a.takeCard('BRO-1'), true);
  assert.equal(b.takeCard('BRO-1'), false);
  assert.equal(b.takeCard('BRO-2'), true);
  assert.equal(a.stopped(), null);
  b.stopAll('Codex exited 1: login expired');
  a.stopAll('second stop keeps the first reason');
  assert.equal(a.stopped(), 'slot 1: Codex exited 1: login expired');
  // A held mutex blocks: another process holds it for 600 ms.
  const holder = spawnSync(process.execPath, ['-e', `
    const r = require(${JSON.stringify(join(ROOT, 'scripts/lib/codex-runner.js'))});
    const fs = require('fs');
    const d = r.launchRunDir(${JSON.stringify(dir)}, 2, { pollMs: 50 });
    const { spawn } = require('child_process');
    // child 1 holds the mutex 600 ms; child 2 starts 100 ms later and must wait for it.
    const code = (who, delay) => "const r=require(" + JSON.stringify(${JSON.stringify(join(ROOT, 'scripts/lib/codex-runner.js'))}) + ");const fs=require('fs');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0," + delay + ");r.launchRunDir(" + JSON.stringify(${JSON.stringify(dir)}) + ",0,{pollMs:20}).withMutex('m',()=>{fs.appendFileSync(" + JSON.stringify(${JSON.stringify(join(dir, 'order'))}) + ",'" + who + "+');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,600);fs.appendFileSync(" + JSON.stringify(${JSON.stringify(join(dir, 'order'))}) + ",'" + who + "-');});";
    const c1 = spawn(process.execPath, ['-e', code('a', 0)]);
    const c2 = spawn(process.execPath, ['-e', code('b', 100)]);
    let n = 0; const done = () => { if (++n === 2) console.log(fs.readFileSync(${JSON.stringify(join(dir, 'order'))}, 'utf8')); };
    c1.on('exit', done); c2.on('exit', done);
  `], { encoding: 'utf8', timeout: 20_000 });
  assert.equal(holder.stdout.trim(), 'a+a-b+b-', `the second holder waits for the first: ${holder.stderr}`);
  // A holder that died (pid gone) does not block anyone.
  writeFileSync(join(dir, 'land-checks.lock'), '2147483646');
  assert.equal(a.withMutex('land-checks', () => 'ran'), 'ran');
  assert.equal(existsSync(join(dir, 'land-checks.lock')), false);
  // An empty lock a minute old: its holder died between creating it and writing its pid.
  const { utimesSync } = await import('node:fs');
  writeFileSync(join(dir, 'land-checks.lock'), '');
  utimesSync(join(dir, 'land-checks.lock'), new Date(Date.now() - 120_000), new Date(Date.now() - 120_000));
  assert.equal(a.withMutex('land-checks', () => 'ran again'), 'ran again');
  // No run dir: a lone runner, everything passes through.
  const lone = r.launchRunDir('', 0);
  assert.equal(lone.takeCard('BRO-1') && lone.takeCard('BRO-1'), true);
  assert.equal(lone.stopped(), null);
  assert.equal(lone.withMutex('x', () => 7), 7);
});

test('the Claude check compares failing tests with fresh main and counts only new ones', () => {
  const tpl = readFileSync(join(ROOT, 'scripts/codex/check-prompt.md'), 'utf8');
  assert.match(tpl, /\{\{BASE\}\}/);
  assert.match(tpl, /only a failure this change adds counts/i);
  assert.match(tpl, /never base SHIP-WITH-FIXES or REJECT on them/);
  const filled = r.fillPrompt(tpl, { id: 'BRO-1', title: 't', body: 'b', base: '/w/base' });
  assert.ok(filled.includes('cd /w/base && node --test') && !filled.includes('{{BASE}}'));
  assert.match(r.fillPrompt('{{BASE}}', {}), /not available/);
  const src = readFileSync(join(ROOT, 'scripts/codex/daily-runner.js'), 'utf8');
  assert.match(src, /prepareBase\(\); base = BASE_WT;/);
  assert.match(src, /'--add-dir', \.\.\.data\.dirs, \.\.\.\(base \? \[base\] : \[\]\)/);
});

test('board-workers.md starts three slots with budgets that leave a SHIP-WITH-FIXES round', () => {
  const doc = readFileSync(join(ROOT, 'docs/cloud-routines/board-workers.md'), 'utf8');
  const cmd = (doc.match(/`(node scripts\/codex\/daily-runner\.js --slots[^`]+)`/) || [])[1] || '';
  const flag = (n) => Number((cmd.match(new RegExp(`--${n} (\\d+)`)) || [])[1]);
  assert.ok(flag('slots') >= 3 && flag('slots') <= 4, cmd);
  assert.ok(flag('limit') >= flag('slots') * 2, 'at least two cards per slot');
  assert.ok(flag('hard-stop-minutes') <= 115, 'inside the routine\'s 120-min background limit');
});

test('carryPatch: a real carried change (text + binary) re-applies in full on the card base (BRO-5384)', async () => {
  const { mkdtempSync, writeFileSync, readFileSync: rf } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const repo = mkdtempSync(join(tmpdir(), 'codex-carry-'));
  const g = (...a) => { const x = spawnSync('git', a, { cwd: repo, encoding: 'utf8' }); assert.equal(x.status, 0, x.stderr); return x.stdout.trim(); };
  g('init', '-q'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't');
  writeFileSync(join(repo, 'a.js'), 'one\ntwo\n');
  g('add', '-A'); g('commit', '-qm', 'base');
  const base = g('rev-parse', 'HEAD');
  g('checkout', '-qb', 'codex/bro-1');
  writeFileSync(join(repo, 'a.js'), 'one\nTWO\nthree\n');
  writeFileSync(join(repo, 'pic.bin'), Buffer.from([0, 1, 2, 255, 0, 9]));
  g('add', '-A'); g('commit', '-qm', 'codex attempt');
  const patch = r.carryPatch(repo, base);
  assert.ok(patch.endsWith('\n'), 'the raw diff keeps its final newline');
  const carried = r.parseSwfCarry([{ body: r.swfCarryBody({ attempt: 1, patch, summary: 's' }), createdAt: new Date().toISOString() }], Date.now()).patch;
  // Next run: a fresh branch on the base, the carried patch applied the way the runner does it.
  g('checkout', '-qf', '-B', 'resume', base);
  const ap = spawnSync('git', ['apply', '--index', '--whitespace=nowarn', '-'], { cwd: repo, input: carried, encoding: 'utf8' });
  assert.equal(ap.status, 0, ap.stderr);
  assert.equal(rf(join(repo, 'a.js'), 'utf8'), 'one\nTWO\nthree\n');
  assert.deepEqual([...rf(join(repo, 'pic.bin'))], [0, 1, 2, 255, 0, 9]);
  // The bug this guards: the same diff trimmed (as git() returns stdout) does not apply.
  g('checkout', '-qf', '-B', 'resume2', base);
  const trimmed = spawnSync('git', ['apply', '--index', '-'], { cwd: repo, input: patch.trim(), encoding: 'utf8' });
  assert.notEqual(trimmed.status === 0 && rf(join(repo, 'a.js'), 'utf8') === 'one\nTWO\nthree\n' && spawnSync('git', ['diff', '--cached', '--name-only'], { cwd: repo, encoding: 'utf8' }).stdout.includes('pic.bin'), true);
  assert.equal(r.carryPatch(repo, 'no-such-ref'), '');
});

// ---- BRO-5384 part 2 (owner 2026-10-15: Codex carries the load, Claude is the fallback) ----

test('checkModel: Sonnet only for a small diff outside risky and shared-infrastructure paths', () => {
  const { classifyChange } = require('../../scripts/lib/infra-review-scope.js');
  const m = (files) => r.checkModel({ files, classify: classifyChange }).model;
  assert.equal(m([{ path: 'scripts/lib/venue-classification.js', changed: 12 }, { path: 'scripts/lib/venue-classification.test.mjs', changed: 30 }]), 'sonnet');
  assert.equal(m([{ path: 'scripts/lib/venue-classification.js', changed: 81 }]), 'opus', 'over 80 lines');
  assert.equal(m([1, 2, 3, 4].map((i) => ({ path: `scripts/lib/a${i}.js`, changed: 2 }))), 'opus', 'over 3 files');
  assert.equal(m([{ path: 'src/lib/scoring.ts', changed: 2 }]), 'opus', 'scoring');
  assert.equal(m([{ path: 'scripts/lib/score-extractors.js', changed: 2 }]), 'opus');
  assert.equal(m([{ path: 'data/pending-fixes/bro-1.json', changed: 2 }]), 'opus', 'data');
  assert.equal(m([{ path: 'scripts/codex/daily-runner.js', changed: 2 }]), 'opus', 'shared infrastructure (CLAUDE.md 18)');
  assert.equal(m([]), 'opus');
  assert.equal(m([{ path: '{scripts/lib => data}/x.json', changed: 2 }]), 'opus', 'a rename hides the real path');
  const src = readFileSync(join(ROOT, 'scripts/codex/daily-runner.js'), 'utf8');
  assert.match(src, /'-p', '--model', model,/, 'the check runs on the chosen model');
});

test('leaveToCodex: the Claude worker leaves fit cards to a live Codex runner, never Urgent, START-NOW or bounced ones', () => {
  const now = Date.parse('2026-10-15T12:00:00Z');
  const card = { title: 'Parser drops the critic name', description: 'Fix the regex in scripts/lib/x.js.', priority: 2, comments: { nodes: [] } };
  const verify = 'node --test scripts/lib/x.test.mjs';
  assert.equal(r.leaveToCodex(card, { nowMs: now, verify }), true);
  assert.equal(r.leaveToCodex({ ...card, priority: 1 }, { nowMs: now, verify }), false, 'Urgent: whoever is free');
  assert.equal(r.leaveToCodex(card, { nowMs: now, verify, startNow: true }), false, 'START-NOW: whoever is free');
  assert.equal(r.leaveToCodex({ ...card, description: 'Then edit .github/workflows/land.yml.' }, { nowMs: now, verify }), false, 'Codex cannot do it');
  const bounced = { ...card, comments: { nodes: [{ body: `${r.BOUNCED_MARKER}\n## Codex runner: not landed`, createdAt: new Date(now - 3600_000).toISOString() }] } };
  assert.equal(r.leaveToCodex(bounced, { nowMs: now, verify }), false, 'Codex already tried');
});

test('savings line: check $ per landed card in the summary and the health row; landed cards per lane from git log', () => {
  const b = '## Codex runner 2026-10-15: 3 card(s) worked in 100 min (slot 0)\n- Landed and Done: BRO-1, BRO-2\n- Runner error mid-card (back to Todo): none\n- Claude check: 4 review(s), $1.20 API cost\n- Stopped early: no';
  assert.equal(r.runnerSummaryFacts(b).checkUsd, 1.2);
  assert.match(r.runnerHealth([{ createdAt: '2026-10-15T09:00:00Z', body: b }], Date.parse('2026-10-15T10:00:00Z')).message, /2 card\(s\) landed, 0 crashed mid-card, Claude check \$1\.20 \(\$0\.60 per landed card\)/);
  const log = ['Codex runner\tfix(BRO-10): a', 'Codex runner\tfix(BRO-10): a (review fixes)', 'Claude\tBRO-20: b', 'Claude\tdata(BRO-21) + BRO-20', 'github-actions[bot]\tdata: BRO-99 rebuild', 'Tom Pryor\tBRO-98'].join('\n');
  assert.deepEqual(r.landedPerLane(log), { codex: 1, claude: 2 });
  const src = readFileSync(join(ROOT, 'scripts/codex/daily-runner.js'), 'utf8');
  assert.match(src, /- Claude check by model: /);
  assert.match(src, /- Landed on main, last 24h: /);
});

test('firingThroughput: slot summaries of one firing count once; cards per firing and landed share (BRO-5384 acceptance)', () => {
  const sum = (at, worked, landed, slot) => ({ createdAt: at, body: `## Codex runner 2026-10-15: ${worked} card(s) worked in 100 min${slot == null ? '' : ` (slot ${slot})`}\n- Landed and Done: ${landed || 'none'}\n- Stopped early: no` });
  // Firing 1: slot 2 finds nothing left and posts at +4 min, slots 0 and 1 near the hard stop.
  // Firing 2: a lone runner (one-slot fallback), no slot suffix.
  const t = r.firingThroughput([
    sum('2026-10-15T07:45:00Z', 1, '', 2), sum('2026-10-15T09:30:00Z', 2, 'BRO-1', 0), sum('2026-10-15T09:32:00Z', 2, 'BRO-2, BRO-3', 1),
    sum('2026-10-15T11:31:00Z', 3, 'BRO-4'),
    { createdAt: '2026-10-15T11:40:00Z', body: '## Codex runner: landed\n\nnot a summary' },
  ]);
  assert.deepEqual(t, { firings: 2, worked: 8, landed: 4, perFiring: 4, landedShare: 0.5 });
  assert.deepEqual(r.firingThroughput([]), { firings: 0, worked: 0, landed: 0, perFiring: 0, landedShare: 0 });
});

test('an "already fixed" card the Done gate refuses is handed back, not a launch-wide stop (BRO-5287)', () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../scripts/codex/daily-runner.js'), 'utf8');
  const start = src.indexOf("if (step === 'close-already-fixed') {");
  const block = src.slice(start, src.indexOf('\n    }\n', start));
  assert.ok(start > 0 && !block.includes('doneRefusals'), 'a refused already-fixed close must not count as a Done refusal');
});

test('a runner error is not Codex failing the card, and repeated errors or a full disk stop the run (BRO-5287, 2026-10-15 07:41)', () => {
  const crashNote = `${r.BOUNCED_MARKER}\n## Codex runner: stopped mid-card\n\nError: fatal: unable to write loose object file: No space left on device`;
  const realBounce = `${r.BOUNCED_MARKER}\n## Codex runner: not landed, left for the Claude worker\n\n1 Codex attempt(s) did not pass the checks`;
  assert.equal(r.isCodexBounce(crashNote), false, 'old crash notes (with the marker) no longer ban the card');
  assert.equal(r.isCodexBounce(realBounce), true);
  const now = Date.parse('2026-10-15T15:00:00Z');
  assert.equal(r.codexBouncedRecently([{ createdAt: '2026-10-15T07:43:00Z', body: crashNote }], now), false);
  assert.equal(r.codexBouncedRecently([{ createdAt: '2026-10-15T07:43:00Z', body: realBounce }], now), true);
  const base = { startedMs: now, nowMs: now, maxMinutes: 105, rejectStreak: 0, doneRefusals: 0 };
  assert.equal(r.stopReason({ ...base, crashStreak: 1 }), null);
  assert.match(r.stopReason({ ...base, crashStreak: 2, lastCrash: 'No space left on device' }), /2 runner errors in a row.*No space left/);
  assert.match(r.stopReason({ ...base, freeDiskBytes: 1.2e9 }), /1\.2 GB of disk left/);
  assert.equal(r.stopReason({ ...base, freeDiskBytes: 20e9 }), null);
  const { cloudPriorAttempts } = require('../../scripts/lib/cloud-worker-pick.js');
  assert.equal(cloudPriorAttempts({ comments: { nodes: [{ body: crashNote }, { body: realBounce }] } }), 1);
});
