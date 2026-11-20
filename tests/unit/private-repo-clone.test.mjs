// BRO-7890 item 8: manual-review-direct.js cloned core data with `gh repo clone`, which 403s in cloud.
// Requires the real planner (CLAUDE.md rule 15) and checks the caller and the setup script use the same order.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { planPrivateRepoClone } = require('../../scripts/lib/private-repo-clone.js');
const R = 'thomaspryor/broadway-scorecard-data';

test('cloud session with a gh binary still clones through the git proxy, not gh', () => {
  const p = planPrivateRepoClone(R, '/tmp/x', { env: { CLAUDE_CODE_REMOTE: 'true' }, ghAvailable: true });
  assert.equal(p.method, 'proxy');
  assert.equal(p.cmd, 'git');
  assert.equal(p.env.GIT_TERMINAL_PROMPT, '0');
});

test('a token wins everywhere; local Mac without a token uses gh; nothing available returns null', () => {
  assert.equal(planPrivateRepoClone(R, '/tmp/x', { env: { GH_TOKEN: 't', CLAUDE_CODE_REMOTE: 'true' }, ghAvailable: true }).method, 'token');
  assert.equal(planPrivateRepoClone(R, '/tmp/x', { env: {}, ghAvailable: true }).method, 'gh');
  assert.equal(planPrivateRepoClone(R, '/tmp/x', { env: {}, ghAvailable: false }), null);
});

test('a bad slug is refused (argv is never shell-interpolated)', () => {
  assert.throws(() => planPrivateRepoClone('a/b; rm -rf /', '/tmp/x', { env: {} }));
});

test('no script clones a private repo with a bare `gh repo clone` call', () => {
  const src = fs.readFileSync(new URL('../../scripts/manual-review-direct.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /gh repo clone/);
  const sh = fs.readFileSync(new URL('../../scripts/setup-local-data.sh', import.meta.url), 'utf8');
  assert.ok(sh.indexOf('AUTH_METHOD="proxy"') < sh.indexOf('AUTH_METHOD="gh"'), 'setup-local-data.sh must try the cloud proxy before gh');
});

test('a failed token clone never puts the token in the thrown error', () => {
  const { clonePrivateRepo } = require('../../scripts/lib/private-repo-clone.js');
  assert.throws(
    () => clonePrivateRepo('nobody-x9/does-not-exist-x9', '/proc/no-write-here/x', { env: { GH_TOKEN: 'SEKRET123' } }),
    (e) => !String(e.message).includes('SEKRET123') && /token clone/.test(e.message),
  );
});
