import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const rct = require('./red-cause-tag.js');
const { checkLinearDoneTransition, redCauseCloseWarning } = require('./linear-done-gate.js');
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

test('done gate: a red card closing without a tag warns but is never refused; a tagged one is quiet', () => {
  const base = { identifier: 'BRO-1', title: 'main test.yml red: Unit Tests', targetStateType: 'completed', description: '', existingComments: [] };
  const w = redCauseCloseWarning({ ...base, commentText: 'fixed it' });
  assert.match(w, /CAUSE: data-drift \| stale-test/);
  assert.equal(redCauseCloseWarning({ ...base, commentText: 'fixed\nCAUSE: landing-collision' }), null);
  // An older tag in an earlier comment is overridden by a newer bad one: warns.
  assert.match(redCauseCloseWarning({ ...base, existingComments: ['CAUSE: flake'], commentText: 'CAUSE: nope' }), /is not one of the tags/);
  assert.equal(redCauseCloseWarning({ ...base, title: 'Unrelated fix', commentText: '' }), null);
  const r = checkLinearDoneTransition({ ...base, commentText: 'PR-EVIDENCE: merged deployed checked (https://example.com/x)' });
  assert.notEqual(r.verdict, 'red-cause-missing');
  assert.ok(String(r.warning || '').includes('CAUSE:'));
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
  assert.match(rct.formatCauseMix(r, 30), /^CAUSE-MIX: 4 closed main-red cards over 30d: data-drift 1, .*untagged 1, bad tag 1$/);
});

test('causeMixFromLinear: reads only Done cards in the window, comments oldest first', async () => {
  const now = new Date().toISOString();
  const lc = {
    listIssuesByProvenance: async () => [
      { identifier: 'BRO-1', title: 'main test.yml red: A', description: '', state: { type: 'completed' }, completedAt: now },
      { identifier: 'BRO-2', title: 'main test.yml red: B', description: '', state: { type: 'started' } },
    ],
    listIssueComments: async (ids) => {
      assert.deepEqual(ids, ['BRO-1']);
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
