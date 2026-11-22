import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const rct = require('./red-cause-tag.js');
const { checkLinearDoneTransition, redCauseCloseCheck } = require('./linear-done-gate.js');
const { printCauseMix } = require('../ci-green-rate.js');

test('red cards: by router title, escalation key, or escaped conditionKey marker; others are not', () => {
  assert.ok(rct.isRedCard({ title: 'main test.yml red: Unit Tests / Run unit tests' }));
  assert.ok(rct.isRedCard({ title: 'Something', description: 'x\n\\[conditionKey:test-yml:main-streak-escalation\\]' }));
  assert.ok(rct.isRedCard({ title: 'T', description: '[conditionKey:test-yml:red:E2E Tests:abcd1234]' }));
  assert.ok(!rct.isRedCard({ title: 'Live-data test failing: x', description: '[conditionKey:live-data-test:x]' }));
  assert.ok(!rct.isRedCard({ title: 'Fix main test.yml red handling in the router' }));
});

test('parseCauseTag: last line wins, case-insensitive, bullet/quote tolerant, unknown tags flagged', () => {
  assert.deepEqual(rct.parseCauseTag(['CAUSE: flake', 'later\n- CAUSE: Stale-Test']), { tag: 'stale-test', valid: true });
  assert.deepEqual(rct.parseCauseTag(['> CAUSE: weather']), { tag: 'weather', valid: false });
  assert.equal(rct.parseCauseTag(['ROOT-CAUSE: the fixture aged out']), null); // the BRO-7103 field is not a cause tag
  assert.equal(rct.parseCauseTag([]), null);
});

const BEFORE = Date.parse('2026-11-23T12:00:00Z');
const AFTER = Date.parse(`${rct.RED_CAUSE_BLOCKING_FROM}T00:00:00Z`);
const NO_ENV = {};

test('done gate: before the arm date an untagged red close warns; a tagged one is quiet', () => {
  const base = { identifier: 'BRO-1', title: 'main test.yml red: Unit Tests', targetStateType: 'completed', description: '', existingComments: [], nowMs: BEFORE, env: NO_ENV };
  const w = redCauseCloseCheck({ ...base, commentText: 'fixed it' });
  assert.match(w.message, /CAUSE: data-drift \| stale-test/);
  assert.equal(w.blocking, false);
  assert.match(w.message, /advisory now, refused from 2026-11-24/);
  assert.equal(redCauseCloseCheck({ ...base, commentText: 'fixed\nCAUSE: landing-collision' }), null);
  // An older tag in an earlier comment is overridden by a newer bad one: flagged.
  assert.match(redCauseCloseCheck({ ...base, existingComments: ['CAUSE: flake'], commentText: 'CAUSE: nope' }).message, /is not one of the tags/);
  assert.equal(redCauseCloseCheck({ ...base, title: 'Unrelated fix', commentText: '' }), null);
  const r = checkLinearDoneTransition({ ...base, commentText: 'PR-EVIDENCE: merged deployed checked (https://example.com/x)' });
  assert.notEqual(r.verdict, 'red-cause-missing');
  assert.ok(String(r.warning || '').includes('CAUSE:'));
});

test('done gate: from the arm date an untagged red close is REFUSED; a tag, advisory env or an automated closer lets it through', () => {
  const base = { identifier: 'BRO-1', title: 'main test.yml red: Unit Tests', targetStateType: 'completed', description: '', existingComments: [], nowMs: AFTER, env: NO_ENV, verifyEvidence: () => ({ verified: true }) };
  const ev = 'PR-EVIDENCE: merged deployed checked (https://example.com/x)';
  const refused = checkLinearDoneTransition({ ...base, commentText: ev });
  assert.equal(refused.allowed, false);
  assert.equal(refused.verdict, 'red-cause-missing');
  assert.match(refused.reason, /the close is refused without it/);
  assert.notEqual(checkLinearDoneTransition({ ...base, commentText: `${ev}\nCAUSE: stale-test` }).verdict, 'red-cause-missing');
  // A tag on an earlier comment (e.g. the worker's session report) counts.
  assert.notEqual(checkLinearDoneTransition({ ...base, existingComments: ['CAUSE: flake'], commentText: ev }).verdict, 'red-cause-missing');
  assert.notEqual(checkLinearDoneTransition({ ...base, env: { RED_CAUSE_CLOSE_GATE: 'advisory' }, commentText: ev }).verdict, 'red-cause-missing');
  // Early arm for proof runs.
  assert.equal(checkLinearDoneTransition({ ...base, nowMs: BEFORE, env: { RED_CAUSE_CLOSE_GATE: 'blocking' }, commentText: ev }).verdict, 'red-cause-missing');
  // Every automated closer's real close comment only warns.
  const { buildAutoCloseComment } = require('./autonomous-recheck-core.js');
  const { landedComment } = require('./board-closer.js');
  const closer = require('./stuck-card-closer.js');
  const { buildZombieActionComment } = require('./linear-started-zombie-sweep-verify.js');
  const cand = { identifier: 'BRO-1', verifyCmd: 'node --test x.test.mjs', cmd: 'node --test x.test.mjs', title: 't' };
  const autoComments = [
    buildAutoCloseComment({ cmd: 'node --test x.test.mjs', sha: 'abc' }),
    landedComment('land/x', 'abc'),
    `${closer.buildClosureComment({ candidate: cand, sha: 'abc', auditGeneratedAt: '2026-11-18' })}\n${ev}`,
    `${closer.buildSweepClosureComment()}\n${ev}`,
    `${closer.buildBacklogClosureComment({ candidate: cand, sha: 'abc', sweepGeneratedAt: 'x', checkoutSha: 'y' })}\n${ev}`,
    `${buildZombieActionComment({ action: 'done', identifier: 'BRO-1', jobId: 'j', cmd: 'node --test x.test.mjs', sha: 'abc' })}\n${ev}`,
    // codex/daily-runner.js's two Done closes (literal prefixes there).
    `## Codex runner: landed\n\n${ev}`,
    `## Codex runner: already fixed on main, no code change\n\n${ev}`,
  ];
  for (const c of autoComments) {
    const r = checkLinearDoneTransition({ ...base, commentText: c });
    assert.notEqual(r.verdict, 'red-cause-missing', c.slice(0, 60));
  }
  // The exemption reads THIS close only: an old closer comment does not exempt a later hand close.
  const later = checkLinearDoneTransition({ ...base, existingComments: autoComments, commentText: ev });
  assert.equal(later.verdict, 'red-cause-missing');
  // A marker pasted mid-comment does not exempt; the Codex "refused" bounce is not a close.
  assert.equal(checkLinearDoneTransition({ ...base, commentText: `${ev}\nAUTO-CLOSED by stuck-card-closer` }).verdict, 'red-cause-missing');
  assert.equal(rct.isAutomatedClose('## Codex runner: landed, but the Done gate refused\n\nx'), false);
});

test('drift guard: every automated Done-closer that can reach a red card opens with a known marker', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../codex/daily-runner.js', import.meta.url), 'utf8');
  const doneCloses = [...src.matchAll(/moveCard\(id, 'Done', `([^`$]*)/g)].map((m) => m[1].replace(/\\n/g, '\n'));
  assert.ok(doneCloses.length >= 2, 'daily-runner.js Done closes not found: update this guard');
  for (const prefix of doneCloses) assert.ok(rct.isAutomatedClose(`${prefix}x`), `Codex Done close not exempt: ${prefix}`);
});

test('a freshly filed red card does not satisfy its own close check (the closing hint is not a tag)', () => {
  const { RED_SIGNATURE_PREFIX } = require('./main-red-streak.js');
  const { buildCardNotes } = require('./owner-alert-router.js');
  for (const key of [`${RED_SIGNATURE_PREFIX}Unit Tests:abcd1234`, 'test-yml:main-streak-escalation']) {
    const notes = buildCardNotes({ description: 'x', hint: '', fields: [], conditionKey: key });
    assert.match(notes, /CAUSE: <tag>/, key);
    const r = rct.checkRedCauseClose({ title: 'anything', description: notes, texts: [notes, 'fixed'], nowMs: AFTER, env: NO_ENV });
    assert.equal(r.ok, false, key);
  }
  // Other families get no closing hint.
  assert.doesNotMatch(buildCardNotes({ description: 'x', hint: '', fields: [], conditionKey: 'live-data-test:x' }), /CAUSE: <tag>/);
});

test('cause mix: only Done red cards count; untagged and bad tags apart', () => {
  const done = { type: 'completed' };
  const r = rct.causeMix([
    { title: 'main test.yml red: A', state: done, texts: ['CAUSE: data-drift'] },
    { title: 'main test.yml red: B', state: done, texts: ['CAUSE: flake', 'CAUSE: infra'] },
    { title: 'main test.yml red: C', state: done, texts: [] },
    { title: 'main test.yml red: D', state: done, texts: ['CAUSE: gremlins'] },
    { title: 'main test.yml red: E', state: { type: 'canceled' }, texts: ['CAUSE: flake'] },
    { title: 'Other', state: done, texts: ['CAUSE: flake'] },
  ]);
  assert.equal(r.total, 4);
  assert.equal(r.mix['data-drift'], 1);
  assert.equal(r.mix.infra, 1);
  assert.equal(r.mix.flake, 0);
  assert.equal(r.untagged, 1);
  assert.equal(r.invalid, 1);
  assert.equal(r.canceled, 1); // Cancel is the way around the Done gate: counted, not hidden
  assert.match(rct.formatCauseMix(r, 30), /^CAUSE-MIX: 4 closed main-red cards over 30d: data-drift 1, .*untagged 1, bad tag 1 \(\+1 canceled, not counted\)$/);
});

test('causeMixFromLinear: reads only Done cards in the window, comments oldest first', async () => {
  const now = new Date().toISOString();
  const lc = {
    listIssuesByProvenance: async () => [
      { identifier: 'BRO-1', title: 'main test.yml red: A', description: '', state: { type: 'completed' }, completedAt: now },
      { identifier: 'BRO-2', title: 'main test.yml red: B', description: '', state: { type: 'started' } },
    ],
    listIssueComments: async (ids, teamKey, opts) => {
      assert.deepEqual(ids, ['BRO-1']);
      // Done cards auto-archive ~2d after close: without this every close read as untagged.
      assert.equal(opts && opts.includeArchived, true);
      return new Map([['BRO-1', [{ body: 'CAUSE: stale-test', createdAt: '2026-11-02' }, { body: 'CAUSE: flake', createdAt: '2026-11-01' }]]]);
    },
  };
  const r = await rct.causeMixFromLinear(30, lc);
  assert.equal(r.total, 1);
  assert.equal(r.mix['stale-test'], 1);
});

test('ci-green-rate --cause-mix prints a line, and an n/a line when Linear fails', async () => {
  const out = [];
  await printCauseMix(['--days', '14'], { log: (l) => out.push(l), error: () => {}, fromLinear: async () => rct.causeMix([]) });
  await printCauseMix([], { log: (l) => out.push(l), error: () => {}, fromLinear: async () => { throw new Error('down'); } });
  assert.match(out[0], /^CAUSE-MIX: 0 closed main-red cards over 14d/);
  assert.match(out[1], /^CAUSE-MIX: n\/a over 7d/);
});

test('a CAUSE: tag mid-sentence counts; a lower-case word or a word ending in cause does not', () => {
  const { parseCauseTag } = require('./red-cause-tag.js');
  assert.deepEqual(parseCauseTag(['Fixed the date. CAUSE: stale-test']), { tag: 'stale-test', valid: true });
  assert.deepEqual(parseCauseTag(['root cause: flake']), null);
  assert.deepEqual(parseCauseTag(['BECAUSE: infra']), null);
});

test('drift guard: the cards the filer actually opens are recognized as red cards', async () => {
  const fs = await import('node:fs');
  const { RED_SIGNATURE_PREFIX } = require('./main-red-streak.js');
  const { buildCardNotes } = require('./owner-alert-router.js');
  // The router's real notes for a red signature key carry the conditionKey marker isRedCard reads.
  const notes = buildCardNotes({ description: 'x', hint: '', fields: [], conditionKey: `${RED_SIGNATURE_PREFIX}Unit Tests:abcd1234` });
  assert.ok(rct.isRedCard({ title: 'anything', description: notes }));
  // The title template route-main-streak-signatures.js files.
  const src = fs.readFileSync(new URL('../route-main-streak-signatures.js', import.meta.url), 'utf8');
  const m = src.match(/title: `(main test\.yml red: )\$\{label\}`/);
  assert.ok(m, 'route-main-streak-signatures.js title template changed: update red-cause-tag.js RED_TITLE_RE');
  assert.ok(rct.isRedCard({ title: `${m[1]}Unit Tests / Run unit tests` }));
});

test('CAUSE parser: markdown forms count; ROOT CAUSE, the pasted hint line and escaping do not fool it', () => {
  const p = (t) => rct.parseCauseTag([t]);
  for (const t of ['**CAUSE:** flake', '`CAUSE: flake`', 'CAUSE: **flake**', 'CAUSE: flake']) assert.deepEqual(p(t), { tag: 'flake', valid: true }, t);
  assert.deepEqual(p('CAUSE: data\\-drift'), { tag: 'data-drift', valid: true });
  assert.equal(p('ROOT CAUSE: flaky runner'), null);
  assert.deepEqual(p('CAUSE: infra\nROOT CAUSE: flaky runner'), { tag: 'infra', valid: true });
  assert.equal(p('CAUSE: data-drift | stale-test | landing-collision | flake | infra'), null);
  assert.deepEqual(p('CAUSE: data drift'), { tag: 'data', valid: false }); // two words: flagged, not guessed
});
