// BRO-6285: sessions emailed the owner free-form questions ("reply yes to
// Claude or Codex") that no session could receive. The owner asked for
// guidelines, not a gate: docs/owner-email-guidelines.md. /docs/* is
// gitignored, so this pins that the doc exists, is not ignored, keeps its
// load-bearing rules, and that CLOUD.md and AGENTS.md still point at it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const REL = 'docs/owner-email-guidelines.md';

// exit 0 = ignored, 1 = not ignored; anything else is a git failure, not a pass.
function isIgnored(rel) {
  const { status } = spawnSync('git', ['check-ignore', '-q', '--no-index', rel], { cwd: ROOT, stdio: 'ignore' });
  assert.ok(status === 0 || status === 1, `git check-ignore failed (exit ${status})`);
  return status === 0;
}

test('the guidelines doc exists and is not gitignored', () => {
  assert.ok(fs.existsSync(path.join(ROOT, REL)), `${REL} is missing`);
  assert.equal(isIgnored(REL), false, `${REL} is gitignored: keep the !/${REL} line under /docs/* in .gitignore`);
});

test('the doc keeps its load-bearing rules', () => {
  const doc = fs.readFileSync(path.join(ROOT, REL), 'utf8');
  assert.match(doc, /DECISION NEEDED/, 'questions must be routed to a DECISION NEEDED card');
  assert.match(doc, /one named session/i, 'must say a chat reply reaches one named session only');
  assert.match(doc, /owner-decision-recall/, 'must say to check for an existing answer first');
  assert.match(doc, /## Bad example/);
  assert.match(doc, /## Good example/);
  assert.equal(doc.includes('—'), false, 'the owner bans em dashes; the doc must model that');
});

for (const file of ['.claude/CLOUD.md', 'AGENTS.md']) {
  test(`${file} points sessions at the doc`, () => {
    const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
    assert.ok(text.includes(REL), `${file} no longer mentions ${REL}`);
  });
}
