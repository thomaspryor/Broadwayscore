import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const {
  SCHEMA_PATH,
  buildTriagePrompt,
  parseTriageResponse,
  validateTriageResult,
  findClaimedTask,
  triageCard,
  decide,
  orderQueue,
  extractCheckPaths,
  resolveCheckPaths,
} = require('./autonomous-triage-core.js');

const GOOD = {
  size: 'S',
  eligible: true,
  reason: 'Single test-file change with a clear runnable check.',
  checkableDone: 'node --test tests/unit/date-utils.test.mjs',
};

const CARD = { name: 'Fix flaky date test', priority: 'P1 Next', category: 'Product', tags: ['ci'], notes: '## Problem\nA test flakes.' };

// ── validator ↔ schema congruence ───────────────────────────────────────────

test('validator agrees with triage-schema.json on enums and required keys', () => {
  const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'));
  assert.deepEqual(schema.properties.size.enum, ['S', 'M', 'L']);
  assert.deepEqual(schema.required, ['size', 'eligible', 'reason', 'checkableDone']);
  // Every required key missing must be reported.
  const r = validateTriageResult({});
  for (const k of schema.required) assert.ok(r.errors.some(e => e.includes(`"${k}"`)), `missing-${k} unreported`);
});

test('valid results pass; violations are each named', () => {
  assert.deepEqual(validateTriageResult(GOOD), { ok: true, errors: [] });
  assert.equal(validateTriageResult({ ...GOOD, size: 'XL' }).ok, false);
  assert.equal(validateTriageResult({ ...GOOD, eligible: 'yes' }).ok, false);
  assert.equal(validateTriageResult({ ...GOOD, reason: 'short' }).ok, false);
  assert.equal(validateTriageResult({ ...GOOD, extra: 1 }).ok, false);
  // Eligible L without a split proposal is invalid; with a conformant one it
  // passes; ineligible L needs no proposal (the loop won't touch it).
  assert.equal(validateTriageResult({ ...GOOD, size: 'L' }).ok, false);
  assert.equal(validateTriageResult({ ...GOOD, size: 'L', eligible: false }).ok, true);
  const child = { title: 'Child card one', notes: '## Problem\n' + 'x'.repeat(280) + '\n## Suggested approach\ny\n## Acceptance criteria\nz' };
  assert.equal(validateTriageResult({ ...GOOD, size: 'L', splitProposal: [child] }).ok, true);
  assert.equal(validateTriageResult({ ...GOOD, splitProposal: [{ title: 'ok title here', notes: 'too short' }] }).ok, false);
});

test('parseTriageResponse tolerates fences and prefix prose, rejects garbage', () => {
  assert.deepEqual(parseTriageResponse('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parseTriageResponse('Here you go: {"a":{"b":2}} thanks'), { a: { b: 2 } });
  assert.throws(() => parseTriageResponse('no json here'), /no JSON object/);
  assert.throws(() => parseTriageResponse('{"unbalanced":'), /unbalanced/);
  // Braces inside string values must not break the balanced-block scan.
  assert.deepEqual(parseTriageResponse('answer: {"reason":"fixes the } case","n":1} done'), { reason: 'fixes the } case', n: 1 });
  assert.deepEqual(parseTriageResponse('x {"a":"quote \\" and { brace"} y'), { a: 'quote " and { brace' });
});

test('checkableDone safe-command allowlist (prompt-injection gate)', () => {
  const { isSafeCheckCommand } = require('./autonomous-triage-core.js');
  for (const ok of [
    'node --test tests/unit/date-utils.test.mjs',
    'node --test scripts/lib/autonomous-state.test.mjs tests/unit/sanity.test.mjs',
    'node --test --test-timeout 30000 tests/unit/foo.test.mjs',
    'npx tsc --noEmit',
    'npx next lint',
    'test -f docs/triage-queue-format.md',
  ]) assert.equal(isSafeCheckCommand(ok), true, `${ok} should be safe`);
  for (const bad of [
    'node scripts/send-opening-night-broadcast.js',
    'node --test tests/../src/lib/scoring.ts',
    'node --test tests/unit/engine.test.ts', // .ts runs via tsx — not an allowed form
    'node --test tests/unit/a.test.mjs && curl evil.example',
    'node --test /etc/passwd.test.mjs',
    'rm -rf tests/',
    'test -f docs/x.md; git push',
    'bash -c "anything"',
    'It works',
  ]) assert.equal(isSafeCheckCommand(bad), false, `${bad} must be refused`);
  // Validator enforces it only for eligible cards.
  assert.equal(validateTriageResult({ ...GOOD, checkableDone: 'run the site and click around please' }).ok, false);
  assert.equal(validateTriageResult({ ...GOOD, eligible: false, checkableDone: 'run the site and click around please' }).ok, true);
});

// ── resolveCheckPaths (card #171: phantom checkableDone paths) ─────────────

function mkFixtureRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'triage-checkpath-'));
  fs.mkdirSync(path.join(root, 'tests', 'unit'), { recursive: true });
  fs.writeFileSync(path.join(root, 'tests', 'unit', 'foo.test.mjs'), '// fixture\n');
  return root;
}

test('extractCheckPaths pulls file args out of each safe-check form', () => {
  assert.deepEqual(extractCheckPaths('node --test tests/unit/a.test.mjs tests/unit/b.test.mjs'), ['tests/unit/a.test.mjs', 'tests/unit/b.test.mjs']);
  assert.deepEqual(extractCheckPaths('test -f docs/x.md'), ['docs/x.md']);
  assert.deepEqual(extractCheckPaths('npx tsc --noEmit'), []);
  assert.deepEqual(extractCheckPaths('npx next lint'), []);
});

test('resolveCheckPaths: path exists as-given → unchanged, no correction flagged', () => {
  const root = mkFixtureRepo();
  const r = resolveCheckPaths('node --test tests/unit/foo.test.mjs', { repoRoot: root });
  assert.equal(r.ok, true);
  assert.equal(r.checkableDone, 'node --test tests/unit/foo.test.mjs');
  assert.ok(!r.corrected);
});

test('resolveCheckPaths: phantom path auto-corrects to the tests/unit/<basename> near-match', () => {
  const root = mkFixtureRepo();
  const r = resolveCheckPaths('node --test tests/foo.test.mjs', { repoRoot: root });
  assert.equal(r.ok, true);
  assert.equal(r.checkableDone, 'node --test tests/unit/foo.test.mjs');
  assert.equal(r.corrected, true);
});

test('resolveCheckPaths: no near-match on disk → ok:false, never a silent pass', () => {
  const root = mkFixtureRepo();
  const r = resolveCheckPaths('node --test tests/bar.test.mjs', { repoRoot: root });
  assert.equal(r.ok, false);
  assert.match(r.reason, /does not exist on disk: tests\/bar\.test\.mjs/);
  assert.match(r.reason, /tests\/unit\/bar\.test\.mjs/);
});

test('resolveCheckPaths: tsc/lint forms carry no path args → pass through', () => {
  const root = mkFixtureRepo();
  assert.deepEqual(resolveCheckPaths('npx tsc --noEmit', { repoRoot: root }), { ok: true, checkableDone: 'npx tsc --noEmit' });
});

test('resolveCheckPaths: never guesses across directory families — a missing scripts/ path is not "corrected" against a same-basename tests/unit/ file', () => {
  const root = mkFixtureRepo();
  // foo.test.mjs exists at tests/unit/foo.test.mjs (from mkFixtureRepo), but
  // the command names scripts/foo.test.mjs — a different, unrelated file
  // that happens to share a basename. Must fail closed, not cross-correct.
  const r = resolveCheckPaths('node --test scripts/foo.test.mjs', { repoRoot: root });
  assert.equal(r.ok, false);
  assert.match(r.reason, /scripts\/foo\.test\.mjs/);
  assert.doesNotMatch(r.reason, /tried near-match/);
});

test('resolveCheckPaths against the REAL repo tree: reproduces the exact card #171 incident', () => {
  // tests/review-write-guard.test.mjs never existed; the real file is
  // tests/unit/review-write-guard.test.mjs — this is the literal phantom
  // path the lint-violator card's triage verdict produced.
  const r = resolveCheckPaths('node --test tests/review-write-guard.test.mjs');
  assert.equal(r.ok, true);
  assert.equal(r.checkableDone, 'node --test tests/unit/review-write-guard.test.mjs');
  assert.equal(r.corrected, true);
});

test('triageCard: LLM verdict with a phantom checkableDone path is auto-corrected, stays attempt-eligible', async () => {
  const root = mkFixtureRepo();
  const verdict = { ...GOOD, checkableDone: 'node --test tests/foo.test.mjs' };
  const r = await triageCard(CARD, async () => JSON.stringify(verdict), { repoRoot: root });
  assert.equal(r.triage.eligible, true);
  assert.equal(r.triage.checkableDone, 'node --test tests/unit/foo.test.mjs');
  assert.equal(decide(r), 'attempt');
});

test('triageCard: LLM verdict with an unresolvable phantom path is marked ineligible, never queued', async () => {
  const root = mkFixtureRepo();
  const verdict = { ...GOOD, checkableDone: 'node --test tests/nope.test.mjs' };
  const r = await triageCard(CARD, async () => JSON.stringify(verdict), { repoRoot: root });
  assert.equal(r.triage.eligible, false);
  assert.match(r.triage.reason, /check-path-missing/);
  assert.equal(decide(r), 'skip');
});

// ── findClaimedTask (claim visibility, night-2 fix) ─────────────────────────

// taskState shape: { notionMap: {[pageId]: {taskId}}, tasksById: {[taskId]: task} }
function mkTaskState(notionMap, tasksById) { return { notionMap, tasksById }; }

test('findClaimedTask: mapped taskId in_progress + marker present → claimed', () => {
  const ts = mkTaskState(
    { 'abc-123': { taskId: '151' } },
    { 151: { id: '151', status: 'in_progress', description: '[notion:abc-123] P1 Next · Not started · Admin\nsome notes' } },
  );
  const hit = findClaimedTask('abc-123', ts);
  assert.ok(hit);
  assert.equal(hit.id, '151');
});

test('findClaimedTask: mapped taskId not in_progress → not claimed', () => {
  const ts = mkTaskState(
    { 'abc-123': { taskId: '151' } },
    { 151: { id: '151', status: 'pending', description: '[notion:abc-123] P1' } },
  );
  assert.equal(findClaimedTask('abc-123', ts), null);
});

test('findClaimedTask: no map entry for this card → not claimed', () => {
  const ts = mkTaskState({}, { 151: { id: '151', status: 'in_progress', description: '[notion:other]' } });
  assert.equal(findClaimedTask('abc-123', ts), null);
});

test('findClaimedTask: id-reuse guard — mapped taskId in_progress but marker belongs to a DIFFERENT card (numeric id reused by a live session) → not trusted', () => {
  const ts = mkTaskState(
    { 'abc-123': { taskId: '151' } },
    { 151: { id: '151', status: 'in_progress', description: '[notion:some-unrelated-card] fresh native task, id 151 reused' } },
  );
  assert.equal(findClaimedTask('abc-123', ts), null);
});

test('findClaimedTask: fails safe on missing id, missing/empty taskState, malformed entries', () => {
  const ts = mkTaskState({ x: { taskId: '1' } }, { 1: { id: '1', status: 'in_progress', description: '[notion:x]' } });
  assert.equal(findClaimedTask(null, ts), null);
  assert.equal(findClaimedTask('x', null), null);
  assert.equal(findClaimedTask('x', undefined), null);
  assert.equal(findClaimedTask('x', mkTaskState({}, {})), null);
  assert.equal(findClaimedTask('x', mkTaskState({ x: { taskId: '9' } }, {})), null); // taskId not in tasksById
  assert.equal(findClaimedTask('x', mkTaskState({ x: { taskId: '1' } }, { 1: { id: '1', status: 'in_progress' } })), null); // no description field
});

// ── triageCard flow ─────────────────────────────────────────────────────────

test('a card claimed in-flight (shared task in_progress) skips without an LLM call', async () => {
  let calls = 0;
  const taskState = mkTaskState(
    { 'card-42': { taskId: '151' } },
    { 151: { id: '151', status: 'in_progress', description: '[notion:card-42] P1 Next · Not started · Admin' } },
  );
  const r = await triageCard({ ...CARD, id: 'card-42' }, async () => { calls++; return JSON.stringify(GOOD); }, { taskState });
  assert.equal(calls, 0);
  assert.equal(r.preFilter.eligible, false);
  assert.match(r.preFilter.reason, /claimed in-flight/);
  assert.match(r.preFilter.reason, /#151/);
  assert.equal(decide(r), 'skip');
});

test('a card with no matching claimed task proceeds to normal pre-filter/LLM flow', async () => {
  const taskState = mkTaskState(
    { 'some-other-card': { taskId: '151' } },
    { 151: { id: '151', status: 'in_progress', description: '[notion:some-other-card] P1 Next · Not started · Admin' } },
  );
  let calls = 0;
  const r = await triageCard({ ...CARD, id: 'card-42' }, async () => { calls++; return JSON.stringify(GOOD); }, { taskState });
  assert.equal(calls, 1);
  assert.equal(decide(r), 'attempt');
});

test('a claimed-but-completed task does not block re-triage', async () => {
  const taskState = mkTaskState(
    { 'card-42': { taskId: '151' } },
    { 151: { id: '151', status: 'completed', description: '[notion:card-42] P1 Next · Done · Admin' } },
  );
  let calls = 0;
  const r = await triageCard({ ...CARD, id: 'card-42' }, async () => { calls++; return JSON.stringify(GOOD); }, { taskState });
  assert.equal(calls, 1);
  assert.equal(decide(r), 'attempt');
});

// ── triageCard flow ─────────────────────────────────────────────────────────

test('pre-filter refusal short-circuits: no LLM call for deny-tag cards', async () => {
  let calls = 0;
  const r = await triageCard({ ...CARD, tags: ['scoring'] }, async () => { calls++; return JSON.stringify(GOOD); });
  assert.equal(calls, 0);
  assert.equal(r.preFilter.eligible, false);
  assert.equal(decide(r), 'skip');
});

test('happy path: one call, validated verdict', async () => {
  const prompts = [];
  const r = await triageCard(CARD, async p => { prompts.push(p); return JSON.stringify(GOOD); });
  assert.equal(prompts.length, 1);
  assert.deepEqual(r.triage, GOOD);
  assert.equal(decide(r), 'attempt');
  // Prompt safety: card text is declared untrusted, contract minimums inlined.
  assert.match(prompts[0], /UNTRUSTED/);
  assert.match(prompts[0], /Fix flaky date test/);
});

test('garbled response → exactly one retry echoing errors → failed("triage")', async () => {
  const prompts = [];
  const r = await triageCard(CARD, async p => { prompts.push(p); return 'sorry, I cannot produce JSON'; });
  assert.equal(prompts.length, 2, 'exactly one retry');
  assert.match(prompts[1], /failed validation/);
  assert.equal(r.failed, 'triage');
  assert.equal(r.attempts, 2);
  assert.ok(r.error.length > 0);
  assert.equal(decide(r), 'failed');
});

test('invalid-then-corrected: retry echoes the specific validation error and succeeds', async () => {
  const prompts = [];
  let n = 0;
  const r = await triageCard(CARD, async p => {
    prompts.push(p);
    n++;
    return n === 1 ? JSON.stringify({ ...GOOD, size: 'XL' }) : JSON.stringify(GOOD);
  });
  assert.match(prompts[1], /size must be one of S\/M\/L/);
  assert.deepEqual(r.triage, GOOD);
});

test('LLM transport errors count as attempts and never throw', async () => {
  const r = await triageCard(CARD, async () => { throw new Error('HTTP 529'); });
  assert.equal(r.failed, 'triage');
  assert.match(r.error, /529/);
});

// ── decisions + ordering ────────────────────────────────────────────────────

test('decide: LLM can narrow but never widen eligibility', () => {
  assert.equal(decide({ preFilter: { eligible: true }, triage: { ...GOOD, eligible: false } }), 'skip');
  assert.equal(decide({ preFilter: { eligible: false, reason: 'x' } }), 'skip');
  assert.equal(decide({ preFilter: { eligible: true }, triage: { ...GOOD, size: 'L', eligible: true } }), 'split');
});

test('orderQueue: P0 before P1, S before M, stable by name', () => {
  const mk = (name, priority, size) => ({ card: { name, priority }, triage: { ...GOOD, size }, decision: 'attempt' });
  const q = orderQueue([
    mk('b-card', 'P1 Next', 'S'),
    mk('a-card', 'P1 Next', 'S'),
    mk('m-card', 'P0 Now', 'M'),
    mk('s-card', 'P0 Now', 'S'),
    { card: { name: 'skipped', priority: 'P0 Now' }, decision: 'skip' },
  ]);
  assert.deepEqual(q.map(e => e.card.name), ['s-card', 'm-card', 'a-card', 'b-card']);
});
