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
  assert.equal(broad.skip, 'too-broad');
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
