// BRO-3396: triageCard() must refuse an LLM-drafted checkableDone that can
// never fail — `test -f <file that already exists>` is green before any work
// starts. Same classifier as the enricher's guardrail 2b and dispatch-guards'
// vacuousCheckGuard (card-premises-auditor.js classifyVacuousCheck).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { triageCard, decide } = require('../../scripts/lib/autonomous-triage-core.js');

const CARD = { name: 'Fix flaky date test', priority: 'P1 Next', category: 'Product', tags: ['ci'], notes: '## Problem\nA test flakes.' };
const base = { size: 'S', eligible: true, reason: 'Single test-file change with a clear runnable check.' };

function fixtureRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'triage-vacuous-'));
  fs.mkdirSync(path.join(root, 'tests', 'unit'), { recursive: true });
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(root, 'tests', 'unit', 'foo.test.mjs'), '// fixture\n');
  fs.writeFileSync(path.join(root, 'docs', 'existing.md'), '# already here\n');
  return root;
}

function scripted(...drafts) {
  const prompts = [];
  const fn = async (prompt) => {
    prompts.push(prompt);
    const d = drafts[Math.min(prompts.length - 1, drafts.length - 1)];
    return JSON.stringify({ ...base, checkableDone: d });
  };
  fn.prompts = prompts;
  return fn;
}

test('refuses `test -f <existing file>` on both attempts: skipped, never queued', async () => {
  const root = fixtureRepo();
  const llm = scripted('test -f docs/existing.md');
  const r = await triageCard(CARD, llm, { repoRoot: root });
  assert.equal(llm.prompts.length, 2, 'the model gets its one re-prompt');
  assert.match(llm.prompts[1], /checkableDone is vacuous/);
  assert.equal(r.failed, undefined, 'not failed: that would park the card until the owner clears it');
  assert.equal(r.triage.eligible, false);
  assert.match(r.triage.reason, /check-vacuous/);
  assert.equal(decide(r), 'skip');
});

test('vacuous first draft, falsifiable second draft: accepted', async () => {
  const root = fixtureRepo();
  const llm = scripted('test -f docs/existing.md', 'test -f docs/new-runbook.md');
  const r = await triageCard(CARD, llm, { repoRoot: root });
  assert.equal(llm.prompts.length, 2);
  assert.equal(r.triage.eligible, true);
  assert.equal(r.triage.checkableDone, 'test -f docs/new-runbook.md');
  assert.deepEqual(r.newCheckPaths, ['docs/new-runbook.md']);
  assert.equal(decide(r), 'attempt');
});

test('the near-match correction cannot launder an existing file into the check', async () => {
  const root = fixtureRepo();
  // tests/foo.test.mjs is absent, but resolveCheckPaths corrects it to the
  // existing tests/unit/foo.test.mjs — the FINAL string is what gets judged.
  const llm = scripted('test -f tests/foo.test.mjs');
  const r = await triageCard(CARD, llm, { repoRoot: root });
  assert.equal(r.triage.eligible, false);
  assert.match(r.triage.reason, /check-vacuous/);
});

test('arity error (`test -f a b`) is refused', async () => {
  const root = fixtureRepo();
  const r = await triageCard(CARD, scripted('test -f docs/a.md docs/b.md'), { repoRoot: root });
  assert.equal(r.triage.eligible, false);
  assert.match(r.triage.reason, /check-vacuous/);
});

test('an injected oracle that cannot resolve defers at once (no wasted retry)', async () => {
  const root = fixtureRepo();
  const llm = scripted('test -f docs/whatever.md');
  const r = await triageCard(CARD, llm, { repoRoot: root, checkPathExists: () => null });
  assert.equal(llm.prompts.length, 1);
  assert.equal(r.triage.eligible, false);
  assert.match(r.triage.reason, /check-vacuous: could not resolve/);
  assert.equal(decide(r), 'skip');
});

test('non test -f commands are untouched, even when the named test file exists', async () => {
  const root = fixtureRepo();
  const llm = scripted('node --test tests/unit/foo.test.mjs');
  const r = await triageCard(CARD, llm, { repoRoot: root });
  assert.equal(llm.prompts.length, 1);
  assert.equal(r.triage.eligible, true);
  assert.equal(decide(r), 'attempt');
});
