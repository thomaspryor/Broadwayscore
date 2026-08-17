import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { enrichOneCard, spliceNotes } = require('./enrich-card-acceptance.js');

function fakeNotionBrain(calls) {
  return (args) => { calls.push(args); return { id: args[1] }; };
}

// Real (non-dryRun) writes call logEnrichmentWrite — point it at a scratch
// path so fixture card IDs never land in the repo's real audit log.
const SCRATCH_LOG_PATH = path.join(os.tmpdir(), `enrich-card-acceptance-test-${process.pid}.jsonl`);

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
    logPath: SCRATCH_LOG_PATH,
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
  const r = await enrichOneCard(card, { callLLM: async () => '{}', notionBrain: fakeNotionBrain(calls), logPath: SCRATCH_LOG_PATH });
  assert.equal(r.action, 'owner-judgment');
});

// Task #1186: a technical deny-tag rejection (email/commercial/scoring/
// ios-app) is not owner-judgment — it must NOT get the hard-blocking bare
// marker, and must instead reach the same LLM-drafted path an eligible card
// would.
test('deny-tagged technical card (scoring) does NOT get owner-judgment — reaches the LLM path instead', async () => {
  const calls = [];
  let llmCalled = false;
  const card = {
    id: 'd1', name: 'Fix a scoring script bug', category: 'Product', tags: ['scoring'],
    notes: '## Problem\nSomething in the scoring pipeline is wrong.',
  };
  const r = await enrichOneCard(card, {
    callLLM: async () => { llmCalled = true; return JSON.stringify({ command: 'npx tsc --noEmit', acceptanceCriteria: '## Acceptance criteria\n`npx tsc --noEmit` is clean' }); },
    notionBrain: fakeNotionBrain(calls),
    logPath: SCRATCH_LOG_PATH,
  });
  assert.equal(r.action, 'llm-enriched');
  assert.equal(llmCalled, true);
  assert.equal(calls.length, 1);
  const notesIdx = calls[0].indexOf('--notes');
  assert.doesNotMatch(calls[0][notesIdx + 1], /VERIFY: owner-judgment/);
});

// 'owner-action' is the one DENY_TAGS entry that IS genuinely human-territory
// (autonomous-eligibility.js docstring: "cards that need the OWNER
// personally") — it must keep getting the marker, unlike the other deny-tags.
test('owner-action tagged card still gets owner-judgment, no LLM call', async () => {
  const calls = [];
  let llmCalled = false;
  const card = {
    id: 'd2', name: 'Reconnect App Store Connect', category: 'Product', tags: ['owner-action'],
    notes: 'Needs the owner to re-auth.',
  };
  const r = await enrichOneCard(card, {
    callLLM: async () => { llmCalled = true; return '{}'; },
    notionBrain: fakeNotionBrain(calls),
    logPath: SCRATCH_LOG_PATH,
  });
  assert.equal(r.action, 'owner-judgment');
  assert.equal(llmCalled, false);
  const notesIdx = calls[0].indexOf('--notes');
  assert.match(calls[0][notesIdx + 1], /VERIFY: owner-judgment/);
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
    logPath: SCRATCH_LOG_PATH,
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

test('eligible card: LLM drafts a mutating command — rejected before ever writing', async () => {
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
  assert.match(r.detail, /not a safe-form shape/);
  assert.equal(calls.length, 0);
});

test('eligible card: LLM drafts a SAFE primary command but a mutating command rides along in the prose — rejected, zero writes', async () => {
  const calls = [];
  const card = {
    id: 'c3b', name: 'Fix scoring bug', category: 'Product', tags: [],
    notes: '## Problem\nSomething scores wrong.',
  };
  const r = await enrichOneCard(card, {
    callLLM: async () => JSON.stringify({
      command: 'npx tsc --noEmit',
      acceptanceCriteria: '## Acceptance criteria\nFirst run `node scripts/rebuild-all-reviews.js` to refresh, then verify with `npx tsc --noEmit`.',
    }),
    notionBrain: fakeNotionBrain(calls),
  });
  assert.equal(r.action, 'failed');
  assert.match(r.detail, /names an additional unsafe command/);
  assert.match(r.detail, /rebuild-all-reviews/);
  assert.equal(calls.length, 0);
});

// task #1713: a narrower guardrail-3 filter (only flag backtick spans with
// whitespace or /) was tried to reduce false-positive rejections of bare
// identifiers like `wrongProduction`, then REVERTED after adversarial review
// pointed out a single PATH executable (e.g. `make`) is a valid unsafe
// command with neither — so a bare-identifier-shaped extra command must
// still be rejected, same as any other unsanctioned command in the prose.
test('eligible card: LLM draft mentions an unsafe SINGLE-TOKEN command in backticks — still rejected (guardrail-3 stays conservative)', async () => {
  const calls = [];
  const card = {
    id: 'c7', name: 'Fix scoring bug', category: 'Product', tags: [],
    notes: '## Problem\nSomething scores wrong.',
  };
  const r = await enrichOneCard(card, {
    callLLM: async () => JSON.stringify({
      command: 'npx tsc --noEmit',
      acceptanceCriteria: '## Acceptance criteria\nRun `make` to rebuild first, then verify with `npx tsc --noEmit`.',
    }),
    notionBrain: fakeNotionBrain(calls),
  });
  assert.equal(r.action, 'failed');
  assert.match(r.detail, /names an additional unsafe command/);
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
    logPath: SCRATCH_LOG_PATH,
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
