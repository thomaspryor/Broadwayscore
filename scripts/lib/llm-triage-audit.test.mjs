// BRO-7139 Step 3: weekly llm-triage audit judging rules. require() the real functions (CLAUDE.md §15).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const A = require('./llm-triage-audit.js');

const DAY = 86400000;
const TS = '2026-11-01T03:00:00Z';
const T = Date.parse(TS);
const at = (d) => new Date(T + d * DAY).toISOString();
const NOW = T + 10 * DAY;
const j = (row, out, nowMs = NOW) => A.judgeNomination({ id: 'BRO-1', ts: TS, ...row }, out, { nowMs });

test('close-candidate: a later landing or failing VERIFY is wrong; quiet 7 days is right', () => {
  assert.deepEqual(j({ verdict: 'close-candidate' }, { landings: [{ date: at(2) }] }), { judgment: 'wrong', why: 'landing-after-nomination' });
  assert.equal(j({ verdict: 'close-candidate' }, { landings: [{ date: at(2), subject: 'audit: live-data alert routing (BRO-1) [skip ci]' }] }).why, 'no-later-work');
  assert.equal(j({ verdict: 'close-candidate' }, { landings: [{ date: at(-2) }] }).judgment, 'right');
  assert.equal(j({ verdict: 'close-candidate' }, { landings: [], verify: 'fail' }).why, 'verify-fails-now');
  assert.equal(j({ verdict: 'close-candidate' }, { landings: [] }, T + 3 * DAY).judgment, 'pending');
  assert.equal(j({ verdict: 'close-candidate' }, { landings: null }).why, 'landings-unknown');
  assert.equal(j({ verdict: 'close-candidate' }, { closedAt: at(-1), landings: null }).why, 'already-closed');
});

test('any open-work verdict on a card already closed is wrong', () => {
  for (const verdict of ['release', 'keep', 'ask-owner', 'recheck', 'blocked']) {
    assert.equal(j({ verdict, blocked_on: 'BRO-2', recheck_after: '2026-11-03' }, { closedAt: at(-1) }).why, 'closed-before-nomination', verdict);
  }
  assert.equal(j({ verdict: 'release' }, {}).judgment, 'right');
});

test('blocked: needs a named blocker that was still open', () => {
  assert.equal(j({ verdict: 'blocked' }, {}).why, 'no-blocker-named');
  assert.equal(j({ verdict: 'blocked', blocked_on: 'BRO-2' }, { blockerClosedAt: at(-1) }).why, 'blocker-closed-before');
  assert.equal(j({ verdict: 'blocked', blocked_on: 'BRO-2' }, { blockerClosedAt: null }).judgment, 'right');
  assert.equal(j({ verdict: 'blocked', blocked_on: 'BRO-2' }, { blockerClosedAt: at(3) }).judgment, 'right');
  assert.equal(j({ verdict: 'blocked', blocked_on: 'BRO-2' }, {}).judgment, 'pending');
});

test('keep: a person or worker comment within 7 days is right; bot comments do not count', () => {
  const bot = { body: '**Board dispatch** nightly report', createdAt: at(2) };
  const human = { body: 'Picked this up, PR soon', createdAt: at(2) };
  assert.equal(j({ verdict: 'keep' }, { comments: [human] }).why, 'worker-active');
  assert.equal(j({ verdict: 'keep' }, { comments: [bot], landings: [] }).why, 'no-worker-activity-7d');
  assert.equal(j({ verdict: 'keep' }, { comments: [{ ...human, createdAt: at(8) }], landings: [] }).judgment, 'wrong'); // outside window
  assert.equal(j({ verdict: 'keep' }, { comments: [], landings: [{ date: at(3), subject: 'fix: thing (BRO-1)' }] }).why, 'landed-in-window');
  assert.equal(j({ verdict: 'keep' }, { comments: [], landings: [{ date: at(3), subject: 'data: Update ledger (BRO-1) [skip ci]' }] }).why, 'no-worker-activity-7d');
  assert.equal(j({ verdict: 'keep' }, { comments: [] }).why, 'landings-unknown'); // no search result is not "no work"
  assert.equal(j({ verdict: 'keep' }, { comments: [], landings: [], commentsTruncated: true }).why, 'comments-truncated');
  assert.equal(j({ verdict: 'keep' }, { comments: [] }, T + 3 * DAY).judgment, 'pending');
  assert.equal(j({ verdict: 'keep' }, { closedAt: at(4), completedAt: at(4) }).why, 'closed-in-window');
  assert.notEqual(j({ verdict: 'keep' }, { closedAt: at(4), completedAt: null, landings: [] }).judgment, 'right'); // an auto-cancel is not work
});

test('ask-owner: an earlier answer with no new question is wrong; a later answer is right', () => {
  const ans = (d) => ({ body: '**Owner decision** (answered by the owner in chat): ship it', createdAt: at(d) });
  const ask = (d) => ({ body: 'DECISION NEEDED: pick A or B', createdAt: at(d) });
  assert.equal(j({ verdict: 'ask-owner' }, { comments: [ans(-2)] }).why, 'already-answered');
  assert.equal(j({ verdict: 'ask-owner' }, { comments: [ans(-2), ask(-1)] }).why, 'unanswered');
  assert.equal(j({ verdict: 'ask-owner' }, { comments: [ans(3)] }).why, 'owner-answered');
  const note = { body: 'Owner, which layout should ship?', createdAt: at(-1) };
  assert.equal(j({ verdict: 'ask-owner' }, { comments: [ans(-2), note] }).why, 'activity-after-answer'); // a re-ask in other words is not "wrong"
  assert.equal(j({ verdict: 'ask-owner' }, { comments: [] }).judgment, 'pending');
});

test('recheck: needs a date; judged after it from VERIFY or closure', () => {
  assert.equal(j({ verdict: 'recheck' }, {}).why, 'no-recheck-date');
  assert.equal(j({ verdict: 'recheck', recheck_after: '2026-11-20' }, { verify: 'fail' }).why, 'not-due');
  assert.equal(j({ verdict: 'recheck', recheck_after: '2026-11-05' }, { verify: 'fail' }).why, 'verify-fails-after-date');
  assert.equal(j({ verdict: 'recheck', recheck_after: '2026-11-05' }, { verify: 'pass' }).judgment, 'right');
  assert.equal(j({ verdict: 'recheck', recheck_after: '2026-11-05' }, { closedAt: at(5), completedAt: at(5) }).judgment, 'right');
  assert.equal(j({ verdict: 'recheck', recheck_after: '2026-11-05' }, { closedAt: at(5), completedAt: null }).judgment, 'pending'); // a cancel is not "held"
  assert.equal(j({ verdict: 'recheck', recheck_after: '2026-11-05' }, { verify: 'not-run' }).judgment, 'pending');
});

test('sampleNominations: CI rows only, one unit per nomination, old enough, deterministic, capped', () => {
  const rows = [
    { id: 'BRO-1', ts: at(0), verdict: 'keep', source: 'ci' },
    { id: 'BRO-1', ts: at(2), verdict: 'release', source: 'ci' },
    { id: 'BRO-2', ts: at(1), verdict: 'keep', source: 'local' },
    { id: 'BRO-3', ts: at(9.5), verdict: 'keep', source: 'ci' }, // < 1 day old at NOW
    { id: 'BRO-4', ts: at(1), error: 'Anthropic 529', source: 'ci' },
    ...Array.from({ length: 50 }, (_, i) => ({ id: `BRO-${100 + i}`, ts: at(1), verdict: 'keep', source: 'ci' })),
  ];
  const s = A.sampleNominations(rows, { nowMs: NOW });
  assert.equal(s.length, A.SAMPLE);
  assert.ok(!s.some((r) => ['BRO-2', 'BRO-3', 'BRO-4'].includes(r.id)));
  assert.deepEqual(A.sampleNominations(rows, { nowMs: NOW }).map((r) => r.id), s.map((r) => r.id));
  // Cards the prompt was tuned on are never audited (in-sample); unseen ones are.
  assert.equal(A.TUNING_IDS.size, 15);
  const tuned = [...rows.slice(0, 1)].map((r) => ({ ...r, id: 'BRO-6915' }));
  assert.equal(A.sampleNominations(tuned, { nowMs: NOW }).length, 0);
  assert.equal(A.sampleNominations(tuned, { nowMs: NOW, exclude: new Set() }).length, 1);
  // Every nomination is its own sample unit; ones an earlier audit settled are skipped.
  assert.equal(A.sampleNominations(rows.slice(0, 2), { nowMs: NOW }).length, 2);
  assert.deepEqual(A.sampleNominations(rows.slice(0, 2), { nowMs: NOW, settled: new Set([`BRO-1|${at(0)}`]) }).map((r) => r.verdict), ['release']);
  assert.deepEqual([...A.settledKeys([{ source: 'ci', items: [{ id: 'BRO-1', nominatedTs: 'x', judgment: 'right' }, { id: 'BRO-2', nominatedTs: 'y', judgment: 'pending' }] }])], ['BRO-1|x']);
  assert.equal(A.sampleNominations(rows, { nowMs: NOW, includeLocal: true, n: 999 }).some((r) => r.id === 'BRO-2'), true);
});

test('auditRow is text-free and pending never counts in the wrong-rate', () => {
  const items = [
    { id: 'BRO-1', nominatedTs: TS, verdict: 'keep', judgment: 'right', why: 'worker-active', extra: 'secret text' },
    { id: 'BRO-2', nominatedTs: TS, verdict: 'keep', judgment: 'wrong', why: 'no-worker-activity-7d' },
    { id: 'BRO-3', nominatedTs: TS, verdict: 'ask-owner', judgment: 'pending', why: 'unanswered' },
  ];
  const r = A.auditRow(items, { ts: at(10), source: 'ci', runId: '9' });
  assert.equal(r.judged, 2);
  assert.equal(r.wrongRate, 0.5);
  assert.equal(r.scored, 2);
  const rel = A.auditRow([{ id: 'BRO-4', nominatedTs: TS, verdict: 'release', judgment: 'right' }, { id: 'BRO-5', nominatedTs: TS, verdict: 'release', judgment: 'wrong' }], { ts: 't', source: 'ci' });
  assert.equal(rel.scored, 1); // an uninformative release "right" does not dilute the rate
  assert.equal(rel.wrongRate, 1);
  assert.equal(r.pending, 1);
  assert.deepEqual(r.byVerdict.keep, { right: 1, wrong: 1, pending: 0 });
  assert.ok(!JSON.stringify(r).includes('secret'));
});

test('auditedRecently throttles weekly on CI rows only; cumulativeJudgments counts each nomination once, newest wins', () => {
  assert.equal(A.auditedRecently([{ ts: at(5), source: 'ci', sampled: 3 }], NOW), true);
  assert.equal(A.auditedRecently([{ ts: at(5), source: 'ci', sampled: 0 }], NOW), false); // an empty audit does not use up the week
  assert.equal(A.auditedRecently([{ ts: at(3), source: 'ci', sampled: 3 }], NOW), false);
  assert.equal(A.auditedRecently([{ ts: at(9), source: 'local', sampled: 3 }], NOW), false);
  assert.equal(A.auditedRecently([{ ts: at(9), source: 'ci', error: 'down' }], NOW), false);
  const it = (id, judgment) => ({ id, nominatedTs: TS, verdict: 'keep', judgment });
  const c = A.cumulativeJudgments([
    { ts: at(7), source: 'ci', items: [it('BRO-1', 'pending'), it('BRO-2', 'wrong')] },
    { ts: at(14), source: 'ci', items: [it('BRO-1', 'right'), it('BRO-2', 'right'), it('BRO-3', 'wrong')] },
    { ts: at(15), source: 'local', items: [it('BRO-9', 'wrong')] }, // a hand run never feeds acceptance
  ]);
  assert.deepEqual(c, { right: 2, wrong: 1, judged: 3, scored: 3, wrongRate: 1 / 3 });
});

test('CLI: reads Linear only, appends one text-free row, throttles weekly in CI, kill switch', async () => {
  const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
  const CLI = require('../llm-triage-audit.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lta-'));
  const ledger = path.join(dir, 't.jsonl'); const out = path.join(dir, 'a.jsonl');
  fs.writeFileSync(ledger, [
    { id: 'BRO-1', ts: TS, source: 'ci', verdict: 'close-candidate' },
    { id: 'BRO-2', ts: TS, source: 'ci', verdict: 'blocked', blocked_on: 'BRO-3' },
  ].map((r) => JSON.stringify(r)).join('\n'));
  const cards = { 'BRO-1': { identifier: 'BRO-1', description: 'secret owner text', completedAt: null, comments: { nodes: [] } },
    'BRO-2': { identifier: 'BRO-2', description: '', comments: { nodes: [] } }, 'BRO-3': { identifier: 'BRO-3', completedAt: at(-1), state: { type: 'completed' } } };
  const queries = [];
  const graphql = async (q) => { queries.push(q); const d = {}; let i = 0; for (const m of q.matchAll(/issue\(id: "(BRO-\d+)"\)/g)) d[`i${i++}`] = cards[m[1]]; return d; };
  const env = { GITHUB_ACTIONS: 'true', GITHUB_RUN_ID: '5' };
  const args = ['--write', `--ledger=${ledger}`, `--out=${out}`];
  assert.equal(await CLI.main(args, { graphql, env, now: new Date(NOW), log: () => {}, commitSearch: () => [], pause: () => {} }), 0);
  const rows = fs.readFileSync(out, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].items.map((i) => [i.id, i.judgment, i.why]).sort(), [['BRO-1', 'right', 'no-later-work'], ['BRO-2', 'wrong', 'blocker-closed-before']]);
  assert.ok(!JSON.stringify(rows[0]).includes('secret'));
  assert.ok(queries.every((q) => !/\bmutation\b/.test(q)));
  // A second nightly run inside the week writes nothing; --force runs, but both are settled now.
  assert.equal(await CLI.main(args, { graphql, env, now: new Date(NOW + DAY), log: () => {}, commitSearch: () => [], pause: () => {} }), 0);
  assert.equal(fs.readFileSync(out, 'utf8').trim().split('\n').length, 1);
  assert.equal(await CLI.main([...args, '--force'], { graphql, env, now: new Date(NOW + DAY), log: () => {}, commitSearch: () => [], pause: () => {} }), 0);
  assert.equal(fs.readFileSync(out, 'utf8').trim().split('\n').length, 1);
  // Deadline: cards past it read pending and the row is still written.
  const out2 = path.join(dir, 'b.jsonl'); let t = 0; let pauses = 0;
  assert.equal(await CLI.main(['--write', `--ledger=${ledger}`, `--out=${out2}`, '--deadline-sec=1'], { graphql, env, now: new Date(NOW), log: () => {},
    commitSearch: () => { t += 2000; return []; }, clock: () => t, pause: () => { pauses++; } }), 0);
  const r2 = JSON.parse(fs.readFileSync(out2, 'utf8').trim());
  assert.equal(r2.sampled, 2);
  assert.ok(r2.items.some((i) => i.why === 'deadline'), JSON.stringify(r2.items));
  assert.equal(await CLI.main(args, { env: { LLM_TRIAGE_AUDIT_DISABLED: 'true' }, log: () => {} }), 0);
  assert.equal(await CLI.main(['--bogus'], { env: {}, log: () => {} }), 2);
});

test('review fixes: partial commit search is unknown, close-out commit is pending, stuck pending items rotate back', () => {
  const T = require('../llm-triage.js');
  const page = (total, n, extra = {}) => JSON.stringify({ total_count: total, items: Array.from({ length: n }, (_, k) => ({ sha: `s${k}`, commit: { message: 'x', committer: { date: at(k) } } })), ...extra });
  assert.equal(T.parseCommitSearch(page(150, 100), { requireComplete: true }), null);
  assert.equal(T.parseCommitSearch(page(2, 2, { incomplete_results: true }), { requireComplete: true }), null);
  assert.equal(T.parseCommitSearch(page(2, 2), { requireComplete: true }).length, 2);
  assert.equal(T.parseCommitSearch(page(150, 100)).length, 100); // the triage step keeps partial pages
  const j = (row, out) => A.judgeNomination({ id: 'BRO-1', ts: TS, ...row }, out, { nowMs: NOW });
  assert.equal(j({ verdict: 'close-candidate' }, { landings: [{ date: at(2), subject: 'BRO-1 close-out' }], completedAt: at(2.5), closedAt: at(2.5) }).why, 'landed-then-closed');
  assert.equal(j({ verdict: 'close-candidate' }, { landings: [{ date: at(3), subject: 'fix (BRO-1)' }], completedAt: at(2), closedAt: at(2) }).why, 'landing-after-nomination');
  const rows = ['BRO-11', 'BRO-12', 'BRO-13'].map((id) => ({ id, ts: TS, verdict: 'keep', source: 'ci' }));
  const first = A.sampleNominations(rows, { nowMs: NOW, n: 1 })[0].id;
  const tries = A.pendingTries([{ items: [{ id: first, nominatedTs: TS, judgment: 'pending' }] }]);
  assert.notEqual(A.sampleNominations(rows, { nowMs: NOW, n: 1, tries })[0].id, first);
});

test('closedAtOf: a reopened card with a stale cancel stamp is open', () => {
  const CLI = require('../llm-triage-audit.js');
  assert.equal(CLI.closedAtOf({ canceledAt: at(1), state: { type: 'started' } }), null);
  assert.equal(CLI.closedAtOf({ canceledAt: at(1), state: { type: 'canceled' } }), at(1));
  assert.equal(CLI.closedAtOf({ completedAt: at(2), state: { type: 'completed' } }), at(2));
});
