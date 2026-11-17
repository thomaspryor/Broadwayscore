// BRO-7645: retro-coverage-stop.mjs, pure decision plus the real Stop-hook entry (fail-open, one nudge).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { stopHookDecision, shellEditsCode } from './retro-coverage-stop.mjs';

const ENV = { CLAUDE_CODE_REMOTE: 'true' };
let n = 0;
const use = (name, input, result = 'ok', isError = false) => { const id = `t${++n}`; return [{ kind: 'assistant_tool_use', name, input, id }, { kind: 'tool_result', tool_use_id: id, content: result, isError }]; };
const edit = () => use('Edit', { file_path: '/home/user/Broadwayscore/scripts/x.js' });
const land = () => use('Bash', { command: 'git push origin HEAD:refs/heads/land/x' }, 'ok');
const record = (flags, out) => use('Bash', { command: `node scripts/lib/session-retro.js --check --record ${flags}`.trim() }, out);
const SAFE = 'SAFE TO ARCHIVE — done';
const decide = (events, lastMessage = SAFE, env = ENV) => stopHookDecision({ lastMessage, events, env });

test('landed code with no retro run blocks; with a clean retro it allows', () => {
  assert.equal(decide([...edit(), ...land()]).decision, 'block');
  assert.match(decide([...edit(), ...land()]).message, /Retro missing/);
  assert.equal(decide([...edit(), ...land(), ...record('', 'No retro threshold crossed.')]).decision, 'allow');
});

test('a flagged retro needs --fixes or --no-action', () => {
  const flagged = 'RETRO REQUIRED (25 hook blocks): turn each';
  assert.match(decide([...edit(), ...land(), ...record('', flagged)]).message, /not closed/);
  assert.match(decide([...edit(), ...land(), ...use('Bash', { command: 'node scripts/lib/session-retro.js --check --record' }, flagged, true)]).message, /not closed/, 'exit 10 reported as an error is still a run');
  assert.equal(decide([...edit(), ...land(), ...record('', flagged), ...record('--fixes=BRO-7652', flagged)]).decision, 'allow');
  assert.equal(decide([...edit(), ...land(), ...record('--no-action="idle owner time, nothing to fix"', flagged)]).decision, 'allow');
  assert.equal(decide([...edit(), ...land(), ...record('--fixes=later', flagged)]).decision, 'block', 'a non-id link does not count');
  const refused = use('Bash', { command: 'node scripts/lib/session-retro.js --record --no-action=x' }, 'session-retro: --no-action needs a real reason', true);
  assert.equal(decide([...edit(), ...land(), ...record('', flagged), ...refused]).decision, 'block', 'a record run the recorder refused does not close the loop');
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

test('hook entry: blocks once (exit 2), then lets the same transcript through; bad input fails open', () => {
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
    const run = (input) => spawnSync('node', [path.join(import.meta.dirname, 'retro-coverage-stop.mjs'), '--stop-hook'], { input, env: { ...process.env, CLAUDE_CODE_REMOTE: 'true' }, encoding: 'utf8' });
    const inp = JSON.stringify({ transcript_path: tp, session_id: 's', last_assistant_message: SAFE });
    const a = run(inp);
    assert.equal(a.status, 2);
    assert.match(a.stderr, /Retro missing/);
    assert.equal(run(inp).status, 0, 'one nudge per transcript');
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
  ]) assert.equal(shellEditsCode(cmd), false, cmd);
  for (const big of ['x'.repeat(100000), 'a='.repeat(50000), 'x>'.repeat(50000), '(.claude/worktrees'.repeat(6000), "a'".repeat(50000), '/a'.repeat(50000)]) {
    const t0 = Date.now();
    shellEditsCode(big);
    assert.ok(Date.now() - t0 < 500, `a 100k-char input stays linear (${big.slice(0, 6)}...: ${Date.now() - t0}ms)`);
  }
});
