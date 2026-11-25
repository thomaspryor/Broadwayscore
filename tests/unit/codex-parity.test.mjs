// BRO-4745: Codex must run under the same guards, checklists and reach as Claude.
// These tests fail when the Codex side drifts from the Claude side.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const adapter = require('../../scripts/codex/hook-adapter.js');
const { diffSkills, renderSkills } = require('../../scripts/codex/sync-skills.js');
const { mergeToml, unmergeToml, mergeHooks } = require('../../scripts/codex/install.js');
// End-to-end runs use only the repo's hooks and a private shadow dir, so a
// developer's own ~/.claude hooks never run inside the test.
const ISOLATED_ENV = { ...process.env, CODEX_HOOK_ADAPTER_USER_SETTINGS: '/nonexistent/settings.json',
  CODEX_HOOK_ADAPTER_SHADOW_DIR: mkdtempSync(join(tmpdir(), 'codex-shadow-test-')),
  // A fresh HOME too: the repo's guard copies skip themselves when ~/.claude/hooks has the master
  // copy (BRO-4238), so on a Mac with ~/.claude the isolated run had no guard and failed locally.
  HOME: mkdtempSync(join(tmpdir(), 'codex-parity-home-')) };
const settings = JSON.parse(readFileSync(join(ROOT, '.claude', 'settings.json'), 'utf8'));
const codexHooks = JSON.parse(readFileSync(join(ROOT, '.codex', 'hooks.json'), 'utf8'));

// Codex 0.160 hook events (learn.chatgpt.com/docs/hooks).
const CODEX_EVENTS = new Set(['SessionStart', 'SessionEnd', 'SubagentStart', 'SubagentStop', 'PreToolUse',
  'PermissionRequest', 'PostToolUse', 'PreCompact', 'PostCompact', 'UserPromptSubmit', 'Stop', 'Interrupt']);

test('every Claude hook event Codex supports is routed to the adapter', () => {
  for (const event of Object.keys(settings.hooks || {})) {
    if (!CODEX_EVENTS.has(event)) continue;
    const groups = codexHooks.hooks[event] || [];
    const routed = groups.some((g) => (g.hooks || []).some((h) => h.command.includes('scripts/codex/hook-adapter.js') && h.command.includes(`--event ${event}`)));
    assert.ok(routed, `.codex/hooks.json has no adapter entry for ${event}`);
  }
});

test('committed .agents/skills match the Claude sources (run scripts/codex/sync-skills.js)', () => {
  const { stale, extra } = diffSkills(ROOT);
  assert.deepEqual({ stale, extra }, { stale: [], extra: [] });
  const names = [...renderSkills(ROOT).keys()].filter((k) => k.endsWith('/SKILL.md')).map((k) => k.split('/')[0]);
  for (const must of ['ship-check', 'did-it-work', 'what-else', 'wrap-up', 'visual-qa']) assert.ok(names.includes(must), must);
});

test('apply_patch becomes one Claude Edit/Write event per file', () => {
  const patch = '*** Begin Patch\n*** Add File: a/new.js\n+one\n+two\n*** Update File: b/old.js\n@@\n-x\n+y\n*** Delete File: c/gone.js\n*** End Patch';
  const evs = adapter.toClaudeToolEvents('apply_patch', { command: patch });
  assert.deepEqual(evs.map((e) => [e.tool_name, e.tool_input.file_path]), [['Write', 'a/new.js'], ['Edit', 'b/old.js'], ['Edit', 'c/gone.js']]);
  assert.equal(evs[0].tool_input.content, 'one\ntwo');
  assert.equal(evs[1].tool_input.new_string, 'y');
  // A move reports both the source and the destination.
  const mv = adapter.toClaudeToolEvents('apply_patch', { command: '*** Begin Patch\n*** Update File: x.js\n*** Move to: y.js\n*** End Patch' });
  assert.deepEqual(mv.map((e) => e.tool_input.file_path), ['x.js', 'y.js']);
  assert.deepEqual(adapter.toClaudeToolEvents('Bash', { command: 'ls' }), [{ tool_name: 'Bash', tool_input: { command: 'ls' } }]);
  // Relative patch paths resolve against the session cwd, as Claude's Edit/Write carry absolute paths.
  const abs = adapter.toClaudeToolEvents('apply_patch', { command: '*** Begin Patch\n*** Update File: src/a.ts\n*** Update File: /abs/b.ts\n*** End Patch' }, '/repo/wt');
  assert.deepEqual(abs.map((e) => e.tool_input.file_path), ['/repo/wt/src/a.ts', '/abs/b.ts']);
});

test('user-level and project Claude hooks both run, identical commands once', () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-parity-'));
  const user = join(dir, 'user.json');
  const proj = join(dir, 'proj.json');
  writeFileSync(user, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'user-only.sh' }, { type: 'command', command: 'shared.sh' }] }] } }));
  writeFileSync(proj, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'shared.sh' }, { type: 'command', command: 'proj-only.sh' }] }] } }));
  const merged = adapter.loadSettings([user, join(dir, 'missing.json'), proj]);
  assert.deepEqual(adapter.claudeHooksFor(merged, 'Stop').map((h) => h.command), ['user-only.sh', 'shared.sh', 'proj-only.sh']);
});

test('a pending call is shown at PreToolUse but only persisted with its result', () => {
  const payload = { tool_use_id: 'c1', tool_response: 'ok' };
  const evs = [{ tool_name: 'Edit', tool_input: { file_path: '/x' } }];
  assert.deepEqual(adapter.toolRows(payload, evs, false).map((r) => r.kind), ['tool_use']);
  assert.deepEqual(adapter.toolRows(payload, evs, true).map((r) => r.kind), ['tool_use', 'tool_result']);
});

test('Claude matchers apply to the translated tool name', () => {
  assert.ok(adapter.matcherMatches('Bash|Edit|Write|NotebookEdit', 'Edit'));
  assert.ok(!adapter.matcherMatches('Bash', 'apply_patch'));
  assert.ok(adapter.matcherMatches('', 'anything'));
  assert.ok(adapter.matcherMatches('startup|clear|compact|resume', 'startup'));
  const pre = adapter.claudeHooksFor(settings, 'PreToolUse', 'Bash').map((h) => h.command);
  assert.ok(pre.some((c) => c.includes('block-resend-broadcasts.sh')));
  assert.ok(pre.some((c) => c.includes('worktree-enforce.sh')));
});

test('blocking output is recognised in every form Claude hooks use', () => {
  assert.ok(adapter.blockingOutput({ status: 2, stderr: 'no' }));
  assert.ok(adapter.blockingOutput({ status: 0, stdout: '{"decision":"block","reason":"r"}' }));
  assert.ok(adapter.blockingOutput({ status: 0, stdout: '{"hookSpecificOutput":{"permissionDecision":"deny","permissionDecisionReason":"r"}}' }));
  assert.equal(adapter.blockingOutput({ status: 0, stdout: '{"systemMessage":"fyi"}' }), null);
  assert.equal(adapter.blockingOutput({ status: 1, stderr: 'crash' }), null); // non-blocking error, as in Claude
});

test('shadow transcript is Claude-shaped and time-ordered', () => {
  const lines = adapter.buildShadowLines(
    [{ ts: '2026-01-01T00:00:01Z', role: 'user', text: 'do it', id: 'm1' }, { ts: '2026-01-01T00:00:05Z', role: 'assistant', text: 'done', id: 'm2' }],
    [{ kind: 'tool_use', ts: '2026-01-01T00:00:02Z', id: 't1', name: 'Bash', input: { command: 'ls' } },
      { kind: 'tool_result', ts: '2026-01-01T00:00:03Z', id: 't1', content: 'a' }],
    'final words');
  assert.deepEqual(lines.map((l) => l.type), ['user', 'assistant', 'user', 'assistant', 'assistant']);
  assert.equal(lines[1].message.content[0].type, 'tool_use');
  assert.equal(lines[2].message.content[0].tool_use_id, 't1');
  assert.equal(lines[4].message.content[0].text, 'final words');
});

test('the adapter blocks a direct broadcast call end to end through the real Claude hook', () => {
  const host = ['api', 'resend', 'com'].join('.') + '/broad' + 'casts';
  const payload = { session_id: 'codex-parity-test', cwd: ROOT, hook_event_name: 'PreToolUse', tool_name: 'Bash',
    tool_input: { command: `echo https://${host}/x/send` }, tool_use_id: 't', transcript_path: '/nonexistent' };
  const res = spawnSync('node', [join(ROOT, 'scripts/codex/hook-adapter.js'), '--event', 'PreToolUse'], { input: JSON.stringify(payload), encoding: 'utf8', timeout: 120000, env: ISOLATED_ENV });
  assert.equal(res.status, 0);
  const out = JSON.parse(res.stdout.trim());
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /BROADCAST GUARD/);
});

test('runner profile: session gates are skipped, safety guards still run', () => {
  assert.equal(adapter.isRunnerProfile('/repo/.claude/worktrees/codex-runner'), true);
  assert.equal(adapter.isRunnerProfile('/repo'), false);
  assert.equal(adapter.isRunnerProfile('/repo/.claude/worktrees/codex-harness-fixes'), false);
  assert.equal(adapter.isRunnerProfile('/elsewhere/codex-runner'), false);
  const hook = (cmd) => ({ command: `H="$R/.claude/hooks/${cmd}"; bash "$H"` });
  for (const ev of ['Stop', 'SessionStart', 'PreCompact', 'UserPromptSubmit']) assert.equal(adapter.runnerSkipsHook(ev, hook('verify-edits.sh')), true, ev);
  assert.equal(adapter.runnerSkipsHook('PreToolUse', hook('pre-push-review-gate.sh')), true);
  // What a runner attempt still gets from the real settings: every tool guard but the push/merge gates.
  const kept = adapter.claudeHooksFor(settings, 'PreToolUse', 'Bash').filter((h) => !adapter.runnerSkipsHook('PreToolUse', h)).map((h) => h.command);
  for (const g of ['block-resend-broadcasts.sh', 'worktree-enforce.sh', 'infra-plan-review-gate.sh', 'check-skill-redaction.sh']) {
    assert.ok(kept.some((c) => c.includes(g)), `${g} still runs for the runner`);
  }
  for (const g of ['pre-push-review-gate.sh', 'pre-push-visual-gate.sh', 'pre-push-land-preflight.sh', 'pre-merge-review-gate.sh']) {
    assert.ok(!kept.some((c) => c.includes(g)), `${g} skipped for the runner`);
  }
  // The default reads the adapter's own location, so it matches wherever this test runs
  // (the runner's land checks run it from the runner worktree itself).
  assert.equal(adapter.isRunnerProfile(), adapter.isRunnerProfile(ROOT));
});

test('an apply_patch the adapter cannot read is refused, not waved through', () => {
  const payload = { session_id: 'codex-parity-test', cwd: ROOT, hook_event_name: 'PreToolUse', tool_name: 'apply_patch',
    tool_input: { command: 'not a patch' }, tool_use_id: 't2', transcript_path: '/nonexistent' };
  const res = spawnSync('node', [join(ROOT, 'scripts/codex/hook-adapter.js'), '--event', 'PreToolUse'], { input: JSON.stringify(payload), encoding: 'utf8', timeout: 60000, env: ISOLATED_ENV });
  assert.equal(JSON.parse(res.stdout.trim()).hookSpecificOutput.permissionDecision, 'deny');
  // A bare-string envelope is still read.
  assert.equal(adapter.toClaudeToolEvents('apply_patch', '*** Begin Patch\n*** Add File: x.js\n+a\n*** End Patch', '/r').length, 1);
});

test('a guard that leaves a background child behind still resolves on time', async () => {
  const t0 = Date.now();
  const res = await adapter.runHook({ command: '(setsid sleep 8 &) ; exit 0' }, {}, process.env, ROOT, 3000);
  assert.ok(Date.now() - t0 < 2500, `took ${Date.now() - t0}ms`);
  assert.equal(res.status, 0);
  const slow = await adapter.runHook({ command: 'sleep 8' }, {}, process.env, ROOT, 1000);
  assert.equal(slow.timedOut, true);
});

test('failed calls are marked is_error, as Claude marks them', () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-parity-'));
  const rollout = join(dir, 'rollout.jsonl');
  writeFileSync(rollout, JSON.stringify({ type: 'event_msg', payload: { type: 'item_completed', item: { id: 'exec-1', status: 'failed', exit_code: 2 } } }) + '\n');
  assert.equal(adapter.callFailed({ tool_use_id: 'exec-1', transcript_path: rollout, tool_response: 'ls: nope' }), true);
  assert.equal(adapter.callFailed({ tool_use_id: 'exec-9', transcript_path: rollout, tool_response: 'ok' }), undefined);
  assert.equal(adapter.callFailed({ tool_response: 'Exit code: 0\nOutput:\nSuccess.' }), false);
  const rows = adapter.toolRows({ tool_use_id: 'exec-1', tool_response: 'x' }, [{ tool_name: 'Bash', tool_input: {} }], true, true);
  const line = adapter.buildShadowLines([], rows, '').find((l) => l.message.content[0].type === 'tool_result');
  assert.equal(line.message.content[0].is_error, true);
  // Calls without an id still get distinct keys.
  const a = adapter.toolRows({ turn_id: 't', tool_name: 'Bash', tool_input: { command: 'a' } }, [{ tool_name: 'Bash', tool_input: {} }], false)[0].key;
  const b = adapter.toolRows({ turn_id: 't', tool_name: 'Bash', tool_input: { command: 'b' } }, [{ tool_name: 'Bash', tool_input: {} }], false)[0].key;
  assert.notEqual(a, b);
  assert.ok(adapter.blockingOutput({ status: 0, stdout: '{"hookSpecificOutput":{"permissionDecision":"ask"}}' }));
});

test('install merges into ~/.codex without clobbering hand-set values', () => {
  const repoToml = 'web_search = "live"\n\n[sandbox_workspace_write]\nnetwork_access = true\n';
  const original = '[projects."/x"]\ntrust_level = "trusted"\n';
  const fresh = mergeToml(original, repoToml);
  assert.match(fresh.text, /^web_search = "live" # bro-4745[^\n]*\n/);
  assert.match(fresh.text, /\[sandbox_workspace_write\] # bro-4745[^\n]*\nnetwork_access = true # bro-4745/);
  assert.equal(mergeToml(fresh.text, repoToml).text, fresh.text); // idempotent
  assert.equal(unmergeToml(fresh.text), original); // uninstall takes back exactly what was added
  // An existing table, with a trailing comment and indentation, gets the key, not a second header.
  const commented = mergeToml('web_search = "live"\n  [sandbox_workspace_write] # mine\nwritable_roots = []\n', repoToml);
  assert.equal(commented.text.match(/\[sandbox_workspace_write\]/g).length, 1);
  assert.match(commented.text, /# mine\nnetwork_access = true # bro-4745/);
  assert.equal(unmergeToml(commented.text), 'web_search = "live"\n  [sandbox_workspace_write] # mine\nwritable_roots = []\n');
  const handSet = mergeToml('web_search = "cached"\n', repoToml);
  assert.equal(handSet.conflicts.length, 1);
  assert.match(handSet.text, /web_search = "cached"/);
  // A table set inline or with dotted keys is left alone (adding [t] would break the file).
  for (const home of ['sandbox_workspace_write.network_access = false\n', 'sandbox_workspace_write = { network_access = false }\n']) {
    const r = mergeToml(home, repoToml);
    assert.ok(!r.text.includes('[sandbox_workspace_write]'), home);
    assert.ok(r.conflicts.some((c) => c.startsWith('[sandbox_workspace_write]')), home);
  }
  const merged = mergeHooks({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'mine.sh' }] }] } }, codexHooks);
  assert.ok(merged.hooks.Stop.some((g) => g.hooks.some((h) => h.command === 'mine.sh')));
  assert.equal(JSON.stringify(mergeHooks(merged, codexHooks)), JSON.stringify(merged)); // re-install replaces ours only
});

// BRO-7636: the unattended runner skips the push gates, so each one needs a named replacement, and a
// UI diff must not be able to reach a land/ push. These fail when the fix is reverted.
const runnerSrc = readFileSync(join(ROOT, 'scripts/codex/daily-runner.js'), 'utf8');
const runnerLib = require('../../scripts/lib/codex-runner.js');

test('every Claude hook the runner skips names a replacement that exists in the runner', () => {
  assert.deepEqual([...adapter.RUNNER_SKIPPED_TOOL_HOOKS].sort(), Object.keys(adapter.RUNNER_HOOK_REPLACEMENTS).sort());
  for (const [hook, sym] of Object.entries(adapter.RUNNER_HOOK_REPLACEMENTS)) {
    assert.ok(new RegExp(`\\b${sym}\\b`).test(runnerSrc), `${hook}: replacement ${sym} not found in daily-runner.js`);
  }
});

test('a UI diff is held, a data or script diff is not, and the runner holds no UI regex of its own', () => {
  const held = runnerLib.uiApprovalBlock(['src/components/BrowseListClient.tsx', 'data/shows.json']);
  assert.deepEqual(held.files, ['src/components/BrowseListClient.tsx']);
  assert.match(held.note, /visual-approval\.js request/);
  assert.match(runnerLib.uiApprovalBlock(['src/app/globals.css'], { pr: true }).note, /\/visual-qa/);
  assert.ok(runnerLib.uiApprovalBlock(['tailwind.config.js']));
  assert.equal(runnerLib.uiApprovalBlock(['scripts/a.js', 'data/shows.json', 'src/lib/scoring.ts']), null);
  // Reuses autonomous-checks.js isUiDiff: no third copy of the UI path regex.
  assert.ok(!/tsx\|jsx/.test(readFileSync(join(ROOT, 'scripts/lib/codex-runner.js'), 'utf8')));
  assert.ok(!/tsx\|jsx/.test(runnerSrc));
  assert.equal(runnerLib.classifyBounce({ uiApproval: true }), 'ui-approval');
});

test('every land/ push in the runner is preceded by landPreflight, which holds UI diffs before the sandbox', () => {
  const pushes = runnerSrc.match(/HEAD:refs\/heads\/\$\{ref\}/g) || [];
  const gates = runnerSrc.match(/await landPreflight\(ref\)/g) || [];
  assert.ok(pushes.length >= 2);
  assert.equal(gates.length, pushes.length, 'a land push without a landPreflight call');
  const body = runnerSrc.slice(runnerSrc.indexOf('async function landPreflight'));
  assert.ok(body.indexOf('R.uiApprovalBlock') > 0 && body.indexOf('R.uiApprovalBlock') < body.indexOf('requireSandbox()'));
  // The card loop and the PR path hold UI diffs before spending the review.
  assert.ok(runnerSrc.indexOf('uiHold({ holdRef') < runnerSrc.indexOf('runCheck(card, body, report'));
  assert.ok(runnerSrc.indexOf('uiHold({ pr: true })') < runnerSrc.indexOf("runCheck(card, body, note"));
});

test('src/ diffs run the site build before the Claude check, in card and PR mode', () => {
  assert.equal(runnerLib.siteBuildNeeded(['src/lib/a.ts']), true);
  assert.equal(runnerLib.siteBuildNeeded(['scripts/a.js', 'data/x.json']), false);
  assert.match(runnerLib.buildFailureNote('boom'), /npm run build/);
  const first = runnerSrc.indexOf('siteBuildFailure()');
  assert.ok(first > 0 && runnerSrc.split('throwIfDisk(siteBuildFailure()').length - 1 === 3, 'card loop (twice) and PR path');
  assert.ok(runnerSrc.indexOf('buildFail = throwIfDisk(siteBuildFailure()') < runnerSrc.indexOf('runCheck(card, body, report'));
  assert.ok(runnerSrc.lastIndexOf('siteBuildFailure()') < runnerSrc.indexOf("runCheck(card, body, note"));
  assert.match(runnerSrc, /BUILD_ENV/); // the Sanity vars /blog needs
  // Under the land mutex and judged against fresh main, so an OOM or a red main is not charged to Codex.
  const fn = runnerSrc.slice(runnerSrc.indexOf('function siteBuildFailure'));
  assert.ok(fn.slice(0, 700).includes('withLandMutex') && fn.slice(0, 700).includes('buildIn(BASE_WT)'));
});

test('both prompts carry the rule-21 learning step', () => {
  const run = readFileSync(join(ROOT, 'scripts/codex/runner-prompt.md'), 'utf8');
  const chk = readFileSync(join(ROOT, 'scripts/codex/check-prompt.md'), 'utf8');
  for (const [name, txt] of [['runner-prompt', run], ['check-prompt', chk]]) assert.match(txt, /RULE21/, name);
  assert.match(run, /whole repo/);
  assert.match(run, /CLASS-GUARD/);
  assert.match(run, /fails with your fix reverted/);
  assert.match(chk, /class guard/);
  assert.match(chk, /SHIP-WITH-FIXES/);
});

// BRO-7639: a held UI change is handed to the Claude worker (marker -> pick.uiHold) and its ref is swept.
const uiHoldLib = require('../../scripts/lib/codex-ui-hold.js');

test('a UI-held card gets the CODEX-UI-HOLD hand-off line that the worker picker reads back', () => {
  const ref = uiHoldLib.uiHoldRef('BRO-123');
  assert.equal(ref, 'codex-ui-hold/bro-123');
  const why = runnerLib.uiApprovalBlock(['src/components/BrowseListClient.tsx'], { holdRef: ref }).note;
  const body = runnerLib.bounceTodoNote({ bounceClass: runnerLib.classifyBounce({ uiApproval: true }), holdRef: ref, why, summary: 'findings' });
  // Still a Codex bounce of class ui-approval, so Codex does not take it again.
  assert.ok(runnerLib.isCodexBounce(body));
  assert.equal(runnerLib.bounceClassOf(body), 'ui-approval');
  const nowIso = '2026-11-25T12:00:00Z';
  const hold = uiHoldLib.uiHoldFromComments([{ body: 'unrelated comment', createdAt: nowIso }, { body, createdAt: nowIso }]);
  assert.equal(hold.ref, ref);
  assert.match(hold.instructions, /git fetch origin codex-ui-hold\/bro-123/);
  assert.match(hold.instructions, /\/visual-qa/);
  assert.match(hold.instructions, /visual-approval\.js request/);
  // No ref pushed (or not a UI hold): no marker, so the picker reports no uiHold.
  const plain = runnerLib.bounceTodoNote({ bounceClass: 'codex-miss', holdRef: null, why: 'x', summary: 'y' });
  assert.equal(uiHoldLib.uiHoldFromComments([{ body: plain, createdAt: nowIso }]), null);
  assert.equal(uiHoldLib.uiHoldFromComments(undefined), null);
  // A pre-marker note names the ref only in prose (the BRO-7636 wording): still found.
  assert.equal(uiHoldLib.uiHoldFromComments([{ body: "Codex's commit is on the ref codex-ui-hold/bro-7560 (git fetch origin codex-ui-hold/bro-7560).", createdAt: nowIso }]).ref, 'codex-ui-hold/bro-7560');
  // The runner writes this note on the Todo bounce and the picker prints the marker.
  assert.match(runnerSrc, /R\.bounceTodoNote\(\{ bounceClass, holdRef: uiHeldRef/);
  assert.match(readFileSync(join(ROOT, 'scripts/cloud-worker-pick.js'), 'utf8'), /uiHoldFromComments\(pick\.comments/);
  // --pr mode: the PR comment carries the same instruction.
  assert.match(runnerLib.uiApprovalBlock(['src/app/globals.css'], { pr: true }).note, /gh pr checkout[\s\S]*visual-approval\.js request/);
});

test('stale or Done codex-ui-hold refs are swept, fresh and in-use ones are kept', () => {
  const now = Date.parse('2026-11-25T12:00:00Z');
  const daysAgo = (d) => new Date(now - d * 86400000).toISOString();
  const decide = (p) => uiHoldLib.decideUiHoldRefPrune({ now, ...p });
  assert.deepEqual(decide({ tipCommittedAt: daysAgo(3), cardStateType: 'completed' }), { prune: true, reason: 'ui-hold-card-done' });
  assert.equal(decide({ tipCommittedAt: daysAgo(3), cardStateType: 'canceled' }).prune, true);
  assert.equal(decide({ tipCommittedAt: daysAgo(uiHoldLib.UI_HOLD_MAX_AGE_DAYS + 1), cardStateType: 'unstarted' }).reason, 'ui-hold-stale');
  assert.equal(decide({ tipCommittedAt: daysAgo(uiHoldLib.UI_HOLD_MAX_AGE_DAYS + 1), cardStateType: null, cardLookupFailed: true }).prune, true);
  // Kept: fresh, card still open, a worker on it, or the date unreadable.
  assert.equal(decide({ tipCommittedAt: daysAgo(0.2), cardStateType: 'completed' }).reason, 'too-young');
  assert.equal(decide({ tipCommittedAt: daysAgo(5), cardStateType: 'unstarted' }).reason, 'ui-hold-recent');
  assert.equal(decide({ tipCommittedAt: daysAgo(5), cardStateType: 'completed', cardLookupFailed: true }).reason, 'card-unreadable');
  assert.equal(decide({ tipCommittedAt: daysAgo(uiHoldLib.UI_HOLD_MAX_AGE_DAYS + 1), cardStateType: 'started' }).reason, 'ui-hold-card-in-progress');
  assert.equal(decide({ tipCommittedAt: null }).reason, 'tip-date-unreadable');
  // The daily land-ref prune is the sweeper: it lists codex-ui-hold refs and decides them with this function.
  const pruneSrc = readFileSync(join(ROOT, 'scripts/prune-stale-land-refs.js'), 'utf8');
  assert.match(pruneSrc, /matching-refs\/heads\/\$\{UI_HOLD_PREFIX/);
  assert.match(pruneSrc, /decideUiHoldRefPrune\(/);
});
