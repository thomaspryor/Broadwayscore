// BRO-4745: decisions of the daily unattended Codex runner (scripts/codex/daily-runner.js).
// Requires the real helpers (CLAUDE.md §15), never a copy.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const r = require('../../scripts/lib/codex-runner.js');

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

test('nextStep: only a clean SHIP lands; one fix round then bounce', () => {
  assert.equal(r.nextStep({ verdict: 'SHIP', hasDiff: true, attempt: 1 }), 'land');
  assert.equal(r.nextStep({ verdict: 'SHIP', hasDiff: false, attempt: 1 }), 'close-already-fixed');
  assert.equal(r.nextStep({ verdict: 'SHIP-WITH-FIXES', hasDiff: true, attempt: 1 }), 'fix-round');
  assert.equal(r.nextStep({ verdict: 'NONE', hasDiff: true, attempt: 1 }), 'fix-round');
  assert.equal(r.nextStep({ verdict: 'REJECT', hasDiff: true, attempt: 2 }), 'bounce');
  assert.equal(r.nextStep({ verdict: 'SHIP', hasDiff: true, attempt: 2 }), 'land');
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

test('fillPrompt fills every placeholder, repeatedly', () => {
  const out = r.fillPrompt('{{ID}} {{TITLE}}\n{{BODY}}\n{{EXTRA}} {{ID}}', { id: 'BRO-1', title: 'T', body: 'B' });
  assert.equal(out, 'BRO-1 T\nB\n BRO-1');
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
