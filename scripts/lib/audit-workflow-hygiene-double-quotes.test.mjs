import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { findUnescapedDoubleQuotesInDoubleQuotedEval: find } = require('./audit-workflow-hygiene-rules.js');
const workflowDir = new URL('../../.github/workflows/', import.meta.url);
const run = (source) => `jobs:\n  test:\n    steps:\n      - run: |\n${source.split('\n').map(l => `          ${l}`).join('\n')}\n`;

test('BRO-2742: the real overdue-alert comments must be escaped', () => {
  const raw = fs.readFileSync(new URL('opening-night-broadcast.yml', workflowDir), 'utf8');
  assert.deepEqual(find(raw), []);
  for (const escaped of ['\\"missing', '\\"blocked=true is written from INSIDE the node call, only once', 'informed\\"']) {
    const broken = raw.replace(escaped, escaped.replace('\\"', '"'));
    assert.notEqual(broken, raw, `real repro still exists: ${escaped}`);
    const hits = find(broken);
    assert.equal(hits.length, 1, escaped);
    assert.ok(hits[0].text.includes(escaped.replace('\\"', '"')));
    assert.ok(hits[0].lineNum > hits[0].startLine);
  }
});

test('inline evals and evals nested in quoted command substitutions are scanned', () => {
  assert.equal(find('steps:\n  - run: node -e "console.log("broken")"').length, 1);
  assert.equal(find(run('OUT="$(node -e "\n// "broken" comment\n")"')).length, 1);
  const two = run('node -e "\n// "first" comment\n"\nnode -e "\n// "second" comment\n"');
  assert.equal(find(two).length, 2, 'one bad eval cannot hide the next eval');
});

test('detects bare quotes in line comments, block comments, literals and each supported eval command', () => {
  for (const command of ['node -e', 'node --input-type=module -e', 'node -p', 'npx tsx -e', 'python3 -e']) {
    for (const body of ['// say "missing" here', '/* say "missing" here */', "console.log(\"missing\");", '// say " more text']) {
      assert.equal(find(run(`${command} "\n${body}\n"`)).length, 1, `${command}: ${body}`);
    }
  }
});

test('shell escaping uses backslash parity; JS comments do not shield shell quotes', () => {
  for (const count of [0, 1, 2, 3, 4]) {
    const raw = run(`node -e "\n// ${'\\'.repeat(count)}"missing\n"`);
    assert.equal(find(raw).length, count % 2 === 0 ? 1 : 0, `${count} backslashes`);
  }
});

test('known-safe shell and JavaScript patterns have no findings', () => {
  const source = String.raw`# node -e "// "not an eval""
echo ok # node -e "// "also a bash comment""
echo 'node -e "// "quoted documentation""'
echo "node -e \"// quoted documentation\""
node -e '
  // "double quotes are safe in a single-quoted eval"
  console.log("ok");
'
node -e "
  // \"missing\" and \`backticks\` are escaped for bash
  /* \"block comment\" */
  const url = 'https://example.com';
  console.log(\"ok\");
" "$ARG" 2>/dev/null || echo "fallback"
node -e "console.log('ok')" # \"bare shell comment\"
node -e "console.log('ok'); // a final JS comment"
node -e "console.log('""ok""')"
node -e "console.log('"$VALUE"')"
cat <<'DOC'
node -e "// "heredoc documentation""
DOC
cat <<< "here string"
OUT="$(node -e "console.log('ok')")"`;
  assert.deepEqual(find(run(source)), []);
});

test('github-script source is not shell source', () => {
  const raw = `jobs:\n  test:\n    steps:\n      - uses: actions/github-script@v7\n        with:\n          script: |\n            // node -e "// "documentation""\n            console.log("ok");\n`;
  assert.deepEqual(find(raw), []);
});

test('every real workflow passes, including bash comments and github-script blocks', () => {
  const files = fs.readdirSync(workflowDir).filter(f => /\.ya?ml$/.test(f));
  assert.ok(files.length > 200);
  const findings = files.flatMap(file => find(fs.readFileSync(new URL(file, workflowDir), 'utf8')).map(hit => ({ file, ...hit })));
  assert.deepEqual(findings, []);
});

test('the existing audit CLI blocks a bad quote and accepts its escaped form', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro-4047-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const header = '# hygiene-notify-ok: isolated fixture\n# hygiene-permissions-ok: isolated fixture (BRO-6398 rule aa)\nname: test\non: workflow_dispatch\n';
  // The real CLI deliberately refuses a workflow corpus smaller than 50.
  for (let i = 0; i < 50; i++) fs.writeFileSync(path.join(dir, `inert-${i}.yml`), `${header}jobs: {}\n`);
  const file = path.join(dir, 'eval.yml');
  const audit = fileURLToPath(new URL('../audit-workflow-hygiene.js', import.meta.url));
  for (const [comment, status] of [[String.raw`// \"missing\"`, 0], ['// "missing"', 1]]) {
    fs.writeFileSync(file, header + run(`node -e "\n${comment}\nconsole.log('ok');\n"`));
    const result = spawnSync(process.execPath, [audit], {
      encoding: 'utf8', timeout: 300000,
      env: { ...process.env, GITHUB_EVENT_NAME: 'push', HYGIENE_WORKFLOW_DIR: dir },
    });
    assert.equal(result.status, status, result.stdout + result.stderr);
    if (status === 1) assert.match(result.stderr, /\(z\).*Unescaped double quote/);
    else assert.match(result.stdout, /Workflow hygiene guard passed/);
  }
});
