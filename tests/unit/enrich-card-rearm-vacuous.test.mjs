/**
 * enrich-card-rearm-vacuous.test.mjs — BRO-3395.
 *
 * BRO-3378's audit named 31 Linear cards that are ARMED (evaluateVerifiability
 * says yes) but VACUOUS (their `test -f <file>` command already passes on
 * origin/main, so re-running it at Done time proves nothing). Nothing could
 * previously fix them: enrichOneCard()'s first line returns 'already armed'
 * for any armed card, and --force only bypasses the 'auto-enriched' tag
 * check, never that armed gate. This pins the fix — a --rearm path that:
 *
 *   1. Selects ARMED-but-VACUOUS cards (selectRearmCandidates), the opposite
 *      selection selectRefusedLinearIdentifiers makes (!armed).
 *   2. Refuses to touch a card whose acceptance section carries no
 *      'auto-enriched' marker (looks human-written) unless overridden
 *      (refuseRearmWrite / enrichOneCard's opts.rearm refusal).
 *   3. Writes the correction as a COMMENT, never updateIssue({description})
 *      (makeLinearRearmWriteCard) — settling the audit's own documented
 *      BRO-2796 contradiction in the direction the audit's comments assume.
 *
 * Per CLAUDE.md §15 this requires the real production functions.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const { enrichOneCard, makeLinearRearmWriteCard } = require(path.join(REPO, 'scripts/enrich-card-acceptance.js'));
const { selectRearmCandidates, refuseRearmWrite, isAutoEnrichedTag } = require(path.join(REPO, 'scripts/lib/card-rearm.js'));
const { evaluateVerifiability } = require(path.join(REPO, 'scripts/lib/verify-gate.js'));

const SCRATCH_LOG_PATH = path.join(os.tmpdir(), `enrich-card-rearm-test-${process.pid}.jsonl`);

// A file that genuinely exists in this repo — used so classifyVacuousCheck's
// `test -f` check can be exercised without a real git fetch (a synthetic
// existsFn stands in for origin/main).
const REAL_FILE = 'scripts/lib/verify-gate.js';
const existsFn = (p) => p === REAL_FILE;

function vacuousArmedIssue(over = {}) {
  return {
    identifier: 'BRO-1001',
    title: 'A card with a vacuous check',
    description: `## Problem\nSomething is broken.\n\n## Acceptance criteria\n\nVERIFY: test -f ${REAL_FILE}`,
    url: 'https://linear.app/x/BRO-1001',
    ...over,
  };
}

function unarmedIssue(over = {}) {
  return {
    identifier: 'BRO-1002',
    title: 'A card with no acceptance criteria at all',
    description: '## Problem\nSomething else is broken.',
    url: 'https://linear.app/x/BRO-1002',
    ...over,
  };
}

function armedNonVacuousIssue(over = {}) {
  return {
    identifier: 'BRO-1003',
    title: 'A card with a real, still-failing check',
    // Names a path that does not exist per existsFn -> present:false -> not vacuous.
    description: '## Acceptance criteria\n\nVERIFY: test -f scripts/lib/this-file-does-not-exist-yet.js',
    url: 'https://linear.app/x/BRO-1003',
    ...over,
  };
}

// ── selectRearmCandidates: the selection the enricher could never make ─────

test('selectRearmCandidates picks an ARMED card whose command is vacuous', () => {
  const out = selectRearmCandidates([vacuousArmedIssue()], existsFn);
  assert.equal(out.length, 1);
  assert.equal(out[0].identifier, 'BRO-1001');
  assert.equal(out[0].cmd, `test -f ${REAL_FILE}`);
  assert.equal(out[0].vacuous.kind, 'test-f-satisfied');
  // Sanity: the population is exactly what the dispatch gate itself deems armed.
  assert.equal(evaluateVerifiability(vacuousArmedIssue().description).armed, true);
});

test('selectRearmCandidates excludes an unarmed card (that is the ordinary enrich path\'s job)', () => {
  const out = selectRearmCandidates([unarmedIssue()], existsFn);
  assert.equal(out.length, 0);
});

test('selectRearmCandidates excludes an armed card whose command is NOT vacuous', () => {
  const out = selectRearmCandidates([armedNonVacuousIssue()], existsFn);
  assert.equal(out.length, 0);
});

test('selectRearmCandidates --identifiers restricts the sweep, still requiring armed+vacuous', () => {
  const issues = [vacuousArmedIssue(), vacuousArmedIssue({ identifier: 'BRO-2001' }), unarmedIssue()];
  const out = selectRearmCandidates(issues, existsFn, { identifiers: ['BRO-2001'] });
  assert.equal(out.length, 1);
  assert.equal(out[0].identifier, 'BRO-2001');
});

test('selectRearmCandidates does NOT select a card whose existsFn probe is unresolved (Codex adversarial-review finding)', () => {
  // A null existsFn (e.g. a git-fetch outage) is "cannot determine", not
  // "confirmed vacuous" — classifyVacuousCheck's own auditVacuousChecks
  // caller drops this kind for exactly that reason; selectRearmCandidates
  // must not treat it as a green light to redraft.
  const unresolvedExistsFn = () => null;
  const out = selectRearmCandidates([vacuousArmedIssue()], unresolvedExistsFn);
  assert.equal(out.length, 0, 'an unresolved probe must never authorize a rearm');
});

test('selectRearmCandidates sorts oldest-issue-number first, matching selectRefusedLinearIdentifiers\'s convention', () => {
  const issues = [
    vacuousArmedIssue({ identifier: 'BRO-500' }),
    vacuousArmedIssue({ identifier: 'BRO-42' }),
  ];
  const out = selectRearmCandidates(issues, existsFn);
  assert.deepEqual(out.map(c => c.identifier), ['BRO-42', 'BRO-500']);
});

// ── refuseRearmWrite: never clobber human-written acceptance criteria ──────

test('refuseRearmWrite refuses a card with no auto-enriched label', () => {
  const reason = refuseRearmWrite({ tags: ['bug'] });
  assert.ok(reason, 'must refuse');
  assert.match(reason, /auto-enriched/);
});

test('refuseRearmWrite allows a card that carries the auto-enriched label', () => {
  assert.equal(refuseRearmWrite({ tags: ['auto-enriched'] }), null);
  assert.equal(refuseRearmWrite({ tags: ['Auto-Enriched'] }), null, 'case-insensitive, matching isAutoEnrichedTag');
});

test('refuseRearmWrite allows a human-written card ONLY with the explicit override', () => {
  assert.equal(refuseRearmWrite({ tags: [] }, { allowHumanWritten: true }), null);
});

test('isAutoEnrichedTag matches the exact predicate enrichOneCard already uses for the Notion/Linear write-back tag', () => {
  assert.equal(isAutoEnrichedTag(['auto-enriched']), true);
  assert.equal(isAutoEnrichedTag(['bug', 'p1']), false);
  assert.equal(isAutoEnrichedTag([]), false);
  assert.equal(isAutoEnrichedTag(undefined), false);
});

// ── enrichOneCard(opts.rearm): bypasses the armed gate, refuses without the marker ──

test('enrichOneCard with rearm:true does NOT skip an armed card (the exact bug this fixes)', async () => {
  const card = {
    id: 'BRO-1001', name: 'A card with a vacuous check', tags: ['auto-enriched'],
    notes: vacuousArmedIssue().description,
  };
  // Confirm the premise: this card IS armed, so the non-rearm path would
  // return 'skipped'/'already armed' and never reach here.
  assert.equal(evaluateVerifiability(card.notes).armed, true);

  const writeCalls = [];
  const r = await enrichOneCard(card, {
    callLLM: async () => JSON.stringify({
      command: 'node --test tests/unit/bro-3395-rearm-example.test.mjs',
      acceptanceCriteria: '## Acceptance criteria\n- `node --test tests/unit/bro-3395-rearm-example.test.mjs` passes',
    }),
    writeCard: async (c, newNotes, newTagsCsv) => { writeCalls.push({ c, newNotes, newTagsCsv }); },
    existsOnOriginMain: () => false, // treat every drafted path as new/not-yet-created, no real git fetch
    logPath: SCRATCH_LOG_PATH,
    rearm: true,
  });

  assert.equal(r.action, 'llm-enriched', `expected the rearm draft to be accepted, got ${r.action}: ${r.detail}`);
  assert.equal(writeCalls.length, 1, 'a rearm write must happen exactly once');
});

test('enrichOneCard with rearm:true REFUSES a card with no auto-enriched marker (looks human-written), without calling the LLM or writing', async () => {
  const card = {
    id: 'BRO-1001', name: 'A card with a vacuous check', tags: [], // no auto-enriched label
    notes: vacuousArmedIssue().description,
  };
  let llmCalled = false;
  const writeCalls = [];
  const r = await enrichOneCard(card, {
    callLLM: async () => { llmCalled = true; return '{}'; },
    writeCard: async (...args) => { writeCalls.push(args); },
    existsOnOriginMain: () => false,
    logPath: SCRATCH_LOG_PATH,
    rearm: true,
  });

  assert.equal(r.action, 'refused');
  assert.match(r.detail, /auto-enriched/);
  assert.equal(llmCalled, false, 'a human-written card must never reach the LLM drafting step');
  assert.equal(writeCalls.length, 0, 'a refused card must never be written');
});

test('enrichOneCard with rearm:true AND allowHumanWritten:true proceeds despite no marker', async () => {
  const card = {
    id: 'BRO-1001', name: 'A card with a vacuous check', tags: [],
    notes: vacuousArmedIssue().description,
  };
  const writeCalls = [];
  const r = await enrichOneCard(card, {
    callLLM: async () => JSON.stringify({
      command: 'node --test tests/unit/bro-3395-override-example.test.mjs',
      acceptanceCriteria: '## Acceptance criteria\n- `node --test tests/unit/bro-3395-override-example.test.mjs` passes',
    }),
    writeCard: async (c, newNotes) => { writeCalls.push(newNotes); },
    existsOnOriginMain: () => false,
    logPath: SCRATCH_LOG_PATH,
    rearm: true,
    allowHumanWritten: true,
  });
  assert.equal(r.action, 'llm-enriched', `expected override to allow the write, got ${r.action}: ${r.detail}`);
  assert.equal(writeCalls.length, 1);
});

test('a non-rearm call is completely unaffected: an armed card is still skipped, an auto-enriched-tagged card without --force is still skipped', async () => {
  const armedCard = { id: 'x', name: 'x', tags: [], notes: vacuousArmedIssue().description };
  const r1 = await enrichOneCard(armedCard, { callLLM: async () => '{}', notionBrain: () => ({}) });
  assert.equal(r1.action, 'skipped');
  assert.equal(r1.detail, 'already armed');

  const enrichedCard = { id: 'y', name: 'y', tags: ['auto-enriched'], notes: '## Problem\nno criteria yet' };
  const r2 = await enrichOneCard(enrichedCard, { callLLM: async () => '{}', notionBrain: () => ({}) });
  assert.equal(r2.action, 'skipped');
  assert.equal(r2.detail, 'already tagged auto-enriched');
});

// ── makeLinearRearmWriteCard: comment, never a description rewrite ─────────

function fakeLinearClient(calls) {
  return {
    createComment: async (issueId, body) => { calls.push({ fn: 'createComment', issueId, body }); return { success: true }; },
    updateIssue: async (id, input) => { calls.push({ fn: 'updateIssue', id, input }); },
    findOrCreateLabel: async (teamId, name) => { calls.push({ fn: 'findOrCreateLabel', teamId, name }); return { id: 'label-1' }; },
    addLabelToIssue: async (issueId, labelId) => { calls.push({ fn: 'addLabelToIssue', issueId, labelId }); },
  };
}

test('makeLinearRearmWriteCard posts a COMMENT and never calls updateIssue (settles the BRO-2796 contradiction)', async () => {
  const calls = [];
  const client = fakeLinearClient(calls);
  const writeCard = makeLinearRearmWriteCard(client, 'team-1');
  const newNotes = '## Problem\nSomething is broken.\n\n## Acceptance criteria\n\nVERIFY: node --test tests/unit/example.test.mjs\n';

  await writeCard({ id: 'BRO-1001' }, newNotes);

  const updateCalls = calls.filter(c => c.fn === 'updateIssue');
  assert.equal(updateCalls.length, 0, 'BRO-2796: a Linear description must never be edited by the rearm path');

  const commentCalls = calls.filter(c => c.fn === 'createComment');
  assert.equal(commentCalls.length, 1);
  assert.equal(commentCalls[0].issueId, 'BRO-1001');
  assert.match(commentCalls[0].body, /## Acceptance criteria/);
  assert.match(commentCalls[0].body, /node --test tests\/unit\/example\.test\.mjs/);
  assert.doesNotMatch(commentCalls[0].body, /## Problem/, 'the comment carries only the drafted section, not the whole card body');

  assert.equal(calls.filter(c => c.fn === 'findOrCreateLabel').length, 1);
  assert.equal(calls.filter(c => c.fn === 'addLabelToIssue').length, 1);
});

test('makeLinearRearmWriteCard strips a stale, still-safe-shaped vacuous command that survives alongside an appended owner-judgment marker (Codex adversarial-review finding)', async () => {
  // Mirrors exactly what enrichOneCard's human-territory branch produces for
  // a REARM card: the ORIGINAL "## Acceptance criteria" section (still
  // carrying the old, safe-form-shaped-but-vacuous command) with
  // "VERIFY: owner-judgment" appended after it, not replacing it.
  const newNotes = `## Problem\nSomething is broken.\n\n## Acceptance criteria\n\nVERIFY: test -f ${REAL_FILE}\n\nVERIFY: owner-judgment`;
  const calls = [];
  const client = fakeLinearClient(calls);
  const writeCard = makeLinearRearmWriteCard(client, 'team-1');

  await writeCard({ id: 'BRO-1001' }, newNotes);

  const commentBody = calls.find(c => c.fn === 'createComment').body;
  // The posted comment must arm ONLY via ownerJudgment — never carry forward
  // the stale command, which would silently re-arm the exact vacuous check
  // this whole path exists to retire.
  const gate = evaluateVerifiability(commentBody);
  assert.equal(gate.ownerJudgment, true);
  assert.equal(gate.cmd, null, `stale command leaked into the comment: ${gate.cmd}`);
  assert.doesNotMatch(commentBody, new RegExp(REAL_FILE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});
