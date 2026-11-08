// BRO-7139 Step 3: machine-gathered FACTS for the llm-triage prompt (v2), and the report-only CLI.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const F = require('./llm-triage-facts.js');
const CLI = require('../llm-triage.js');

const NOW = Date.parse('2026-11-08T12:00:00Z');
const card = (o = {}) => ({
  identifier: 'BRO-100', title: 'Fix stuck opening night review pipeline', description: '', createdAt: '2026-11-01T00:00:00Z',
  state: { name: 'Todo', type: 'unstarted' }, priority: 2, comments: { nodes: [] }, ...o,
});

test('referencedIds excludes self and dedupes in order', () => {
  assert.deepEqual(F.referencedIds('see BRO-5 and BRO-100 then BRO-5, BRO-7', 'BRO-100'), ['BRO-5', 'BRO-7']);
});

test('verifyCommandOf: newest comment wins over description; none when absent', () => {
  const none = F.verifyCommandOf(card({ description: 'nothing here' }));
  assert.equal(none.status, 'none');
  const desc = 'VERIFY: `npx tsc --noEmit`';
  const older = 'VERIFY: `node scripts/validate-data.js`';
  const newer = 'VERIFY: `npm run lint`';
  const onlyDesc = F.verifyCommandOf(card({ description: desc }));
  assert.equal(onlyDesc.status, 'found');
  assert.equal(onlyDesc.cmd, 'npx tsc --noEmit');
  const r = F.verifyCommandOf(card({ description: desc, comments: { nodes: [{ body: older, createdAt: '2026-11-02' }, { body: newer, createdAt: '2026-11-03' }] } }));
  assert.equal(r.status, 'found');
  assert.equal(r.cmd, 'npm run lint');
  // An unsafe newest comment does not hide an older safe command.
  const u = F.verifyCommandOf(card({ description: desc, comments: { nodes: [{ body: 'VERIFY: `rm -rf data`', createdAt: '2026-11-03' }] } }));
  assert.equal(u.cmd, 'npx tsc --noEmit');
});

test('verifyResultWord maps execution evidence', () => {
  assert.equal(F.verifyResultWord(null), 'not-run');
  // Real runner verdict strings (close-time-verify VERDICTS), not invented ones:
  // a made-up 'fail' here hid every real failure as 'not-run' (BRO-7139).
  const { VERDICTS } = require('./close-time-verify.js');
  assert.equal(F.verifyResultWord({ allowed: true, verdict: VERDICTS.PASS }), 'pass');
  assert.equal(F.verifyResultWord({ allowed: false, verdict: VERDICTS.FAIL }), 'fail');
  assert.equal(F.verifyResultWord({ allowed: false, verdict: VERDICTS.UNVERIFIABLE }), 'not-run');
  assert.equal(F.verifyResultWord({ allowed: false, verdict: 'execution-error' }), 'not-run');
  assert.equal(F.verifyResultWord({ allowed: false, verdict: 'verify-cmd-infra-timeout' }), 'not-run');
});

test('verifyDetail separates a NOT ON MAIN failure from a real one', () => {
  const { VERDICTS } = require('./close-time-verify.js');
  assert.match(F.verifyDetail({ allowed: false, verdict: VERDICTS.FAIL, notOnMain: true }), /NOT ON MAIN/);
  assert.equal(F.verifyDetail({ allowed: false, verdict: VERDICTS.FAIL, notOnMain: false }), 'the command ran on main and failed');
  assert.equal(F.verifyDetail({ allowed: true, verdict: VERDICTS.PASS }), 'the command ran on main and passed');
  assert.match(F.verifyDetail({ allowed: false, verdict: VERDICTS.UNVERIFIABLE }), /could not be run/);
  assert.equal(F.verifyDetail(null), 'not run');
});

test('titleSimilarity: short titles never overlap; near-identical titles do', () => {
  assert.equal(F.titleSimilarity('Fix it', 'Fix it'), 0);
  assert.ok(F.titleSimilarity('Opening night review pipeline stuck again', 'Opening night review pipeline stuck') >= F.OVERLAP_MIN);
  assert.ok(F.titleSimilarity('Grosses scraper broken', 'Newsletter preview email late') < 0.2);
});

test('findOverlaps skips self and closed cards, caps at 5', () => {
  const me = card();
  const open = [me, card({ identifier: 'BRO-101' }), card({ identifier: 'BRO-102', state: { type: 'completed', name: 'Done' } }),
    ...Array.from({ length: 8 }, (_, i) => card({ identifier: `BRO-2${i}` }))];
  const o = F.findOverlaps(me, open);
  assert.equal(o.length, 5);
  assert.ok(!o.some((x) => x.id === 'BRO-100' || x.id === 'BRO-102'));
});

test('conditionFacts: no key -> null; CLOSE-WHEN -> unknown', () => {
  assert.deepEqual(F.conditionFacts(card(), null), { key: null, state: null });
  const c = F.conditionFacts(card({ description: 'CLOSE-WHEN: grosses fresh' }), null);
  assert.equal(c.state, 'unknown');
  assert.match(c.key, /CLOSE-WHEN/);
});

test('landingsAfter keeps commits on/after filing, newest first, max 5', () => {
  const commits = [
    { sha: 'a', date: '2026-10-01T00:00:00Z', subject: 'before' },
    ...Array.from({ length: 7 }, (_, i) => ({ sha: `s${i}`, date: `2026-11-0${i + 2}T00:00:00Z`, subject: `c${i}` })),
  ];
  const l = F.landingsAfter(commits, '2026-11-01T00:00:00Z');
  assert.equal(l.length, 5);
  assert.equal(l[0].sha, 's6');
  assert.ok(!l.some((c) => c.sha === 'a'));
});

test('lastWorkerComment skips machine stamps', () => {
  const c = card({ comments: { nodes: [
    { body: 'Human progress note here', createdAt: '2026-11-07T12:00:00Z' },
    { body: '**Board dispatch** report', createdAt: '2026-11-08T00:00:00Z' },
  ] } });
  assert.match(F.lastWorkerComment(c, NOW), /^24h ago: "Human progress/);
  assert.equal(F.lastWorkerComment(card(), NOW), 'none');
});

test('buildFacts + renderPrompt fill every placeholder from the real template', () => {
  const issue = card({ description: 'Blocked on BRO-5' });
  const facts = F.buildFacts({ issue, category: 'stuck-in-progress', verify: { cmd: null, status: 'none' }, verifyResult: null,
    commits: [], refStates: new Map([['BRO-5', { state: 'Done', title: 'Upstream fix' }]]), overlaps: [], condition: { key: null, state: null }, nowMs: NOW });
  assert.equal(facts.TODAY, '2026-11-08');
  assert.match(facts.REFERENCED_CARDS, /BRO-5 \(Done: Upstream fix\)/);
  const p = F.renderPrompt(facts, issue);
  assert.doesNotMatch(p, /\{\{[A-Z_]+\}\}/);
  assert.match(p, /BRO-100: Fix stuck/);
  assert.throws(() => F.renderPrompt({}, issue, 'hdr\n---\n{{TODAY}}'), /placeholder not filled/);
});

test('parseVerdict guards: enum, id, close evidence, invented ids, ask-owner question', () => {
  const facts = { REFERENCED_CARDS: 'BRO-5 (Done: x)' };
  const j = (o) => `prose ${JSON.stringify({ id: 'BRO-100', ...o })} trailing`;
  assert.equal(F.parseVerdict('no json').ok, false);
  assert.match(F.parseVerdict(j({ verdict: 'nuke' })).error, /unknown verdict/);
  assert.match(F.parseVerdict(JSON.stringify({ id: 'BRO-9', verdict: 'keep' }), { id: 'BRO-100' }).error, /expected BRO-100/);
  assert.match(F.parseVerdict(j({ verdict: 'close-candidate' }), { id: 'BRO-100', facts }).error, /without close_evidence/);
  assert.match(F.parseVerdict(j({ verdict: 'close-candidate', close_evidence: 'BRO-6751 done' }), { id: 'BRO-100', facts }).error, /BRO-6751/);
  assert.equal(F.parseVerdict(j({ verdict: 'close-candidate', close_evidence: 'BRO-5 is Done' }), { id: 'BRO-100', facts }).ok, true);
  assert.equal(F.parseVerdict(j({ verdict: 'ask-owner', question: 'Pick one?' }), { id: 'BRO-100' }).ok, false);
  assert.equal(F.parseVerdict(j({ verdict: 'ask-owner', question: 'DECISION NEEDED: pick' }), { id: 'BRO-100' }).ok, true);
});

test('CLI parseArgs rejects bad ids and unknown flags', () => {
  assert.deepEqual(CLI.parseArgs(['--ids=BRO-1,BRO-2', '--ask']).ids, ['BRO-1', 'BRO-2']);
  assert.throws(() => CLI.parseArgs(['--ids=foo']), /not a card id/);
  assert.throws(() => CLI.parseArgs(['--write']), /unknown argument/);
});

test('CLI main is report-only: renders prompts, parses replies, never mutates', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-triage-'));
  const queries = [];
  const target = card({ identifier: 'BRO-100', description: 'needs BRO-5' });
  const graphql = async (q) => {
    queries.push(q);
    assert.doesNotMatch(q, /mutation/);
    if (/issues\s*\(/.test(q)) return { issues: { nodes: [target], pageInfo: { hasNextPage: false } } };
    if (/BRO-100/.test(q)) return { i0: target };
    if (/BRO-5/.test(q)) return { i0: { identifier: 'BRO-5', title: 'Upstream', state: { name: 'Done', type: 'completed' } } };
    return {};
  };
  const out = path.join(dir, 'v.json');
  const code = await CLI.main(['--ids=BRO-100', `--prompts-dir=${dir}`, '--ask', `--out=${out}`], {
    graphql, now: new Date(NOW), log: () => {}, env: { ANTHROPIC_API_KEY: 'x' },
    commitSearch: () => [{ sha: 'abc123', date: '2026-11-05T00:00:00Z', subject: 'fix(BRO-100): thing' }],
    ask: async () => JSON.stringify({ id: 'BRO-100', verdict: 'release', reason: 'dependency done' }),
  });
  assert.equal(code, 0);
  assert.ok(fs.existsSync(path.join(dir, 'BRO-100.md')));
  const rep = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.equal(rep.reportOnly, true);
  assert.equal(rep.results[0].verdict.verdict, 'release');
  assert.match(rep.results[0].facts.LANDINGS, /abc123/);
  assert.equal(await CLI.main(['--ids=BRO-1', '--ask'], { env: {}, log: () => {} }), 2);
});

// Linear returns comments NEWEST first (linear-client.js). Readers must sort, not trust input order.
test('comment readers sort by createdAt: a newest-first fixture still picks the newest VERIFY and comment', () => {
  const nodes = [
    { body: 'VERIFY: `npm run lint`\nnewest worker note', createdAt: '2026-11-07T00:00:00Z' },
    { body: 'VERIFY: `node scripts/validate-data.js`\noldest note', createdAt: '2026-11-02T00:00:00Z' },
  ];
  const c = card({ comments: { nodes } });
  assert.equal(F.verifyCommandOf(c).cmd, 'npm run lint');
  assert.match(F.lastWorkerComment(c, NOW), /newest worker note/);
  assert.ok(F.renderCard(c).indexOf('oldest note') < F.renderCard(c).indexOf('newest worker note'));
});

test('parseVerdict: invented duplicate_of / blocked_on ids are refused; trailing prose with } still parses', () => {
  const facts = { OVERLAPS: 'BRO-7 (similar title)' };
  assert.equal(F.parseVerdict(JSON.stringify({ id: 'BRO-100', verdict: 'blocked', blocked_on: 'BRO-999' }), { id: 'BRO-100', facts }).ok, false);
  assert.equal(F.parseVerdict(JSON.stringify({ id: 'BRO-100', verdict: 'close-candidate', close_evidence: 'same work', duplicate_of: 'BRO-999' }), { id: 'BRO-100', facts }).ok, false);
  assert.equal(F.parseVerdict(JSON.stringify({ id: 'BRO-100', verdict: 'blocked', blocked_on: 'BRO-7' }), { id: 'BRO-100', facts }).ok, true);
  const r = F.parseVerdict('{"id":"BRO-100","verdict":"keep"}\nNote: see {the card} for more.', { id: 'BRO-100' });
  assert.equal(r.ok, true);
});

test('parseCommitSearch: an error body (403/422) is unknown, never "no landings"', () => {
  assert.equal(CLI.parseCommitSearch('{"message":"API rate limit exceeded"}'), null);
  assert.equal(CLI.parseCommitSearch('not json'), null);
  assert.deepEqual(CLI.parseCommitSearch('{"items":[]}'), []);
  const one = CLI.parseCommitSearch(JSON.stringify({ items: [{ sha: 'abc', commit: { message: 'fix(BRO-1): x\n\nbody', committer: { date: '2026-11-05' } } }] }));
  assert.deepEqual(one, [{ sha: 'abc', date: '2026-11-05', subject: 'fix(BRO-1): x' }]);
});

test('CLI main: one card that throws is recorded and the report is still written; outages are not "not found"', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-triage-'));
  const a = card({ identifier: 'BRO-100' });
  const b = card({ identifier: 'BRO-101', title: 'Second card about grosses' });
  const graphql = async (q) => {
    if (/issues\s*\(/.test(q)) return { issues: { nodes: [a, b], pageInfo: { hasNextPage: false } } };
    return { i0: /BRO-100/.test(q) ? a : b, i1: b };
  };
  const out = path.join(dir, 'v.json');
  const code = await CLI.main(['--ids=BRO-100,BRO-101', `--out=${out}`], {
    graphql, now: new Date(NOW), log: () => {}, env: {},
    commitSearch: (id) => { if (id === 'BRO-100') throw new Error('boom'); return null; },
  });
  assert.equal(code, 1);
  const rep = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.match(rep.results[0].error, /triage failed: boom/);
  assert.equal(rep.results[1].facts.LANDINGS, 'unknown (commit search failed)');
  // A 401 in the one-at-a-time fallback must surface, not become "card not found".
  const down = async () => { throw new Error('Linear GraphQL error: Authentication required'); };
  await assert.rejects(CLI.fetchIssues(down, ['BRO-1']), /Authentication/);
  const missing = async () => { throw new Error('Linear GraphQL error: Entity not found: Issue'); };
  assert.equal((await CLI.fetchIssues(missing, ['BRO-1'])).size, 0);
});
