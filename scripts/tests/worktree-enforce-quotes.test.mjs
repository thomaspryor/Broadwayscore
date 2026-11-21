// BRO-7723: worktree-enforce.sh must not read a redirect that only appears inside
// quoted prose or a heredoc body as a write, and must still block real writes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { spawnSyncStdinFile } from '../../tests/helpers/spawn-stdin-file.mjs';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOK = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '.claude', 'hooks', 'worktree-enforce.sh');
const repo = mkdtempSync(join(tmpdir(), 'wt-enforce-'));
execFileSync('git', ['init', '-q', repo]);
mkdirSync(join(repo, 'scripts'));
// A linked worktree, for the "cd <worktree> && <write>" cases (relative target after a cd).
const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
execFileSync('git', ['-C', repo, 'commit', '-q', '--allow-empty', '-m', 'init'], { env: gitEnv });
const wt = join(repo, '.claude', 'worktrees', 'w');
execFileSync('git', ['-C', repo, 'worktree', 'add', '-q', wt], { env: gitEnv });
mkdirSync(join(wt, 'scripts'));
const home = mkdtempSync(join(tmpdir(), 'wt-home-')); // no ~/.claude/hooks copy -> no self-skip

function run(command) {
  const input = JSON.stringify({ tool_name: 'Bash', tool_input: { command } });
  const env = { ...process.env, HOME: home, PLANNING_TIER_MODE: 'off' };
  delete env.WORKTREE_ENFORCE_DISABLE;
  return spawnSyncStdinFile('bash', [HOOK], { input, cwd: repo, env, encoding: 'utf8' }).status;
}

const CASES = [
  // [name, command, expected exit]
  ['plain redirect into scripts/', 'echo hi > scripts/x.js', 2],
  ['quoted single-token target', 'echo hi > "scripts/x.js"', 2],
  ['redirect after quoted prose arg', 'echo "a b" > scripts/x.js', 2],
  ['sed -i with spaced expression', "sed -i 's/a b/c/' scripts/x.js", 2],
  ['cp into scripts/', 'cp /tmp/a scripts/x.js', 2],
  ['heredoc written to scripts/', "cat > scripts/x.js <<'EOF'\nhello\nEOF", 2],
  ['redirect named in --notes prose', 'node a.js --notes "redirect output > scripts/foo.js was the bug"', 0],
  ['cp named in single-quoted prose', "node a.js --notes 'then cp a scripts/b.js broke it'", 0],
  ['redirect inside heredoc body', "python3 - <<'EOF'\nprint('x > scripts/y.js')\nEOF", 0],
  ['tee inside heredoc body, unquoted marker', 'cat <<EOF\nrun | tee scripts/z.js\nEOF', 0],
  // ship-check findings: mixed quote kinds, quoted code, empty heredoc body
  ['apostrophe inside double quotes', "echo \"don't\" > scripts/a.js; echo 'x'", 2],
  ['commit message with apostrophe', "git commit -m \"don't\" && echo hi > scripts/a.js && echo 'ok'", 2],
  ['stray double quote inside single quotes', 'echo \'he said "hi\' > scripts/x.js; echo "a b"', 2],
  ['sed expression with a double quote', 'sed -i \'s/"//g\' scripts/x.js && echo "done now"', 2],
  ['bash -c with a write', 'bash -c "echo hi > scripts/x.js"', 2],
  ['sh -c single-quoted write', "sh -c 'echo hi > scripts/x.js'", 2],
  ['write inside $( ) in a quoted string', 'echo "$(echo hi > scripts/x.js) ok"', 2],
  ['empty heredoc then a real write', 'cat <<EOF > /tmp/a\nEOF\necho hi > scripts/x.js\ncat <<EOF\nx\nEOF', 2],
  // A relative target after a leading cd resolves against the cd target, not the session cwd.
  ['cd into a worktree then sed -i', `cd ${wt} && sed -i 's/a/b/' scripts/x.js`, 0],
  // BRO-7783: the exact reported shape, a heredoc write after a leading cd.
  ['cd into a worktree then heredoc write', `cd ${wt} && cat > scripts/x.js <<'EOF'\nhello\nEOF`, 0],
  ['cd into the main checkout then heredoc write', `cd ${repo} && cat > scripts/x.js <<'EOF'\nhello\nEOF`, 2],
  ['cd into a worktree then redirect', `cd ${wt} && echo hi > scripts/x.js`, 0],
  ['cd into the main checkout then sed -i', `cd ${repo} && sed -i 's/a/b/' scripts/x.js`, 2],
  ['cd into a worktree, absolute main-checkout target', `cd ${wt} && echo hi > ${repo}/scripts/x.js`, 2],
  // Unnormalized paths must not dodge the scope check (review finding, 2026-11-18).
  ['dot-slash relative target in the main checkout', 'echo hi > ./scripts/x.js', 2],
  ['cd . then sed -i in the main checkout', "cd . && sed -i 's/a/b/' scripts/x.js", 2],
  ['cd with an empty quoted path', 'cd "" && echo hi > scripts/x.js', 2],
  ['read-only grep', 'grep -n foo scripts/x.js', 0],
];

for (const [name, cmd, want] of CASES) {
  test(name, () => assert.equal(run(cmd), want));
}
