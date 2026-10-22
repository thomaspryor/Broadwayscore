// BRO-5932: the splitter under both the push guard and the PR-write guard must
// parse a heredoc / here-string / pipe body that a shell will run, and keep
// ignoring one that is only data. Requires the real parser (CLAUDE.md §15).
import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePushCommand, splitShellCommands, landPushTargets } from './push-command.mjs';

const G = 'git push origin HEAD:refs/heads/land/a';
const pushed = (cmd) => parsePushCommand(cmd).map((p) => p.refspecs.map((r) => r.dst).join(','));

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
