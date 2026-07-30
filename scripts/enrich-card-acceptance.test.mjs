import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { enrichOneCard, spliceNotes } = require('./enrich-card-acceptance.js');

function fakeNotionBrain(calls) {
  return (args) => { calls.push(args); return { id: args[1] }; };
}

test('already-armed card is skipped with zero LLM calls and zero writes', async () => {
  const calls = [];
  let llmCalled = false;
  const card = {
    id: 'a1', name: 'Fix the thing', category: 'Product', tags: [],
    notes: '## Acceptance criteria\n`npx tsc --noEmit`',
  };
  const r = await enrichOneCard(card, {
    callLLM: async () => { llmCalled = true; return '{}'; },
    notionBrain: fakeNotionBrain(calls),
  });
  assert.equal(r.action, 'skipped');
  assert.equal(llmCalled, false);
  assert.equal(calls.length, 0);
});

test('already auto-enriched card is skipped unless --force', async () => {
  const calls = [];
  const card = {
    id: 'a2', name: 'Some prose card', category: 'Product', tags: ['auto-enriched'],
    notes: 'Just prose, no criteria.',
  };
  const r = await enrichOneCard(card, { callLLM: async () => '{}', notionBrain: fakeNotionBrain(calls) });
  assert.equal(r.action, 'skipped');
  assert.equal(calls.length, 0);
});

test('human-only card (marketing category) gets VERIFY: owner-judgment, no LLM call', async () => {
  const calls = [];
  let llmCalled = false;
  const card = {
    id: 'b1', name: 'Pitch kit for industry intros', category: 'Marketing', tags: [],
    notes: '## Problem\nNeed a forwardable blurb.',
  };
  const r = await enrichOneCard(card, {
    callLLM: async () => { llmCalled = true; return '{}'; },
    notionBrain: fakeNotionBrain(calls),
  });
  assert.equal(r.action, 'owner-judgment');
  assert.equal(llmCalled, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'update');
  assert.equal(calls[0][1], 'b1');
  const notesIdx = calls[0].indexOf('--notes');
  assert.match(calls[0][notesIdx + 1], /VERIFY: owner-judgment/);
  const tagsIdx = calls[0].indexOf('--tags');
  assert.match(calls[0][tagsIdx + 1], /auto-enriched/);
});

test('human-action title with no category gets owner-judgment', async () => {
  const calls = [];
  const card = { id: 'b2', name: 'Email volunteers', category: '', tags: [], notes: 'Reach out.' };
  const r = await enrichOneCard(card, { callLLM: async () => '{}', notionBrain: fakeNotionBrain(calls) });
  assert.equal(r.action, 'owner-judgment');
});

test('eligible card: LLM drafts a valid tsc command, notes are updated and re-verified armed', async () => {
  const calls = [];
  const card = {
    id: 'c1', name: 'Fix scoring bug', category: 'Product', tags: [],
    notes: '## Problem\nSomething scores wrong.',
  };
  const r = await enrichOneCard(card, {
    callLLM: async () => JSON.stringify({ command: 'npx tsc --noEmit', acceptanceCriteria: '## Acceptance criteria\n`npx tsc --noEmit` is clean' }),
    notionBrain: fakeNotionBrain(calls),
  });
  assert.equal(r.action, 'llm-enriched');
  assert.equal(r.detail, 'npx tsc --noEmit');
  assert.equal(calls.length, 1);
  const notesIdx = calls[0].indexOf('--notes');
  assert.match(calls[0][notesIdx + 1], /Acceptance criteria/);
  assert.match(calls[0][notesIdx + 1], /npx tsc --noEmit/);
});

test('eligible card: LLM drafts a phantom test path with no real parent dir — rejected, zero writes', async () => {
  const calls = [];
  const card = {
    id: 'c2', name: 'Fix scoring bug', category: 'Product', tags: [],
    notes: '## Problem\nSomething scores wrong.',
  };
  const r = await enrichOneCard(card, {
    callLLM: async () => JSON.stringify({
      command: 'node --test tests/totally-made-up-dir/thing.test.mjs',
      acceptanceCriteria: '## Acceptance criteria\n`node --test tests/totally-made-up-dir/thing.test.mjs` passes',
    }),
    notionBrain: fakeNotionBrain(calls),
  });
  assert.equal(r.action, 'failed');
  assert.match(r.detail, /phantom path rejected/);
  assert.equal(calls.length, 0);
});

test('eligible card: LLM drafts a mutating command — final gate rejects, zero writes', async () => {
  const calls = [];
  const card = {
    id: 'c3', name: 'Fix scoring bug', category: 'Product', tags: [],
    notes: '## Problem\nSomething scores wrong.',
  };
  const r = await enrichOneCard(card, {
    callLLM: async () => JSON.stringify({
      command: 'node scripts/rebuild-all-reviews.js',
      acceptanceCriteria: '## Acceptance criteria\nrun `node scripts/rebuild-all-reviews.js` and check the diff',
    }),
    notionBrain: fakeNotionBrain(calls),
  });
  assert.equal(r.action, 'failed');
  assert.match(r.detail, /drafted notes still fail verify-gate/);
  assert.equal(calls.length, 0);
});

test('eligible card: LLM call throws — failed, zero writes', async () => {
  const calls = [];
  const card = { id: 'c4', name: 'Fix scoring bug', category: 'Product', tags: [], notes: '## Problem\nBug.' };
  const r = await enrichOneCard(card, {
    callLLM: async () => { throw new Error('ECONNRESET'); },
    notionBrain: fakeNotionBrain(calls),
  });
  assert.equal(r.action, 'failed');
  assert.match(r.detail, /LLM call failed/);
  assert.equal(calls.length, 0);
});

test('eligible card: LLM names a NEW test under tests/unit/ (real dir) — accepted as a to-be-created artifact', async () => {
  const calls = [];
  const card = {
    id: 'c6', name: 'Fix scoring bug', category: 'Product', tags: [],
    notes: '## Problem\nSomething scores wrong.',
  };
  const r = await enrichOneCard(card, {
    callLLM: async () => JSON.stringify({
      command: 'node --test tests/unit/scoring-bug-c6.test.mjs',
      acceptanceCriteria: '## Acceptance criteria\n`node --test tests/unit/scoring-bug-c6.test.mjs` passes',
    }),
    notionBrain: fakeNotionBrain(calls),
  });
  assert.equal(r.action, 'llm-enriched');
  assert.equal(r.detail, 'node --test tests/unit/scoring-bug-c6.test.mjs');
  assert.deepEqual(r.newPaths, ['tests/unit/scoring-bug-c6.test.mjs']);
  assert.equal(calls.length, 1);
});

test('dry-run mode never calls notionBrain even on a successful enrichment', async () => {
  const calls = [];
  const card = { id: 'c5', name: 'Fix scoring bug', category: 'Product', tags: [], notes: '## Problem\nBug.' };
  const r = await enrichOneCard(card, {
    callLLM: async () => JSON.stringify({ command: 'npx next lint', acceptanceCriteria: '## Acceptance criteria\n`npx next lint` is clean' }),
    notionBrain: fakeNotionBrain(calls),
    dryRun: true,
  });
  assert.equal(r.action, 'llm-enriched');
  assert.equal(calls.length, 0);
});

test('spliceNotes: replaces an existing unarmed Acceptance criteria section in place', () => {
  const original = '## Problem\nBug.\n\n## Acceptance criteria\nThe owner agrees it looks better.\n\n## What was already tried\nNothing.';
  const drafted = '## Acceptance criteria\n`npx tsc --noEmit` is clean';
  const result = spliceNotes(original, drafted);
  assert.match(result, /npx tsc --noEmit/);
  assert.match(result, /## What was already tried/);
  assert.doesNotMatch(result, /owner agrees it looks better/);
});

test('spliceNotes: appends when no existing section is present', () => {
  const result = spliceNotes('## Problem\nBug.', '## Acceptance criteria\n`npx tsc --noEmit`');
  assert.match(result, /## Problem/);
  assert.match(result, /## Acceptance criteria/);
});
