// BRO-6249 acceptance: planning-tier rule is wired and classifies tiers.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const pt = require('./planning-tier.js');

test('hook is folded into worktree-enforce.sh for Write', () => {
  const sh = fs.readFileSync(new URL('../../.claude/hooks/worktree-enforce.sh', import.meta.url), 'utf8');
  assert.match(sh, /planning-tier-hook\.js/);
});
test('CLAUDE.md defines the three tiers and no dead section 10 ref remains', () => {
  const md = fs.readFileSync(new URL('../../CLAUDE.md', import.meta.url), 'utf8');
  assert.match(md, /Three-Tier Planning/);
  for (const f of ['right-problem', 'plan-review']) {
    const c = fs.readFileSync(new URL(`../../.claude/commands/${f}.md`, import.meta.url), 'utf8');
    assert.doesNotMatch(c, /CLAUDE\.md §10/);
  }
});
test('a simple one-file edit is tier simple', () => {
  const r = pt.classify({ relPath: 'scripts/x.js', isNewFile: false, dirIsNew: false, newFilesInDir: 1, content: '', knownSecrets: new Set() });
  assert.equal(r.tier, 'simple');
});
