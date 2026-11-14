// BRO-6241: pushes whose only target is visual-hold/* or visual-evidence/* skip the
// visual-qa gate; anything chained, or aimed at main/land/*, does not.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const hook = fs.readFileSync(new URL('../../.claude/hooks/pre-push-visual-gate.sh', import.meta.url), 'utf8');
const re = /^_HOLD_RE='([^']+)'/m.exec(hook)?.[1];
const P = 'git ' + 'push';

function exempt(command) {
  const r = spawnSync('bash', ['-c', '[[ "$1" =~ $2 ]] && [[ "$1" != *$\'\\n\'* ]]', 'x', command, re]);
  return r.status === 0;
}

test('hold-ref regex is present in the hook', () => assert.ok(re));

test('plain pushes to visual-hold and visual-evidence are exempt', () => {
  assert.ok(exempt(`${P} -u origin HEAD:refs/heads/visual-hold/bro-6241`));
  assert.ok(exempt(`${P} --force origin visual-evidence-tmp:refs/heads/visual-evidence/bro-6241`));
});

test('main, land and chained pushes stay gated', () => {
  for (const c of [
    `${P} origin HEAD:refs/heads/land/bro-1`,
    `${P} origin main`,
    `${P} origin HEAD:refs/heads/visual-hold/a; ${P} origin main`,
    `${P} origin HEAD:refs/heads/visual-hold/a && ${P} origin HEAD:refs/heads/land/x`,
    `${P} origin HEAD:refs/heads/visual-hold/a\n${P} origin main`,
    `${P} origin HEAD:refs/heads/visual-hold/$(echo x)`,
    `${P} origin HEAD:refs/heads/visual-holdx/a`,
  ]) assert.ok(!exempt(c), c);
});
