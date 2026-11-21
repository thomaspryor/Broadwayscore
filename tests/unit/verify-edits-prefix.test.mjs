// BRO-2632: exercise the shipped Stop hook, without executing transcript commands.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { spawnSyncStdinFile } from '../helpers/spawn-stdin-file.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const hook = path.join(root, '.claude/hooks/verify-edits.sh');
const target = 'data/review-texts/some-show/critic.json';

function runHook(command, { missingMatcher = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-edits-prefix-'));
  const transcript = path.join(dir, 'transcript.jsonl');
  const checksum = spawnSync('cksum', [], { input: transcript, encoding: 'utf8' });
  assert.equal(checksum.status, 0, checksum.stderr);
  try {
    let hookPath = hook;
    let cwd = root;
    if (missingMatcher) {
      cwd = path.join(dir, 'repo');
      hookPath = path.join(cwd, '.claude/hooks/verify-edits.sh');
      fs.mkdirSync(path.dirname(hookPath), { recursive: true });
      fs.copyFileSync(hook, hookPath);
    }
    fs.writeFileSync(transcript, JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [
        { type: 'tool_use', name: 'Bash', input: { command } },
      ] },
    }) + '\n');
    const result = spawnSyncStdinFile('bash', [hookPath], {
      input: JSON.stringify({ transcript_path: transcript, session_id: path.basename(dir), stop_hook_active: false }),
      cwd,
      encoding: 'utf8',
      timeout: 20_000,
      // An empty HOME prevents the repo hook's master-copy self-skip.
      env: { ...process.env, HOME: dir, SCORING_DELTA_STAMP_DIR: path.join(dir, 'stamps') },
    });
    assert.ifError(result.error);
    return result;
  } finally {
    fs.rmSync(`/tmp/verify-edits-chain-${checksum.stdout.split(/\s/)[0]}`, { force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const prefixes = [
  '', 'timeout 30 ', 'timeout -s TERM -k 5 30 ',
  'timeout --signal=TERM --kill-after=5 -- 30 ',
  'timeout -k5 30 ', 'timeout -sTERM 30 ', 'nice -n10 ',
  'env -uFLAG ', 'env -C/tmp ', 'time -f%E ',
  'env ', 'env FLAG=1 ', 'FLAG=1 ', 'FLAG="two words" ',
  'env -u FLAG -C /tmp ', 'env --unset=FLAG --chdir=/tmp ',
  'nohup ', 'nice ', 'nice -n 10 ', 'nice --adjustment=10 ', 'nice -10 ',
  'stdbuf -oL ', 'stdbuf -i 0 -o L -e 0 ',
  'stdbuf --input=0 --output=L --error=0 ',
  'time -p ', 'time -f "%E elapsed" ', 'command -p ',
  '/usr/bin/timeout 30 ', 'env FLAG=1 timeout 30 nice -n 10 stdbuf -oL ',
  'true && timeout 30 ', 'true; env FLAG=1 ', 'printf x | timeout 30 ',
  '\n  timeout 30 ', '  timeout 30 ',
  '# harmless comment\ntimeout 30 ',
  'echo foo\\ #literal; timeout 30 ',
  `echo "example; timeout 30 sed -i s/x/y/ ${target}"; timeout 30 `,
];

for (const prefix of prefixes) {
  test(`blocks wrapped sed write: ${JSON.stringify(prefix)}`, () => {
    const result = runHook(`${prefix}sed -i s/x/y/ ${target}`);
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /audit sweep of data\/review-texts\//);
  });
}

for (const write of [
  `perl -pi -e s/x/y/ ${target}`,
  `find data/review-texts/ -exec rm {} \\;`,
  `xargs rm ${target}`,
  `mv /tmp/source.json ${target}`,
  `cp /tmp/source.json ${target}`,
  `rm ${target}`,
  `tee ${target}`,
  `python3 -c "open('${target}', 'w').write('x')"`,
  `printf x > ${target}`,
  `node -e "fs.writeFileSync('${target}', 'x')"`,
  `node -e "fs.appendFileSync('${target}', 'x')"`,
  `node -e "fs.createWriteStream('${target}')"`,
  `bun -e "Bun.write('${target}', 'x')"`,
]) {
  test(`blocks cousin write under nested wrappers: ${write.split(' ')[0]}`, () => {
    const result = runHook(`env FLAG=1 timeout 30 ${write}`);
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /audit sweep of data\/review-texts\//);
  });
}

for (const command of [
  `timeout 30 cat ${target}`,
  `env FLAG=1 grep x ${target}`,
  `nice -n 10 sed -n 1p ${target}`,
  `timeout 30 sed -i s/x/y/ /tmp/other.json`,
  `timeout 30 echo "sed -i s/x/y/ ${target}"`,
  `echo "timeout 30 sed -i s/x/y/ ${target}"`,
  `echo "example; timeout 30 sed -i s/x/y/ ${target}"`,
  `echo 'example; timeout 30 sed -i s/x/y/ ${target}'`,
  `echo "example\ntimeout 30 sed -i s/x/y/ ${target}"`,
  `echo 'example\ntimeout 30 sed -i s/x/y/ ${target}'`,
  `echo ok # example; timeout 30 sed -i s/x/y/ ${target}`,
  `echo "example > ${target}"`,
  `command -v sed -i s/x/y/ ${target}`,
  `env NOTE="sed -i s/x/y/ ${target}" echo ok`,
  `timeout 30sed -i s/x/y/ ${target}`,
  `env NOTE=${'x'.repeat(1000)} echo "sed -i s/x/y/ ${target}"`,
  `cat <<'EOF'\ntimeout 30 sed -i s/x/y/ ${target}\nEOF`,
]) {
  test(`allows read or inert mention: ${command.split('\n')[0]}`, () => {
    const result = runHook(command);
    assert.equal(result.status, 0, result.stderr);
  });
}

test('here-string leaves the following wrapped write executable', () => {
  const result = runHook(`printf x <<<EOF\ntimeout 30 sed -i s/x/y/ ${target}\nEOF`);
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /audit sweep of data\/review-texts\//);
});

test('missing matcher blocks rather than silently allowing review-text writes', () => {
  const result = runHook(`timeout 30 sed -i s/x/y/ ${target}`, { missingMatcher: true });
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /cannot load scripts\/lib\/verify_edits_writes\.py/);
});

for (const command of [
  `echo "$(timeout 30 sed -i s/x/y/ ${target})"`,
  `echo "$(true; timeout 30 sed -i s/x/y/ ${target})"`,
  `echo "\`timeout 30 sed -i s/x/y/ ${target}\`"`,
  `echo "$(printf '%s' "$(timeout 30 sed -i s/x/y/ ${target})")"`,
  `echo "$( ( timeout 30 sed -i s/x/y/ ${target} ) )"`,
]) {
  test(`blocks executable substitution: ${command}`, () => {
    const result = runHook(command);
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /audit sweep/);
  });
}

for (const command of [
  `echo '$(true; timeout 30 sed -i s/x/y/ ${target})'`,
  `echo "\\$(true; timeout 30 sed -i s/x/y/ ${target})"`,
  `echo '\`true; timeout 30 sed -i s/x/y/ ${target}\`'`,
]) {
  test(`allows literal substitution syntax: ${command}`, () => {
    assert.equal(runHook(command).status, 0);
  });
}
