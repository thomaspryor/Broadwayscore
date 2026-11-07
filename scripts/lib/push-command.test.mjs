// BRO-5932: the splitter under both the push guard and the PR-write guard must
// parse a heredoc / here-string / pipe body that a shell will run, and keep
// ignoring one that is only data. Requires the real parser (CLAUDE.md §15).
import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePushCommand, splitShellCommands, landPushTargets } from './push-command.mjs';

const G = 'git push origin HEAD:refs/heads/land/a';
const pushed = (cmd) => parsePushCommand(cmd).map((p) => p.refspecs.map((r) => r.dst).join(','));

test('redirection ampersands do not split a command into background elements', () => {
  for (const redirect of ['2>&1', '1>&2', '<&0', '&>out', '&>>out']) {
    const commands = splitShellCommands(`git push origin main ${redirect} | tail -3`);
    assert.deepEqual(commands, [
      { words: ['git', 'push', 'origin', 'main', redirect], sep: '|' },
      { words: ['tail', '-3'], sep: '' },
    ]);
  }
  assert.equal(splitShellCommands('git push origin main & tail -3')[0].sep, '&');
});

for (const cmd of [
  `bash <<EOF\n${G}\nEOF`,
  `bash <<'EOF'\n${G}\nEOF`,
  `bash -s -- x y <<EOF\n${G}\nEOF`,
  `bash -e -o pipefail <<EOF\n${G}\nEOF`,
  `sudo -u bob bash <<EOF\n${G}\nEOF`,
  `env -u FOO bash <<EOF\n${G}\nEOF`,
  `cat <<EOF | sh\n${G}\nEOF`,
  `eval "$(cat <<'EOF'\n${G}\nEOF\n)"`,
  `bash <<< "${G}"`,
  `echo "${G}" | bash`,
  `printf '%s\\n' "${G}" | sh -s`,
  `bash <<OUTER\ncat <<'IN'\nplain\nIN\n${G}\nOUTER`,
]) {
  test(`a shell-run body is parsed: ${JSON.stringify(cmd).slice(0, 60)}`, () => {
    assert.deepEqual(pushed(cmd), ['land/a']);
    assert.equal(landPushTargets(cmd).length, 1);
  });
}

for (const cmd of [
  `cat <<EOF\n${G}\nEOF`,
  `bash script.sh <<EOF\n${G}\nEOF`,
  `bash -c 'true' <<EOF\n${G}\nEOF`,
  `ssh host bash <<EOF\n${G}\nEOF`,
  `git commit -F - <<EOF\nbash <<X\n${G}\nX\nEOF`,
  `echo hi | bash script.sh`,
  `echo "${G}"`,
]) {
  test(`data-only body stays ignored: ${JSON.stringify(cmd).slice(0, 60)}`, () => {
    assert.deepEqual(pushed(cmd), []);
  });
}

test('a here-string is not a heredoc opener: commands after it still parse', () => {
  assert.deepEqual(pushed(`bash <<< foo; ${G}`), ['land/a']);
  assert.deepEqual(pushed(`cat <<< EOF\n${G}`), ['land/a']);
});

test('commands after the heredoc terminator still parse (eval closer is consumed)', () => {
  assert.deepEqual(pushed(`eval "$(cat <<'EOF'\n${G}\nEOF\n)"; git push origin b`), ['land/a', 'b']);
  assert.deepEqual(pushed(`bash <<EOF\ntrue\nEOF\n${G}`), ['land/a']);
});

test('a cd inside a shell-run body stays scoped to that shell', () => {
  const p = parsePushCommand(`bash <<EOF\ncd /tmp/x\ntrue\nEOF\n${G}`);
  assert.equal(p.length, 1);
  assert.equal(p[0].cdDir, null);
  const inner = parsePushCommand(`bash <<EOF\ncd /tmp/x\n${G}\nEOF`);
  assert.equal(inner[0].cdDir, '/tmp/x');
});

test('splitShellCommands never throws on odd input', () => {
  for (const c of ['', 'bash <<', 'bash <<EOF', 'bash <<EOF\nunterminated "quote', '<<<', 'echo | bash']) {
    assert.ok(Array.isArray(splitShellCommands(c)));
  }
});

// Ship-check findings (BRO-5932): a kept body is tokenized on its own.
test('an unbalanced quote inside a shell-run body cannot hide later commands', () => {
  assert.deepEqual(pushed(`bash <<'EOF'\necho it's fine\nEOF\n${G}`), ['land/a']);
  assert.deepEqual(pushed(`bash <<EOF\necho "unterminated\nEOF\n${G}`), ['land/a']);
});

test('the eval opener keeps the commands before it on the line', () => {
  assert.deepEqual(pushed(`${G}; eval "$(cat <<'EOF'\ntrue\nEOF\n)"`), ['land/a']);
});

test('a ")" in a body (case arm) does not pop the surrounding scope or leak cd', () => {
  const p = parsePushCommand(`bash <<'EOF'\ncase "$1" in a) cd /tmp/x;; esac\nEOF\n${G}`);
  assert.equal(p.length, 1);
  assert.equal(p[0].cdDir, null);
});

test('only the command that owns the heredoc decides whether it is a script', () => {
  assert.deepEqual(pushed(`echo x | bash; cat > f.md <<EOF\n${G}\nEOF`), []);
  assert.deepEqual(pushed(`eval "$(ssh-agent -s)" && cat > notes.txt <<EOF\n${G}\nEOF`), []);
});

test('redirections and a spaceless here-string do not hide the shell', () => {
  assert.deepEqual(pushed(`bash >log <<EOF\n${G}\nEOF`), ['land/a']);
  assert.deepEqual(pushed(`bash > log <<EOF\n${G}\nEOF`), ['land/a']);
  assert.deepEqual(pushed(`bash <<<"${G}"`), ['land/a']);
});

// BRO-6017: bash -c / sh -c / eval strings are parsed recursively.
test('bash -c, sh -lc, eval and wrapped forms expose the land push', () => {
  assert.deepEqual(pushed(`bash -c '${G}'`), ['land/a']);
  assert.deepEqual(pushed(`sh -lc "${G}"`), ['land/a']);
  assert.deepEqual(pushed(`eval "${G}"`), ['land/a']);
  assert.deepEqual(pushed(`eval ${G}`), ['land/a']);
  assert.deepEqual(pushed(`sudo -u bob bash -c '${G}'`), ['land/a']);
  assert.deepEqual(pushed(`bash -c "bash -c '${G}'"`), ['land/a']);
});

test('a cd inside bash -c is scoped to it; one before it carries in', () => {
  assert.equal(parsePushCommand(`cd /x && bash -c '${G}'`)[0].cdDir, '/x');
  const p = parsePushCommand(`bash -c 'cd /y'; ${G}`);
  assert.equal(p[0].cdDir, null);
  assert.equal(parsePushCommand(`bash -c 'cd /y && ${G}'`)[0].cdDir, '/y');
});

test('bash script.sh and bash -c with a non-push script are not pushes', () => {
  assert.deepEqual(pushed(`bash script.sh`), []);
  assert.deepEqual(pushed(`bash -c 'echo hi'`), []);
});

test('BRO-6017 review fixes: option operands, eval --, eval cd carry-out, repo context, noexec, wrappers', () => {
  assert.deepEqual(pushed(`eval -- '${G}'`), ['land/a']);
  assert.deepEqual(pushed(`bash -co pipefail '${G}'`), ['land/a']);
  assert.deepEqual(pushed(`bash -o pipefail -c '${G}'`), ['land/a']);
  assert.deepEqual(pushed(`bash -c -- '${G}'`), ['land/a']);
  assert.deepEqual(pushed(`bash script.sh -c '${G}'`), []);
  assert.deepEqual(pushed(`bash -n -c '${G}'`), []);
  assert.deepEqual(pushed(`env ${G}`), ['land/a']);
  assert.deepEqual(pushed(`timeout 30 ${G}`), ['land/a']);
  assert.equal(parsePushCommand(`eval 'cd /other'; ${G}`)[0].cdDir, '/other');
  assert.equal(parsePushCommand(`GIT_DIR=/o/.git bash -c '${G}'`)[0].dirUnknown, true);
  assert.equal(parsePushCommand(`env -C /o bash -c '${G}'`)[0].dirUnknown, true);
  let deep = G;
  for (let n = 0; n < 5; n++) deep = `bash -c '${deep.replace(/'/g, `'\\''`)}'`;
  assert.deepEqual(pushed(deep), ['land/a']);
});
