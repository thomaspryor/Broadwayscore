// BRO-7645: retro-coverage-stop.mjs, pure decision plus the real Stop-hook entry (fail-open, capped nudges).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { spawnSyncStdinFile } from '../../tests/helpers/spawn-stdin-file.mjs';
import { createHash } from 'node:crypto';
import { stopHookDecision, shellEditsCode, transcriptHasTool, claimsClose } from './retro-coverage-stop.mjs';

const ENV = { CLAUDE_CODE_REMOTE: 'true', COST_ROW_GATE: 'off' }; // the retro cases; the cost row has its own test
let n = 0;
const use = (name, input, result = 'ok', isError = false) => { const id = `t${++n}`; return [{ kind: 'assistant_tool_use', name, input, id }, { kind: 'tool_result', tool_use_id: id, content: result, isError }]; };
const edit = () => use('Edit', { file_path: '/home/user/Broadwayscore/scripts/x.js' });
const land = () => use('Bash', { command: 'git push origin HEAD:refs/heads/land/x' }, 'ok');
const record = (flags, out) => use('Bash', { command: `node scripts/lib/session-retro.js --check --record ${flags}`.trim() }, out);
const carry = () => use('Bash', { command: 'git add data/audit/session-retro.jsonl && git commit -m "retro row" && git push origin HEAD:refs/heads/land/x' });
const SAFE = 'SAFE TO ARCHIVE — done';
const decide = (events, lastMessage = SAFE, env = ENV, hasGetSession = true) => stopHookDecision({ lastMessage, events, env, hasGetSession });

test('landed code with no retro run blocks; with a clean retro it allows', () => {
  assert.equal(decide([...edit(), ...land()]).decision, 'block');
  assert.match(decide([...edit(), ...land()]).message, /Retro missing/);
  assert.equal(decide([...edit(), ...land(), ...record('', 'No retro threshold crossed.'), ...carry()]).decision, 'allow');
});

test('a flagged retro needs --fixes or --no-action', () => {
  const flagged = 'RETRO REQUIRED (25 hook blocks): turn each';
  assert.match(decide([...edit(), ...land(), ...record('', flagged)]).message, /not closed/);
  assert.match(decide([...edit(), ...land(), ...use('Bash', { command: 'node scripts/lib/session-retro.js --check --record' }, flagged, true)]).message, /not closed/, 'exit 10 reported as an error is still a run');
  assert.equal(decide([...edit(), ...land(), ...record('', flagged), ...record('--fixes=BRO-7652', flagged), ...carry()]).decision, 'allow');
  assert.equal(decide([...edit(), ...land(), ...record('--no-action="idle owner time, nothing to fix"', flagged), ...carry()]).decision, 'allow');
  assert.equal(decide([...edit(), ...land(), ...record('--fixes=later', flagged)]).decision, 'block', 'a non-id link does not count');
  const refused = use('Bash', { command: 'node scripts/lib/session-retro.js --record --no-action=x' }, 'session-retro: --no-action needs a real reason', true);
  assert.equal(decide([...edit(), ...land(), ...record('', flagged), ...refused]).decision, 'block', 'a record run the recorder refused does not close the loop');
});

test('BRO-7729: the retro row must ride a land push to main', () => {
  const clean = 'No retro threshold crossed.';
  const sh = (command, out = 'ok', err = false) => use('Bash', { command }, out, err);
  // The 2026-11-17 incident: recorded after the last land, committed to the session branch only.
  const incident = [...edit(), ...land(), ...record('', clean), ...sh('git add data/audit/session-retro.jsonl && git commit -m "retro"'), ...sh('git push -u origin claude/x')];
  assert.equal(decide(incident).decision, 'block');
  assert.match(decide(incident).message, /Retro not on main/);
  assert.equal(decide([...edit(), ...land(), ...record('', clean)]).decision, 'block', 'recorded after the last land, never committed');
  assert.equal(decide([...edit(), ...record('', clean), ...land()]).decision, 'block', 'a land push with no ledger commit carries nothing');
  // Allowed shapes.
  assert.equal(decide([...edit(), ...record('', clean), ...sh('git add -A'), ...sh('git commit -m "work and retro"'), ...land()]).decision, 'allow', 'record before the final land, add -A');
  assert.equal(decide([...edit(), ...record('', clean), ...sh('git commit -am "work and retro"'), ...land()]).decision, 'allow', 'commit -am');
  assert.equal(decide([...edit(), ...land(), ...record('', clean), ...sh('git -C /w add data/audit && git -C /w commit -m "r"'), ...land()]).decision, 'allow', 'a second land push after the record');
  assert.equal(decide([...edit(), ...land(), ...record('', clean), ...use('mcp__github__push_files', { branch: 'land/r', files: [{ path: 'data/audit/session-retro.jsonl' }] })]).decision, 'allow', 'API push of the ledger to land/');
  assert.equal(decide([...edit(), ...land(), ...record('', clean), ...use('mcp__github__push_files', { branch: 'claude/x', files: [{ path: 'data/audit/session-retro.jsonl' }] }), ...land()]).decision, 'block', 'API push of the ledger to a claude/ branch carries nothing');
  // Review findings (ship-check): one chained command, -u, global git options, failed/dry-run commits, staging alone, other repos.
  const R = 'node scripts/lib/session-retro.js --check --record';
  assert.equal(decide([...edit(), ...land(), ...sh(`${R} && git add data/audit/session-retro.jsonl && git commit -m r && git push origin HEAD:refs/heads/land/x`)]).decision, 'allow', 'record, commit and land in one command');
  assert.equal(decide([...edit(), ...land(), ...sh(`${R} && git commit -am r`), ...land()]).decision, 'allow', 'record and commit -am in one command');
  assert.equal(decide([...edit(), ...land(), ...record('', clean), ...sh('git add -u && git commit -m r'), ...land()]).decision, 'allow', 'add -u stages the tracked ledger');
  assert.equal(decide([...edit(), ...land(), ...record('', clean), ...sh('git -c core.x=1 --no-pager add -A && git commit -m r'), ...land()]).decision, 'allow', 'global git options');
  assert.equal(decide([...edit(), ...land(), ...record('', clean), ...sh('git commit -am r', 'nothing to commit', true), ...land()]).decision, 'block', 'a failed commit carries nothing');
  assert.equal(decide([...edit(), ...land(), ...record('', clean), ...sh('git commit --dry-run -a'), ...land()]).decision, 'block', 'a dry run carries nothing');
  assert.equal(decide([...edit(), ...land(), ...record('', clean), ...sh('git add -A'), ...land()]).decision, 'block', 'staged but never committed');
  assert.equal(decide([...edit(), ...land(), ...record('', clean), ...sh('cd ../broadway-scorecard-data && git add -A && git commit -m r'), ...land()]).decision, 'block', 'a commit in another repo');
  // The LAST record run is the one that must land: a linked re-run after the land is not on main.
  const flagged = 'RETRO REQUIRED (land refusal): turn each';
  assert.equal(decide([...edit(), ...record('', flagged), ...carry(), ...record('--fixes=BRO-1', flagged)]).decision, 'block', 'the linked re-run never landed');
  // A refused land push after the commit does not carry it.
  assert.equal(decide([...edit(), ...land(), ...record('', clean), ...sh('git commit -am x'), ...sh('git push origin HEAD:refs/heads/land/x', 'rejected', true)]).decision, 'block');
  // A commit mentioned in a heredoc is not a commit.
  assert.equal(decide([...edit(), ...record('', clean), ...sh("cat <<'E'\ngit commit -am x\nE"), ...land()]).decision, 'block');
  assert.equal(decide(incident, `${SAFE}\nNO-RETRO: row deliberately kept off main for a test`).decision, 'allow', 'bypass still works');
});

test('BRO-7729 cousin: the cost row must be recorded and ride a land push', () => {
  const on = { CLAUDE_CODE_REMOTE: 'true' };
  const sh = (command, out = 'ok', err = false) => use('Bash', { command }, out, err);
  const clean = 'No retro threshold crossed.';
  const cost = (out = 'data/audit/claude-session-cost.jsonl: 1 row(s) written (0 replaced same-day rows), 0 skipped') => sh('node scripts/record-claude-session-cost.js --from-json=/tmp/s.json --cards=BRO-1', out);
  const base = [...edit(), ...land(), ...record('', clean)];
  assert.match(decide([...base, ...carry()], SAFE, on).message, /Cost row missing/);
  // The incident: both rows committed, pushed to the claude/ branch only.
  assert.match(decide([...base, ...cost(), ...sh('git add data/audit/claude-session-cost.jsonl data/audit/session-retro.jsonl && git commit -m r'), ...sh('git push -u origin claude/x')], SAFE, on).message, /Retro not on main/);
  assert.equal(decide([...base, ...cost(), ...sh('git add data/audit/claude-session-cost.jsonl data/audit/session-retro.jsonl && git commit -m r && git push origin HEAD:refs/heads/land/x')], SAFE, on).decision, 'allow', 'both rows ride one land push');
  assert.match(decide([...base, ...cost(), ...carry()], SAFE, on).message, /Cost row not on main/, 'staging only the retro file leaves the cost row behind');
  assert.match(decide([...base, ...carry(), ...cost()], SAFE, on).message, /Cost row not on main/, 'cost recorded after the last land');
  assert.match(decide([...base, ...cost('Error: no cost in session json'), ...carry()], SAFE, on).message, /Cost row missing/, 'a failed cost run is not a row');
  assert.equal(decide([...base, ...cost(), ...sh('git commit -am r'), ...land()], SAFE, on).decision, 'allow', 'commit -a carries both');
  assert.equal(decide([...base, ...carry()], SAFE, on, false).decision, 'allow', 'no get_session tool: the cost row is skipped (wrap-up)');
  // Review findings (cost increment).
  assert.match(decide([...base, ...cost('data/audit/claude-session-cost.jsonl: 0 row(s) written (0 replaced same-day rows), 0 skipped'), ...sh('git commit -am r'), ...land()], SAFE, on).message, /Cost row missing/, 'an empty input writes no row');
  assert.match(decide([...base, ...sh('node scripts/record-claude-session-cost.js --from-json=/tmp/s.json', '1 row(s) written (0 replaced same-day rows), 0 skipped', true), ...sh('git commit -am r'), ...land()], SAFE, on).message, /Cost row missing/, 'an errored run is not a row');
  const W = '1 row(s) written (0 replaced same-day rows), 0 skipped';
  assert.equal(decide([...base, ...sh(`node scripts/record-claude-session-cost.js --from-json=/tmp/s.json && git add data/audit && git commit -m r && git push origin HEAD:refs/heads/land/x`, W)], SAFE, on).decision, 'allow', 'cost, commit and land in one command');
  assert.equal(decide([...base, ...cost(), ...use('mcp__github__push_files', { branch: 'land/r', files: [{ path: 'data/audit/claude-session-cost.jsonl' }, { path: 'data/audit/session-retro.jsonl' }] })], SAFE, on).decision, 'allow', 'API push of both ledgers to land/');
  assert.match(decide([...base, ...carry(), ...cost(), ...use('mcp__github__push_files', { branch: 'claude/x', files: [{ path: 'data/audit/claude-session-cost.jsonl' }] }), ...land()], SAFE, on).message, /Cost row not on main/, 'API push of the cost ledger to claude/ carries nothing');
  for (const add of ['git add "data/audit"', 'git add data/audit/*.jsonl', "git add 'data/audit/'"]) {
    assert.equal(decide([...base, ...cost(), ...sh(`${add} && git commit -m r`), ...land()], SAFE, on).decision, 'allow', add);
  }
  assert.equal(decide([...base, ...cost(), ...sh('git add data/audit;git commit -m r'), ...land()], SAFE, on).decision, 'allow', 'add data/audit;commit');
  assert.match(decide([...base, ...cost(), ...sh('git add data/audit/session-retro.jsonl data/audit/other.json && git commit -m r'), ...land()], SAFE, on).message, /Cost row not on main/, 'a named other file under data/audit is not the folder');
  assert.equal(decide([...base, ...cost('data/audit/claude-session-cost.jsonl: 1 row(s) written (1 replaced same-day rows), 0 skipped'), ...sh('git commit -am r'), ...land()], SAFE, on).decision, 'allow', 'a same-day replace is a run');
});

test('transcriptHasTool: offered or called counts; only reading the name does not', () => {
  const G = 'mcp__claude-code-remote__get_session';
  const L = (o) => JSON.stringify(o);
  assert.equal(transcriptHasTool(L({ type: 'attachment', attachment: { type: 'prompt_snapshot', tools: [{ name: G }] } }), G), true, 'tool list (real shape)');
  assert.equal(transcriptHasTool(L({ type: 'attachment', attachment: { type: 'deferred_tools_delta', addedNames: [G] } }), G), true, 'deferred and added');
  assert.equal(transcriptHasTool(L({ type: 'attachment', attachment: { type: 'deferred_tools_delta', addedNames: [], removedNames: [G] } }), G), false, 'removed is not offered');
  assert.equal(transcriptHasTool(L({ type: 'attachment', attachment: { type: 'prompt_snapshot', systemPrompt: `use ${G}`, tools: [{ name: `${G}_cost` }] } }), G), false, 'prompt mention or sibling name');
  assert.equal(transcriptHasTool(L({ type: 'assistant', message: { content: [{ type: 'tool_use', name: G, input: {} }] } }), G), true, 'called');
  assert.equal(transcriptHasTool(L({ type: 'user', message: { content: [{ type: 'tool_result', content: `const X = '${G}'` }] } }), G), false, 'grep or Read output');
  assert.equal(transcriptHasTool(L({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: `grep ${G} x` } }] } }), G), false, 'a command mentioning it');
  assert.equal(transcriptHasTool('not json ' + G, G), false);
});

test('stays quiet outside its scope', () => {
  assert.equal(decide([...edit(), ...land()], 'KEEP OPEN — waiting').decision, 'allow', 'only SAFE TO ARCHIVE');
  assert.equal(decide([...edit()]).decision, 'allow', 'nothing landed');
  assert.equal(decide([...use('Edit', { file_path: '/home/user/Broadwayscore/data/audit/x.jsonl' }), ...land()]).decision, 'allow', 'data-only');
  assert.equal(decide([...use('Edit', { file_path: '/home/user/Broadwayscore/.claude/worktrees/w/data/shows.json' }), ...land()]).decision, 'allow', 'data-only in a worktree');
  assert.equal(decide([...use('Write', { file_path: '/root/.claude/projects/p/memory/x.md' }), ...land()]).decision, 'allow', 'memory is not code');
  assert.equal(decide([...use('Edit', { file_path: '/home/user/Broadwayscore/.claude/worktrees/w/scripts/a.js' }), ...land()]).decision, 'block', 'code in a worktree');
  assert.equal(decide([...edit(), ...land()], SAFE, {}).decision, 'allow', 'not cloud');
  assert.equal(decide([...edit(), ...land()], SAFE, { ...ENV, RETRO_COVERAGE_STOP_DISABLE: '1' }).decision, 'allow');
  assert.equal(decide([...edit(), ...land()], `${SAFE}\nNO-RETRO: docs only, nothing to measure`).decision, 'allow');
  assert.equal(decide([...edit(), ...use('Bash', { command: 'git push origin HEAD:refs/heads/land/x' }, 'rejected', true)]).decision, 'allow', 'a failed push is not a landing');
  assert.equal(decide([...edit(), ...use('Bash', { command: "cat <<'E'\nnode scripts/lib/session-retro.js --record --fixes=BRO-1\nE" })].concat(land())).decision, 'block', 'a heredoc mention is not a record run');
  assert.equal(decide(null).decision, 'allow');
});

test('hook entry: blocks up to 3 times (exit 2), then lets the same transcript through; bad input fails open', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcs-'));
  try {
    const tp = path.join(dir, 't.jsonl');
    const L = (o) => JSON.stringify(o);
    fs.writeFileSync(tp, [
      L({ type: 'assistant', message: { id: 'm1', content: [{ type: 'tool_use', id: 'e1', name: 'Edit', input: { file_path: '/home/user/Broadwayscore/scripts/a.js' } }] } }),
      L({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'e1', content: 'ok' }] } }),
      L({ type: 'assistant', message: { id: 'm2', content: [{ type: 'tool_use', id: 'p1', name: 'Bash', input: { command: 'git push origin HEAD:refs/heads/land/x' } }] } }),
      L({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'p1', content: 'ok' }] } }),
    ].join('\n'));
    const run = (input) => spawnSyncStdinFile('node', [path.join(import.meta.dirname, 'retro-coverage-stop.mjs'), '--stop-hook'], { input, env: { ...process.env, CLAUDE_CODE_REMOTE: 'true' }, encoding: 'utf8' });
    const inp = JSON.stringify({ transcript_path: tp, session_id: 's', last_assistant_message: SAFE });
    const a = run(inp);
    assert.equal(a.status, 2);
    assert.match(a.stderr, /Retro missing/);
    const b = run(inp);
    assert.equal(b.status, 2, 'BRO-7729: closing again does not clear it');
    assert.match(b.stderr, /Repeat 2 of 3/);
    assert.equal(run(inp).status, 2);
    assert.equal(run(inp).status, 0, 'capped at 3: it can never loop a session');
    assert.equal(run('not json').status, 0);
    assert.equal(run(JSON.stringify({ transcript_path: '/nope' })).status, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(path.join(os.tmpdir(), `retro-coverage-stop-${createHash('sha1').update(path.join(dir, 't.jsonl') + '\u0000' + 'landed code, no retro --record run').digest('hex').slice(0, 12)}`), { force: true });
  }
});

test('a shell-made code edit counts as editing code (BRO-7701: auto-mode sessions edit with sed/python/cat)', () => {
  const sh = (command) => use('Bash', { command });
  for (const cmd of [
    "sed -i 's/a/b/' scripts/lib/x.js",
    "cd /home/user/Broadwayscore/.claude/worktrees/w && python3 - <<'EOF2'\nimport json\np='.claude/autonomous-config.json'\nopen(p,'w').write('{}')\nEOF2",
    "cat > src/app/page.tsx <<'EOF2'\nx\nEOF2",
    "node -e 'require(\"fs\").writeFileSync(\"scripts/y.js\",\"1\")'",
    "printf 'x' | tee .github/workflows/z.yml",
    "perl -pi -e 's/a/b/' src/lib/a.ts",
  ]) assert.equal(decide([...sh(cmd), ...land()]).decision, 'block', cmd);
  for (const cmd of [
    "grep -rn foo scripts/lib",
    "cat scripts/lib/x.js",
    "python3 - <<'EOF2'\nfor l in open('data/audit/x.jsonl'): print(l)\nEOF2",
    "sed -i 's/a/b/' data/shows.json",
    "node scripts/lib/session-retro.js --rollup > /tmp/out.txt",
    "git checkout -q origin/main -- scripts/",
  ]) assert.equal(decide([...sh(cmd), ...land()]).decision, 'allow', cmd);
});

test('shell-edit detection: ship-check findings (absolute paths, cp/mv, quoted prose, .claude state, long tokens)', () => {
  const R = ['', 'home', 'user', 'Broadwayscore'].join('/');
  for (const cmd of [
    `sed -i 's/a/b/' ${R}/scripts/lib/x.js`,
    `cat > ${R}/src/a.ts <<'E'\nx\nE`,
    `python3 -c "open('${R}/src/a.ts','w').write('x')"`,
    "sed -i 's/a/b/' ./scripts/x.js",
    "sed -e 's/a/b/' -i scripts/x.js",
    "sed --in-place 's/a/b/' scripts/x.js",
    "echo x | tee --append scripts/x.js",
    "cp /tmp/g.ts src/g.ts",
    "mv scripts/a.js scripts/lib/a.js",
    "git apply /tmp/fix.patch",
    "echo '{}' > .claude/autonomous-config.json",
    "echo x >> .claude/hooks/verify-edits.sh",
    `bash -lc "cp a.js ${['scripts', 'b.js'].join('/')}"`,
    "cp a.js src/b.js # copy over",
    "sed -i 's/a/b/;s/c/d/' scripts/x.js",
    "sed -i 's/a|b/c/' scripts/x.js",
    "mv a.js scripts/x.js 2>/dev/null",
    "git -C wt apply /tmp/p.patch",
    "cp -t src/ a.js",
    "install -m 644 -t scripts/lib a.js",
    "mv --target-directory=scripts/ a.js",
    "sudo cp a.js src/b.js",
    "env A=1 cp a.js src/b.js",
    "/bin/cp a.js src/b.js",
    "cp a.js src/b.js 2> /dev/null",
    `cp a.js ${R}/src/b.js`,
  ]) assert.equal(shellEditsCode(cmd), true, cmd);
  for (const cmd of [
    "echo 1 > .claude/state/foo",
    "node x.js >> .claude/review-verdicts.jsonl",
    "echo x > .claude/worktrees/foo",
    'git commit -m "redirect >src/ fixed"',
    'gh pr create --body "run cmd > scripts/x"',
    "sed -i 's/a/b/' data/shows.json && cat scripts/x.js",
    "node -e \"process.stdout.write(require('fs').readFileSync('scripts/x.js','utf8'))\"",
    "cp scripts/x.js /tmp/x.js",
    "npm test 2>&1 | tee .cache/out.txt",
    "git apply --check /tmp/p.patch",
    "cp -t /tmp/out scripts/x.js",
    "rsync -avt scripts/ /tmp/backup",
    "install -d scripts/newdir",
    `cp a.js ${['', 'home', 'user', 'other-repo', 'scripts', 'x.js'].join('/')}`,
  ]) assert.equal(shellEditsCode(cmd), false, cmd);
  for (const big of ['cp' + ' >a'.repeat(40000) + ' x', 'cp' + ' 2> x'.repeat(30000),'x'.repeat(100000), 'a='.repeat(50000), 'x>'.repeat(50000), '(.claude/worktrees'.repeat(6000), "a'".repeat(50000), '/a'.repeat(50000)]) {
    const t0 = Date.now();
    shellEditsCode(big);
    assert.ok(Date.now() - t0 < 500, `a 100k-char input stays linear (${big.slice(0, 6)}...: ${Date.now() - t0}ms)`);
  }
});

// BRO-7911: 2026-11-20 a board firing landed code and closed "ACTION NEEDED FROM YOU": the SAFE-only check never ran.
test('BRO-7911: an ACTION NEEDED close is a close; KEEP OPEN is not', () => {
  const ACTION = 'You need to: read the batch.\n\nACTION NEEDED FROM YOU — read the spam-held reader feedback batch.';
  assert.equal(claimsClose(ACTION), true);
  assert.equal(claimsClose('KEEP OPEN — waiting on a worker'), false);
  assert.equal(claimsClose('ACTION NEEDED FROM YOU — x\n\nmore prose after it'), false, 'only the last line counts');
  assert.equal(decide([...edit(), ...land()], ACTION).decision, 'block', 'landed code, no retro row, closing with ACTION NEEDED');
  assert.equal(decide([...edit(), ...land()], 'KEEP OPEN — waiting').decision, 'allow');
  assert.equal(decide([...edit(), ...land(), ...record('', 'No retro threshold crossed.'), ...carry()], ACTION).decision, 'allow');
});

// BRO-7911: verify-edits.sh exits 0 once the chain has VE_CHAIN_BLOCK_CAP blocks, before [VE:RETROCOV] ran
// (2026-11-20: two board firings spent the cap on RCOV/ROOTCAUSE/CLEARCLOSE, then closed with no retro row).
test('BRO-7911: the retro gate still runs when the chain block cap is spent', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'retro-cap-'));
  const tp = path.join(dir, 't.jsonl');
  const L = (o) => JSON.stringify(o);
  fs.writeFileSync(tp, [
    L({ type: 'assistant', message: { id: 'm1', content: [{ type: 'tool_use', id: 'e1', name: 'Edit', input: { file_path: '/home/user/Broadwayscore/scripts/a.js' } }] } }),
    L({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'e1', content: 'ok' }] } }),
    L({ type: 'assistant', message: { id: 'm2', content: [{ type: 'tool_use', id: 'p1', name: 'Bash', input: { command: 'git push origin HEAD:refs/heads/land/x' } }] } }),
    L({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'p1', content: 'ok' }] } }),
  ].join('\n'));
  const chain = `/tmp/verify-edits-chain-${spawnSyncStdinFile('sh', ['-c', `printf '%s' '${tp}' | cksum | cut -d' ' -f1`], { encoding: 'utf8' }).stdout.trim()}`;
  const counter = path.join(os.tmpdir(), `retro-coverage-stop-${createHash('sha1').update(tp + '\u0000' + 'landed code, no retro --record run').digest('hex').slice(0, 12)}`);
  try {
    fs.writeFileSync(chain, 'RCOV\nROOTCAUSE\nCLEARCLOSE\nEFFECTPENDING\n'); // 4 lines = the cap
    const hook = path.join(import.meta.dirname, '..', '..', '.claude', 'hooks', 'verify-edits.sh');
    const input = JSON.stringify({ transcript_path: tp, session_id: 's', stop_hook_active: true, last_assistant_message: 'ACTION NEEDED FROM YOU — read it' });
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'retro-home-')); // defeats the Mac-master self-skip
    const r = spawnSyncStdinFile('bash', [hook], { input, env: { ...process.env, HOME: fakeHome, CLAUDE_CODE_REMOTE: 'true' }, encoding: 'utf8' });
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /\[VE:RETROCOV\]/);
    const off = spawnSyncStdinFile('bash', [hook], { input, env: { ...process.env, HOME: fakeHome, CLAUDE_CODE_REMOTE: 'true', RETRO_COVERAGE_STOP_DISABLE: '1' }, encoding: 'utf8' });
    assert.equal(off.status, 0, 'kill switch still lets the capped chain through');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(chain, { force: true }); fs.rmSync(counter, { force: true });
  }
});
