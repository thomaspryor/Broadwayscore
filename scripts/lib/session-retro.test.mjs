// session-retro.js (BRO-7629 item 6): hard signals from a transcript; no false hits on prose.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const R = createRequire(import.meta.url)('./session-retro.js');

const ev = (o) => JSON.stringify({ sessionId: 's1', ...o });
const tool = (name, input, t) => ev({ type: 'assistant', timestamp: t, message: { content: [{ type: 'tool_use', name, input }] } });
const result = (text, t) => ev({ type: 'user', timestamp: t, message: { content: [{ type: 'tool_result', content: text }] } });
const err = (text, t) => ev({ type: 'user', timestamp: t, message: { content: [{ type: 'tool_result', content: text, is_error: true }] } });

test('counts land refusals, hook blocks, bypasses, restarts, reruns, long waits, and flags the thresholds', () => {
  const lines = [
    ev({ type: 'user', timestamp: '2026-01-01T00:00:00Z', message: { content: 'the land was REFUSED: land/x in the brief, plain prose' } }),
    tool('Edit', { file_path: 'a' }, '2026-01-01T00:01:00Z'),
    tool('Bash', { command: 'git push origin HEAD:refs/heads/land/x # NO-VERIFY: because' }, '2026-01-01T00:02:00Z'),
    tool('Bash', { command: 'grep NO-VERIFY: file' }, '2026-01-01T00:02:30Z'),
    result('12:00:00Z REFUSED: land/x unit-tests-node failed', '2026-01-01T00:40:00Z'),
    ev({ type: 'user', timestamp: '2026-01-01T00:41:00Z', message: { content: 'Stop hook feedback: [VE:CLEARCLOSE] x' } }),
    ev({ type: 'user', timestamp: '2026-01-01T00:42:00Z', message: { content: 'This session\'s worker process was restarted.' } }),
    ...[1, 2, 3].map((i) => tool('Bash', { command: 'npm run flaky-thing' }, `2026-01-01T03:0${i}:00Z`)),
  ];
  const r = R.analyze(lines);
  assert.equal(r.landRefusals.length, 1, 'tool output only, not the prose');
  assert.deepEqual(r.bypasses, { 'NO-VERIFY': 1 }, 'a push bypass counts, a grep does not');
  assert.equal(r.hookBlocks['[VE:CLEARCLOSE]'], 1);
  assert.equal(r.restarts, 1);
  assert.equal(r.repeats[0].times, 3);
  assert.ok(r.longWaits.length >= 1);
  assert.ok(r.hours > 2);
  assert.equal(r.landPushes, 1);
  assert.deepEqual(r.triggers, ['1 land refusal(s)', '1 container restart(s)'], 'the old 2h and 3-block thresholds no longer fire (BRO-7645)');
});

test('a clean short session crosses no threshold', () => {
  const r = R.analyze([tool('Edit', {}, '2026-01-01T00:00:00Z'), result('ok', '2026-01-01T00:05:00Z')]);
  assert.deepEqual(r.triggers, []);
});

test('weekly rollup counts repeated signals and runs once per week with --if-due', () => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'retro-'));
  const ledger = path.join(dir, 'l.jsonl');
  try {
    const now = new Date().toISOString();
    for (const id of ['a', 'b', 'c']) fs.appendFileSync(ledger, JSON.stringify({ sessionId: id, endAt: now, recordedAt: now, signals: ['hook:[VE:X]', id === 'a' ? 'restart' : 'hook:[VE:Y]'] }) + '\n');
    const out = [];
    const top = R.rollup(7, false, { ledger, ifDue: true, log: (m) => out.push(m) });
    assert.equal(top[0][0], 'hook:[VE:X]');
    assert.equal(top[0][1], 3);
    assert.equal(R.rollup(7, false, { ledger, ifDue: true, log: () => {} }), -1, 'second run in the week is skipped');
  } finally { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test('a failed card filing does not write the weekly marker, so the next run retries', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'retro-'));
  try {
    const ledger = path.join(dir, 'l.jsonl');
    const row = (id) => JSON.stringify({ sessionId: id, endAt: new Date().toISOString(), signals: ['restart'] });
    fs.writeFileSync(ledger, row('a') + '\n' + row('b') + '\n');
    const out = [];
    R.rollup(7, true, { ledger, ifDue: true, log: (m) => out.push(m), spawn: () => ({ status: 1, stdout: '' }) });
    assert.ok(out.some((m) => /card filing failed/.test(m)));
    assert.ok(!fs.readFileSync(ledger, 'utf8').includes('"rollup":true'), 'marker must not be written after a failure');
    R.rollup(7, true, { ledger, ifDue: true, log: () => {}, spawn: () => ({ status: 0, stdout: 'BRO-1' }) });
    assert.ok(fs.readFileSync(ledger, 'utf8').includes('"rollup":true'));
  } finally { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); }
});

test('echoes in tool output, heredoc pushes and malformed lines are not signals (ship-check review)', () => {
  const line = (o) => JSON.stringify(o);
  const ts = (m) => `2026-11-17T01:${String(m).padStart(2, '0')}:00Z`;
  const lines = [
    'null', '{"type":"user","message":{"content":[null]}}',
    line({ type: 'user', timestamp: ts(1), message: { content: [{ type: 'tool_result', content: 'Hook blocks: [VE:CLEARCLOSE] Stop hook feedback worker process was restarted' }] } }),
    line({ type: 'user', timestamp: ts(2), message: { content: [{ type: 'tool_result', content: '      // wait-for-land.js "REFUSED: land/x" in source' }] } }),
    line({ type: 'assistant', timestamp: ts(3), message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: "python3 - <<'E'\nx='git push # NO-VERIFY: because'\nE" } }] } }),
    line({ type: 'attachment', timestamp: ts(4), attachment: { type: 'hook_blocking_error' } }),
    line({ type: 'user', timestamp: ts(5), message: { content: 'Stop hook feedback: [VE:CLEARCLOSE] fix it' } }),
    // BRO-7749: a compaction summary quotes earlier blocks ("Stop hook feedback ... [VE:LIVERUN]"); it is not a block.
    line({ type: 'user', isCompactSummary: true, timestamp: ts(6), message: { content: 'Summary: fixture has a "Stop hook feedback ... [VE:LIVERUN]" message.' } }),
  ];
  const r = R.analyze(lines);
  assert.equal(r.restarts, 0);
  assert.equal(r.landRefusals.length, 0);
  assert.deepEqual(r.bypasses, {});
  assert.deepEqual(r.hookBlocks, { unclassified: 1, '[VE:CLEARCLOSE]': 1 }, 'one attachment plus one real feedback message');
});

test('hook blocks are labelled by the real hook, never the generic hook:hook (BRO-7645)', () => {
  const att = (a) => JSON.stringify({ type: 'attachment', timestamp: '2026-01-01T00:03:00Z', attachment: { type: 'hook_blocking_error', ...a } });
  const r = R.analyze([
    att({ hookName: 'PreToolUse:Bash', blockingError: { blockingError: 'x', command: 'H="$R/.claude/hooks/pre-push-land-preflight.sh"; bash $H' } }),
    att({ blockingError: { blockingError: 'BLOCKED\n[VE:RCOV]' } }),
    att({ hookName: 'PostToolUse:Edit' }),
    att({}),
  ]);
  assert.deepEqual(r.hookBlocks, { 'pre-push-land-preflight.sh': 1, '[VE:RCOV]': 1, 'PostToolUse:Edit': 1, unclassified: 1 });
  assert.ok(!R.signals(r).some((s) => /hook:(hook|unclassified)$/.test(s)), 'generic labels are not rollup signals');
  assert.ok(R.signals(r).includes('hook:pre-push-land-preflight.sh'));
});

test('--check thresholds flag outliers only, against the real ledger shape', () => {
  assert.deepEqual(R.triggersFor({ activeHours: 2.9, hookBlockCount: 12, restarts: 0, bypassCount: 1, landRefusalCount: 0 }), []);
  assert.equal(R.triggersFor({ activeHours: 5, hookBlockCount: 15, restarts: 0, bypassCount: 2, landRefusalCount: 1 }).length, 4);
  // The 9 sessions of the first 15h (2026-11-17, wall-clock hours, hook blocks, restarts): the old 2h/3-block pair flagged all 9.
  const legacy = [[1.88, 7, 1], [2.86, 12, 0], [1.71, 6, 0], [2.09, 5, 0], [2.41, 12, 0], [2.41, 8, 0], [25.58, 24, 0], [11.65, 25, 0], [11.51, 21, 0]];
  const flagged = legacy.filter(([h, b, r]) => R.triggersFor({ activeHours: h, hookBlockCount: b, restarts: r, bypassCount: 0, landRefusalCount: 0 }).length);
  assert.equal(flagged.length, 4, 'outliers only: 3 long, loud sessions plus the restart');
});

test('--fixes and --no-action are validated; retroStatus closes only with a link or reason', () => {
  assert.deepEqual(R.parseLinks({ fixes: 'BRO-7652, abc1234' }), { links: ['BRO-7652', 'abc1234'], noAction: null, error: null });
  assert.match(R.parseLinks({ fixes: 'later' }).error, /BRO-N ids or commit shas/);
  assert.match(R.parseLinks({ 'no-action': 'none' }).error, /real reason/);
  assert.match(R.parseLinks({ 'no-action': true }).error, /real reason/);
  assert.equal(R.parseLinks({ 'no-action': 'a 2h wall clock from an idle owner, nothing to fix' }).error, null);
  const rows = [
    { v: 2, sessionId: 'a', triggers: ['3 hook blocks'], links: [] },
    { v: 2, sessionId: 'a', triggers: ['3 hook blocks'], links: ['BRO-1'] },
    { v: 2, sessionId: 'b', triggers: ['x'], links: [] },
    { sessionId: 'c', triggers: [] },
  ];
  assert.equal(R.retroStatus(rows, 'a').closed, true, 'latest row per session wins');
  assert.equal(R.retroStatus(rows, 'b').closed, false);
  assert.equal(R.retroStatus(rows, 'c').closed, true, 'unflagged needs nothing');
  assert.equal(R.retroStatus(rows, 'zzz').recorded, false);
});

test('hookLabel ignores scripts mentioned in free text; active hours skip owner idle after the first edit (BRO-7645)', () => {
  assert.equal(R.hookLabel('Stop hook feedback: run node scripts/lib/x.js, Next.js'), 'unclassified');
  assert.equal(R.hookLabel({ hookName: 'PreToolUse:Bash', blockingError: { blockingError: 'run node scripts/lib/x.js' } }), 'PreToolUse:Bash');
  const t = (m) => `2026-01-01T${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}:00Z`;
  const r = R.analyze([
    JSON.stringify({ type: 'user', timestamp: t(0), message: { content: 'go' } }),
    tool('Edit', {}, t(180)),
    JSON.stringify({ type: 'user', timestamp: t(240), message: { content: 'ok' } }),
    tool('Bash', { command: 'node -v' }, t(360)),
  ]);
  assert.equal(r.hours, 3);
  assert.equal(r.activeHours, 2, 'owner idle after the first edit is subtracted, the wait before it is not');
});

test('no-action reasons: natural text passes, bare placeholders fail; v1 rows are history', () => {
  assert.equal(R.parseLinks({ 'no-action': 'Nothing needs a fix: owner idle for 3 hours' }).error, null);
  assert.match(R.parseLinks({ 'no-action': 'nothing' }).error, /real reason/);
  assert.equal(R.retroStatus([{ sessionId: 'x', triggers: ['3 hook blocks'] }], 'x').closed, true, 'a v1 row is history');
  assert.equal(R.retroStatus([{ v: 2, sessionId: 'x', triggers: ['3 hook blocks'] }], 'x').closed, false);
});

test('bare --check honours a row already recorded with links; unrecorded stays exit 10 (BRO-7645)', async () => {
  const { spawnSync } = await import('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'retro-cli-'));
  const tr = path.join(dir, 't.jsonl');
  const ledger = path.join(dir, 'ledger.jsonl');
  const lines = [tool('Edit', { file_path: 'a' }, '2026-01-01T00:00:00Z'), result('12:00:00Z REFUSED: land/x unit-tests-node failed', '2026-01-01T00:10:00Z')];
  fs.writeFileSync(tr, lines.join('\n') + '\n');
  const run = (...a) => spawnSync('node', [path.join(path.dirname(new URL(import.meta.url).pathname), 'session-retro.js'), `--transcript=${tr}`, ...a], { env: { ...process.env, SESSION_RETRO_LEDGER: ledger }, encoding: 'utf8' });
  assert.equal(run('--check').status, 10, 'flagged and unrecorded');
  assert.equal(run('--check', '--record', '--fixes=BRO-1234').status, 0, 'recorded with a link');
  assert.equal(run('--check').status, 0, 'a later bare --check sees the closed row');
});

test('--json output stays parseable even when the session already has a closed row (BRO-7645)', async () => {
  const { spawnSync } = await import('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'retro-json-'));
  const tr = path.join(dir, 't.jsonl');
  const ledger = path.join(dir, 'ledger.jsonl');
  fs.writeFileSync(tr, [tool('Edit', { file_path: 'a' }, '2026-01-01T00:00:00Z'), result('12:00:00Z REFUSED: land/x unit-tests-node failed', '2026-01-01T00:10:00Z')].join('\n') + '\n');
  const run = (...a) => spawnSync('node', [path.join(path.dirname(new URL(import.meta.url).pathname), 'session-retro.js'), `--transcript=${tr}`, ...a], { env: { ...process.env, SESSION_RETRO_LEDGER: ledger }, encoding: 'utf8' });
  assert.equal(run('--record', '--fixes=BRO-1234').status, 0);
  const out = run('--json', '--check');
  assert.equal(out.status, 0);
  assert.doesNotThrow(() => JSON.parse(out.stdout));
});

test('PreToolUse blocks count (is_error only), the land preflight is a hook block, git-check stop blocks are labelled (BRO-7701)', () => {
  const stop = (text, t) => ev({ type: 'user', timestamp: t, message: { content: text } });
  const r = R.analyze([
    tool('Edit', {}, '2026-01-01T00:00:00Z'),
    err('PreToolUse:Bash hook error: [command hook 5]: LAND BLOCKED (BRO-5359): this push lands 41 lines of code but the session has no complete review yet.', '2026-01-01T00:01:00Z'),
    err('PreToolUse:mcp__claude-code-remote__create_session hook error: Blocked: create_session needs an explicit model', '2026-01-01T00:02:00Z'),
    err('PreToolUse:mcp__claude_ai_Linear__save_issue hook error: no', '2026-01-01T00:02:30Z'),
    err('PreToolUse:Bash hook error: [VE:WTX] blocked', '2026-01-01T00:03:00Z'),
    stop("Stop hook feedback:\n[command hook 3]: There are 1 unpushed commit(s) on branch 'x'.", '2026-01-01T00:04:00Z'),
    result('grep output: PreToolUse:Bash hook error: LAND BLOCKED quoted mid-text', '2026-01-01T00:05:00Z'),
    result('PreToolUse:Bash hook error: a cat of an old log, not an error', '2026-01-01T00:06:00Z'),
  ]);
  assert.deepEqual(r.hookBlocks, { 'pre:land-preflight': 1, 'pre:create_session': 1, 'pre:save_issue': 1, '[VE:WTX]': 1, 'git-check': 1 });
  assert.equal(r.landRefusals.length, 0, 'the review gate doing its job is not a refused landing');
  const both = R.analyze([
    tool('Edit', {}, '2026-01-01T00:00:00Z'),
    stop("Stop hook feedback:\n[command hook 2]: [VE:RCOV] x\n[command hook 3]: There are 2 unpushed commit(s) on branch 'x'.", '2026-01-01T00:04:00Z'),
  ]);
  assert.deepEqual(both.hookBlocks, { '[VE:RCOV]': 1, 'git-check': 1 }, 'an uncoded git hook in the same message as a coded one still counts');
});

// BRO-7749: advisory Stop-gate activity reaches the committed row (the gate logs live in a container that is reclaimed).
import { spawnSync } from 'node:child_process';
const SR = path.join(path.dirname(new URL(import.meta.url).pathname), 'session-retro.js');
const rawUse = (id, name, input, t) => JSON.stringify({ sessionId: 'parent-id', type: 'assistant', timestamp: t, message: { content: [{ type: 'tool_use', id, name, input }] } });
const rawRes = (id, text, t) => JSON.stringify({ sessionId: 'parent-id', type: 'user', timestamp: t, message: { content: [{ type: 'tool_result', tool_use_id: id, content: text }] } });
// The live-run incident shape: edit a script a workflow runs, land, never run it live. The workflows come from a fixture
// root (SESSION_RETRO_REPO_ROOT) so a rename in the real .github/workflows cannot turn this red.
const fixtureRoot = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-root-'));
  fs.mkdirSync(path.join(root, '.github', 'workflows'), { recursive: true });
  fs.writeFileSync(path.join(root, '.github', 'workflows', 'metrics.yml'), 'jobs:\n  m:\n    steps:\n      - run: node scripts/account-metrics.js\n');
  return root;
};
const liveRunIncident = [
  rawUse('a', 'Edit', { file_path: '/home/user/Broadwayscore/.claude/worktrees/x/scripts/account-metrics.js', old_string: 'a', new_string: 'b' }, '2026-11-18T00:00:00Z'),
  rawRes('a', 'ok', '2026-11-18T00:00:01Z'),
  rawUse('b', 'Bash', { command: 'git push origin HEAD:refs/heads/land/x' }, '2026-11-18T00:01:00Z'),
  rawRes('b', 'ok', '2026-11-18T00:01:30Z'),
  JSON.stringify({ sessionId: 'parent-id', type: 'user', timestamp: '2026-11-18T00:02:00Z', message: { content: 'Stop hook feedback:\n[command hook 2]: Not run live.\n[VE:LIVERUN]' } }),
];

test('BRO-7749: a session that hit [VE:LIVERUN] ends with a retro row carrying the hit (nudge, over-budget log line, record-time dry run)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-gates-'));
  const tr = path.join(dir, 'child-id.jsonl'); // the hook's session_id is the transcript basename, not the first sessionId row
  const ledger = path.join(dir, 'ledger.jsonl');
  const cache = path.join(dir, 'cache');
  fs.mkdirSync(cache);
  fs.writeFileSync(tr, liveRunIncident.join('\n') + '\n');
  fs.writeFileSync(path.join(cache, 'live-run-stop.log'), [
    { ts: '2026-11-18T00:02:00Z', session: 'child-id', blocked: true, reason: 'not run live: scripts/account-metrics.js' },
    { ts: '2026-11-18T00:03:00Z', session: 'child-id', blocked: false, reason: 'not run live: scripts/account-metrics.js' },
    { ts: '2026-11-18T00:03:00Z', session: 'someone-else', blocked: false, reason: 'x' },
  ].map((o) => JSON.stringify(o)).join('\n') + '\nnot json\n');
  const env = { ...process.env, SESSION_RETRO_LEDGER: ledger, SESSION_RETRO_CACHE_DIR: cache, SESSION_RETRO_REPO_ROOT: fixtureRoot(), CLAUDE_CODE_REMOTE: 'true' };
  const out = spawnSync('node', [SR, `--transcript=${tr}`, '--record', '--no-action=fixture session for the gate fold'], { env, encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr);
  const row = JSON.parse(fs.readFileSync(ledger, 'utf8').trim().split('\n').pop());
  const g = row.gates['[VE:LIVERUN]'];
  assert.equal(g.blocks, 1, 'the nudge in the transcript');
  assert.equal(g.logged, 2, 'both of this session\'s log lines');
  assert.equal(g.overBudget, 1, 'the logged hit after the budget ran out; another session\'s line is not ours');
  assert.equal(g.wouldBlock, true, 'the gate\'s own decision at record time');
  assert.match(g.reason, /account-metrics\.js/);
  assert.match(out.stdout, /Stop gate \[VE:LIVERUN\] would block a close now/);
  // A local session: the gates never run there, so the dry run must not claim a hit either.
  const local = spawnSync('node', [SR, `--transcript=${tr}`, '--record', '--no-action=fixture session for the gate fold'], { env: { ...env, CLAUDE_CODE_REMOTE: '' }, encoding: 'utf8' });
  assert.equal(local.status, 0, local.stderr);
  const lrow = JSON.parse(fs.readFileSync(ledger, 'utf8').trim().split('\n').pop());
  assert.equal(lrow.gates['[VE:LIVERUN]'].wouldBlock, false);
  assert.equal(lrow.gatesErrors, undefined, 'a clean measurement carries no gatesErrors');
});

test('BRO-7749: wrap-up order (--record BEFORE the final land push): the dry run still judges the change as landed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-order-'));
  const tr = path.join(dir, 'sess.jsonl');
  const ledger = path.join(dir, 'l.jsonl');
  fs.writeFileSync(tr, liveRunIncident.slice(0, 2).join('\n') + '\n'); // edited, not landed yet, no nudge yet
  const env = { ...process.env, SESSION_RETRO_LEDGER: ledger, SESSION_RETRO_CACHE_DIR: path.join(dir, 'none'), SESSION_RETRO_REPO_ROOT: fixtureRoot(), CLAUDE_CODE_REMOTE: 'true' };
  const out = spawnSync('node', [SR, `--transcript=${tr}`, '--record', '--no-action=fixture session for the gate fold'], { env, encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr);
  const g = JSON.parse(fs.readFileSync(ledger, 'utf8').trim()).gates['[VE:LIVERUN]'];
  assert.deepEqual({ blocks: g.blocks, logged: g.logged, wouldBlock: g.wouldBlock }, { blocks: 0, logged: 0, wouldBlock: true });
});

test('BRO-7749: a gate that cannot be measured is recorded as gatesErrors, not as clean', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-err-'));
  const tr = path.join(dir, 'sess.jsonl');
  const ledger = path.join(dir, 'l.jsonl');
  fs.writeFileSync(tr, liveRunIncident.slice(0, 2).join('\n') + '\n');
  const env = { ...process.env, SESSION_RETRO_LEDGER: ledger, SESSION_RETRO_CACHE_DIR: dir, SESSION_RETRO_REPO_ROOT: path.join(dir, 'no-such-root'), CLAUDE_CODE_REMOTE: 'true' };
  const out = spawnSync('node', [SR, `--transcript=${tr}`, '--record', '--no-action=fixture session for the gate fold'], { env, encoding: 'utf8' });
  assert.equal(out.status, 0, 'a measuring error never fails the retro');
  const row = JSON.parse(fs.readFileSync(ledger, 'utf8').trim());
  assert.match(row.gatesErrors.join(' '), /\[VE:LIVERUN\]/);
});

test('BRO-7749: a clean session records gates {} (measured, nothing hit); rollup prints per-gate counts and only the latest row per session', () => {
  assert.deepEqual(R.mergeGateActivity({}, {}, {}), {});
  assert.deepEqual(R.mergeGateActivity({ '[VE:CLEARCLOSE]': 2 }, {}, {}), {}, 'gates outside STOP_GATES are not folded (they already reach signals)');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-roll-'));
  const ledger = path.join(dir, 'l.jsonl');
  const now = new Date().toISOString();
  fs.writeFileSync(ledger, [
    { sessionId: 'a', endAt: now, gates: { '[VE:LIVERUN]': { blocks: 1, overBudget: 0, wouldBlock: true, reason: 'not run live: scripts/x.js' } } },
    { sessionId: 'b', endAt: now, gates: { '[VE:LIVERUN]': { blocks: 0, overBudget: 2, wouldBlock: false } } },
    { sessionId: 'b', endAt: now, gates: {} },
    { sessionId: 'c', endAt: now },
  ].map((o) => JSON.stringify(o)).join('\n') + '\n');
  const lines = [];
  R.rollup(7, false, { ledger, log: (s) => lines.push(s) });
  const text = lines.join('\n');
  assert.match(text, /Stop gates \(BRO-7749\): 2 session\(s\) measured/, 'a legacy row without gates is not measured; b counts once (latest row)');
  assert.match(text, /\[VE:LIVERUN\]: active in 1 of 2 sessions; nudged in 1, would block at record in 1; 0 over-budget hit\(s\)/);
  assert.match(text, /e\.g\. not run live: scripts\/x\.js/);
});

test('BRO-7749: every Stop gate that logs to .cache/<x>-stop.log is in STOP_GATES (a new advisory gate cannot be left out)', () => {
  const dir = path.dirname(new URL(import.meta.url).pathname);
  const logged = new Set();
  for (const f of fs.readdirSync(dir).filter((x) => /\.(mjs|js)$/.test(x) && !/\.test\./.test(x))) {
    for (const m of fs.readFileSync(path.join(dir, f), 'utf8').matchAll(/'([a-z-]+-stop)\.log'/g)) logged.add(m[1]);
  }
  assert.ok(logged.size >= 4, 'found the gate logs');
  assert.deepEqual([...logged].filter((l) => !R.STOP_GATES.some((g) => g.log === l)), []);
});

test('BRO-7872: --record writes the skeptic outcome (runs, gaps found/answered, errors) into the ledger row', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'retro-skeptic-'));
  const file = path.join(dir, 'sess.jsonl');
  const ledger = path.join(dir, 'ledger.jsonl');
  const row = (o) => JSON.stringify({ sessionId: 'sess', timestamp: '2026-11-19T20:00:00Z', ...o });
  const gaps = 'SKEPTIC REVIEW: 2 material gap(s).\n1. a (b)\n   check: node scripts/x.js\n2. c (d)\n   check: node scripts/x.js --all';
  fs.writeFileSync(file, [
    row({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', id: 'k1', input: { command: 'node scripts/lib/skeptic-review-stop.mjs --ship-check' } }] } }),
    row({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'k1', content: gaps }] } }),
    row({ type: 'assistant', message: { content: [{ type: 'text', text: 'GAP 2: cannot run here: the full run sends real email to subscribers' }] } }),
  ].join('\n') + '\n');
  const r = spawnSync('node', [path.join(path.dirname(new URL(import.meta.url).pathname), 'session-retro.js'), '--record', '--no-action=test fixture only', `--transcript=${file}`],
    { encoding: 'utf8', env: { ...process.env, SESSION_RETRO_LEDGER: ledger } });
  assert.equal(r.status, 0, r.stderr);
  const rec = JSON.parse(fs.readFileSync(ledger, 'utf8').trim().split('\n').pop());
  assert.deepEqual(rec.skeptic, { runs: 1, gapsFound: 2, gapsAnswered: 1, errors: 0 });
  fs.rmSync(dir, { recursive: true, force: true });
});
