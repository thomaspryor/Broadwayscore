// BRO-6263: the Codex trust ladder decisions (scripts/lib/codex-trust-ladder.js).
// Requires the real functions (CLAUDE.md §15), never a copy.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const L = require('../../scripts/lib/codex-trust-ladder.js');
const { runnerSummaryFacts } = require('../../scripts/lib/codex-runner.js');

const NOW = Date.parse('2026-11-10T12:00:00Z');
const DAY = 86400_000;
const iso = (ms) => new Date(ms).toISOString();
const fresh = (over = {}) => ({ ...L.seedState(iso(NOW - 10 * DAY)), ...over });
const goodStats = { landed: 24, rejected: 8, attempts: 32, rate: 0.25 };
const rec = (over = {}) => ({ stats: goodStats, regressions: [], breaches: [], ...over });
const run = (state, record, owner = L.seedOwner()) => L.evaluate({ state, owner, record, nowMs: NOW });

test('policy: N=7 days, under 40% rejected, 30+ attempts', () => {
  assert.deepEqual({ ...L.POLICY }, { windowDays: 7, maxRejectRate: 0.4, minAttempts: 30 });
});

test('access: shadow, missing and killed all return the pre-ladder baseline', () => {
  const base = { source: 'baseline', minScore: -6, cloudDataRouteLocked: false, reviewTextsLocked: false };
  assert.deepEqual(L.access({ state: fresh(), owner: L.seedOwner(), env: {} }), base);
  assert.deepEqual(L.access({ state: null, owner: null, env: {} }), base);
  const live = fresh({ mode: 'live' });
  assert.equal(L.access({ state: live, owner: { killSwitch: true }, env: {} }).source, 'killed');
  assert.equal(L.access({ state: live, owner: L.seedOwner(), env: { CODEX_TRUST_LADDER_DISABLED: '1' } }).source, 'killed');
});

test('access: live ladder follows the rungs; a corrupt file fails closed', () => {
  const live = fresh({ mode: 'live' });
  assert.deepEqual(L.access({ state: live, owner: L.seedOwner(), env: {} }), { source: 'ladder', minScore: -6, cloudDataRouteLocked: false, reviewTextsLocked: false });
  live.rungs['larger-cards'] = { unlocked: true };
  live.rungs['cloud-data-route'] = { unlocked: false };
  const a = L.access({ state: live, owner: L.seedOwner(), env: {} });
  assert.equal(a.minScore, -9);
  assert.equal(a.cloudDataRouteLocked, true);
  const c = L.access({ state: null, owner: null, corrupt: true, env: {} });
  assert.deepEqual([c.source, c.minScore, c.cloudDataRouteLocked, c.reviewTextsLocked], ['corrupt-locked', -6, true, true]);
});

test('loadFiles: ENOENT is baseline, bad JSON is corrupt', () => {
  const enoent = () => { const e = new Error('x'); e.code = 'ENOENT'; throw e; };
  const a = L.loadFiles('/x', enoent);
  assert.equal(a.stateMissing, true); assert.equal(a.corrupt, false);
  const b = L.loadFiles('/x', () => '{not json');
  assert.equal(b.corrupt, true);
});

test('the current record does not qualify for rung 1 (7-day rejection 45%)', () => {
  const state = fresh({ promoteEnabled: true });
  const r = run(state, rec({ stats: { landed: 106, rejected: 87, attempts: 193, rate: 87 / 193 } }));
  assert.equal(r.report.promoted, null);
  assert.match(r.report.missing.join(' '), /rejection 45% must be under 40%/);
  assert.equal(r.state.rungs['larger-cards'].unlocked, false);
});

test('promotes one rung on a full clean record, only when promoteEnabled', () => {
  const shadow = run(fresh(), rec());
  assert.equal(shadow.report.promoted, null);
  assert.match(shadow.report.holds.join(' '), /promoteEnabled is false/);
  const live = run(fresh({ promoteEnabled: true }), rec());
  assert.equal(live.report.promoted, 'larger-cards');
  assert.equal(live.state.rungs['larger-cards'].unlocked, true);
  assert.equal(live.state.clock.cleanSince, iso(NOW)); // the next rung is earned on its own record
});

test('too few attempts, too short a clean window, or a confirmed breach each block promotion', () => {
  const p = fresh({ promoteEnabled: true });
  assert.equal(run(p, rec({ stats: { landed: 5, rejected: 1, attempts: 6, rate: 1 / 6 } })).report.promoted, null);
  assert.equal(run(fresh({ promoteEnabled: true, clock: { cleanSince: iso(NOW - 3 * DAY), lastEvalAt: null } }), rec()).report.promoted, null);
  const b = run(p, rec({ breaches: [{ lane: 'cloud', cls: 'stopped', why: 'x' }] }));
  assert.equal(b.report.promoted, null);
  assert.equal(b.state.clock.cleanSince, iso(NOW)); // a breach restarts the clock
});

test('an unreadable source holds and pauses the clock; it never counts as clean', () => {
  const p = fresh({ promoteEnabled: true, clock: { cleanSince: iso(NOW - 8 * DAY), lastEvalAt: iso(NOW - 2 * 3600_000) } });
  for (const missing of [{ stats: null }, { regressions: null }, { breaches: null }]) {
    const r = run(p, rec(missing));
    assert.equal(r.report.status, 'hold');
    assert.equal(r.report.promoted, null);
    assert.equal(r.state.clock.cleanSince, iso(NOW - 8 * DAY + 2 * 3600_000)); // two unreadable hours do not count
  }
});

test('a regression relocks exactly one rung, once per id, and restarts the clock', () => {
  const p = fresh({ promoteEnabled: true });
  p.rungs['larger-cards'] = { unlocked: true, since: iso(NOW - DAY) };
  const reg = { id: 'revert:abc1234', at: NOW - 3600_000, why: 'reverts Codex landing abc1234' };
  const r = run(p, rec({ regressions: [reg] }));
  assert.deepEqual(r.report.relocked.map((x) => x.rung), ['review-texts-ro']); // cause unknown: highest unlocked first
  assert.equal(r.state.rungs['review-texts-ro'].unlocked, false);
  assert.equal(r.state.rungs['cloud-data-route'].unlocked, true);
  assert.equal(r.state.rungs['larger-cards'].unlocked, true);
  assert.equal(r.state.clock.cleanSince, iso(NOW));
  const again = L.evaluate({ state: r.state, owner: L.seedOwner(), record: rec({ regressions: [reg] }), nowMs: NOW + 3600_000 });
  assert.deepEqual(again.report.relocked, []); // same sha, no second relock
  assert.equal(again.state.rungs['cloud-data-route'].unlocked, true);
});

test('a regression with a known capability relocks that rung, and never a different one', () => {
  const p = fresh();
  p.rungs['larger-cards'] = { unlocked: true };
  const r = run(p, rec({ regressions: [{ id: 'fwd:1', at: NOW, why: 'x', capability: 'larger-cards' }] }));
  assert.deepEqual(r.report.relocked.map((x) => x.rung), ['larger-cards']);
  const locked = run(fresh(), rec({ regressions: [{ id: 'fwd:2', at: NOW, why: 'x', capability: 'larger-cards' }] }));
  assert.deepEqual(locked.report.relocked, []); // already locked: nothing else is taken
  assert.equal(locked.state.rungs['cloud-data-route'].unlocked, true);
});

test('owner-file regressions relock too; the kill switch freezes evaluation', () => {
  const owner = { ...L.seedOwner(), regressions: [{ id: 'owner:1', at: iso(NOW), why: 'owner saw a bad data fix' }] };
  assert.equal(run(fresh(), rec(), owner).report.relocked.length, 1);
  const killed = run(fresh(), rec(), { ...L.seedOwner(), killSwitch: true });
  assert.equal(killed.report.status, 'killed');
  assert.deepEqual(killed.events, []);
});

test('rungs 4 and 5 are report-only: the record can qualify, nothing unlocks', () => {
  const r = run(fresh({ promoteEnabled: true }), rec());
  assert.match(r.report.rungs['ios-app-repo'], /waiting on a macOS verify path/);
  assert.match(r.report.rungs['workflow-files'], /locked until the owner gives a fresh yes/);
  assert.equal(r.state.rungs['ios-app-repo'], undefined);
  assert.equal(r.state.rungs['workflow-files'], undefined);
  const withPrereq = run(fresh(), rec(), { ...L.seedOwner(), prerequisites: { iosVerifyPath: 'macos-runner xcodebuild' }, ownerYes: { by: 'owner', date: '2026-11-01', ref: 'x' } });
  assert.match(withPrereq.report.rungs['ios-app-repo'], /picker wiring for the app repo is not built/);
  assert.match(withPrereq.report.rungs['workflow-files'], /runner still hard-skips/);
  assert.deepEqual([...L.NEVER], ['keys', 'emails', 'spend', 'land-refs']);
});

test('rejectionStats: counts only summaries inside the window, via the real runnerSummaryFacts', () => {
  const body = (landed, rej) => `## Codex runner 2026-11-09: 3 card(s) worked in 100 min (slot 0) (lane cloud)\n- Landed and Done: ${landed}\n- Landed part, back to Todo with what is left: none\n- Did not pass the Claude check, back to Todo: ${rej}\n`;
  const s = [
    { createdAt: iso(NOW - DAY), body: body('BRO-1, BRO-2', 'BRO-3') },
    { createdAt: iso(NOW - 2 * DAY), body: body('BRO-4', 'none') },
    { createdAt: iso(NOW - 30 * DAY), body: body('BRO-5', 'BRO-6') },
  ];
  const st = L.rejectionStats(s, NOW, 7, runnerSummaryFacts);
  assert.deepEqual([st.landed, st.rejected, st.attempts], [3, 1, 4]);
  assert.equal(st.rate, 0.25);
  assert.equal(L.rejectionStats([], NOW, 7, runnerSummaryFacts).rate, null);
});

const commit = (sha, author, ct, subject, body = '') => `${sha}\x1f${author}\x1f${ct}\x1f${subject}\x1f${body}\x1e`;
test('gitRegressions: reverts and forward fixes of Codex landings; a shallow read is unknown', () => {
  const t = Math.floor(NOW / 1000);
  const raw = [
    commit('a'.repeat(40), 'Codex runner', t - 5 * 86400, 'fix BRO-100 thing'),
    commit('b'.repeat(40), 'Codex runner', t - 4 * 86400, 'fix BRO-101 other'),
    commit('c'.repeat(40), 'Codex runner', t - 3 * 86400, 'fix BRO-102 third'),
    commit('d'.repeat(40), 'Claude', t - 2 * 86400, 'Revert "fix BRO-100 thing"', `This reverts commit ${'a'.repeat(40)}.`),
    commit('e'.repeat(40), 'Claude', t - 86400, 'BRO-101: regression from the data fix'),
    commit('f'.repeat(40), 'Claude', t - 86400, 'BRO-102 follow up tidy'),
    commit('1'.repeat(40), 'Claude', t - 3600, 'Revert "Revert "fix BRO-100 thing""', `This reverts commit ${'d'.repeat(40)}.`),
  ].join('\n');
  const got = L.gitRegressions(raw);
  assert.deepEqual(got.map((g) => g.id).sort(), ['fwd:eeeeeee', 'revert:aaaaaaa']);
  assert.equal(L.gitRegressions(null), null);
  assert.deepEqual(L.gitRegressions(''), []);
});

test('isProtectedPath covers the ladder files and its grading inputs, and nothing else', () => {
  for (const p of ['data/audit/codex-trust-ladder.json', 'data/audit/codex-trust-ladder-owner.json', 'scripts/lib/codex-trust-ladder.js', 'scripts/codex-trust-ladder.js',
    // BRO-6303: the summary format/parser, the summary reader and the lane-health breaches
    'scripts/lib/codex-runner-grading.js', 'scripts/codex-lane-alarm.js', 'scripts/lib/codex-lane-health.js']) assert.equal(L.isProtectedPath(p), true, p);
  // Codex legitimately lands runner fixes (BRO-5694), so the runner itself stays editable.
  for (const p of ['data/audit/codex-lane-health.json', 'scripts/lib/codex-runner.js', 'scripts/codex/daily-runner.js', 'src/app/page.tsx', '', null]) assert.equal(L.isProtectedPath(p), false, String(p));
  // What the ladder grades on really lives in the protected file, not a copy elsewhere.
  const G = require('../../scripts/lib/codex-runner-grading.js');
  const R = require('../../scripts/lib/codex-runner.js');
  for (const k of ['runnerSummaryFacts', 'runnerSummaryText', 'summaryHeading', 'parseSummaryHeading', 'laneOfSummary', 'LANES']) assert.equal(R[k], G[k], k);
  // The graders load the parser from the protected file itself, never via a re-export Codex could edit.
  const { readFileSync } = require('node:fs');
  for (const f of ['scripts/codex-trust-ladder.js', 'scripts/lib/codex-lane-health.js']) {
    const src = readFileSync(new URL(`../../${f}`, import.meta.url), 'utf8');
    assert.match(src, /\{ runnerSummaryFacts[^}]*\} = require\('\.\/(?:lib\/)?codex-runner-grading\.js'\)/, f);
    assert.doesNotMatch(src, /runnerSummaryFacts[^}]*\} = require\('\.\/(?:lib\/)?codex-runner\.js'\)/, f);
  }
  // Every protected file a card could name is caught by the card regex (codexCardFit's protected-path skip).
  for (const f of L.PROTECTED_FILES) assert.match(f, L.PROTECTED_CARD_RE, f);
  assert.match('data/audit/codex-trust-ladder-owner.json', L.PROTECTED_CARD_RE);
  assert.doesNotMatch('scripts/lib/codex-runner.js scripts/codex/daily-runner.js', L.PROTECTED_CARD_RE);
});

const liveState = (now) => ({ ...L.seedState(now), mode: 'live' });
const NOW2 = Date.parse("2026-11-10T00:00:00Z");
const rec2 = (regressions) => ({ stats: { attempts: 10, rate: 0.5 }, regressions, breaches: [] });

test('regressions older than the seed do not relock on the first live run', () => {
  const st = liveState('2026-10-26T00:00:00Z');
  const old = [{ id: 'revert:aaaaaaa', at: Date.parse('2026-10-20T00:00:00Z'), why: 'old' }, { id: 'revert:bbbbbbb', at: Date.parse('2026-11-01T00:00:00Z'), why: 'new' }];
  const r = L.evaluate({ state: st, owner: L.seedOwner(), record: rec2(old), nowMs: NOW2 });
  assert.equal(r.report.relocked.length, 1);
  assert.equal(r.report.relocked[0].regression.id, 'revert:bbbbbbb');
});

test('owner regressions without an id are ignored loudly and never jam the handled list', () => {
  const owner = { ...L.seedOwner(), regressions: [{ at: '2026-11-02T00:00:00Z', why: 'x' }, { id: 'o1', at: '2026-11-03T00:00:00Z', why: 'y' }] };
  const r = L.evaluate({ state: liveState('2026-10-26T00:00:00Z'), owner, record: rec2([]), nowMs: NOW2 });
  assert.equal(r.report.relocked.length, 1);
  assert.deepEqual(r.state.handledRegressions, ['o1']);
  assert.match(r.report.holds.join(' '), /ignored/);
});

test('a card id is matched on a word boundary and "broken" is not a regression word', () => {
  const sep = '\x1e'; const f = (sha, an, ct, subj, body = '') => [sha, an, ct, subj, body].join('\x1f') + sep;
  const t = 1790000000;
  const raw = f('a'.repeat(40), 'Codex runner', t, 'feat: BRO-100 something') + f('b'.repeat(40), 'Human', t + 60, 'BRO-10: rollback thing') + f('c'.repeat(40), 'Human', t + 90, 'BRO-100: fix broken link in docs');
  assert.deepEqual(L.gitRegressions(raw), []);
  const raw2 = f('a'.repeat(40), 'Codex runner', t, 'feat: BRO-100 something') + f('d'.repeat(40), 'Human', t + 60, 'BRO-100: rollback the thing');
  assert.equal(L.gitRegressions(raw2).length, 1);
});

test('wrong-shape state is corrupt, not a crash', () => {
  const files = { 'data/audit/codex-trust-ladder.json': '{}', 'data/audit/codex-trust-ladder-owner.json': JSON.stringify(L.seedOwner()) };
  const got = L.loadFiles('/x', (p) => { const k = Object.keys(files).find((n) => p.endsWith(n)); if (!k) throw Object.assign(new Error('x'), { code: 'ENOENT' }); return files[k]; });
  assert.equal(got.corrupt, true);
  assert.equal(L.access({ state: got.state, owner: got.owner, corrupt: got.corrupt, env: {} }).source, 'corrupt-locked');
});

test('env kill switch tolerates whitespace and the clock pause never reaches the future', () => {
  assert.equal(L.access({ state: liveState('2026-10-26T00:00:00Z'), owner: null, env: { CODEX_TRUST_LADDER_DISABLED: ' true ' } }).source, 'killed');
  const st = liveState('2026-10-26T00:00:00Z'); st.clock.lastEvalAt = '2026-11-09T00:00:00Z'; st.clock.cleanSince = '2026-11-20T00:00:00Z';
  const r = L.evaluate({ state: st, owner: L.seedOwner(), record: { stats: null, regressions: null, breaches: null }, nowMs: NOW2 });
  assert.ok(Date.parse(r.state.clock.cleanSince) <= NOW2);
});

// ---------- BRO-6303: ladderAccess, what the runner reads ----------
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A fake git over an in-memory origin/main, shaped like execFileSync: files maps rel path -> content;
// null files = no origin/main ref (rev-parse --verify --quiet exits 1); fail = a command that errors.
const SHA = 'abc1234def';
const gitErr = (status) => Object.assign(new Error(`git exited ${status}`), { status });
const fakeGit = (files, calls = [], fail = null) => (args) => {
  calls.push(args.join(' '));
  if (fail && fail(args)) throw gitErr(128);
  if (args[0] === 'rev-parse') { if (!files) throw gitErr(1); return `${SHA}\n`; }
  if (args[0] === 'ls-tree') { assert.equal(args[2], SHA, 'both files from the one resolved commit'); return files && args[4] in files ? `${args[4]}\n` : ''; }
  if (args[0] === 'show') { assert.ok(args[1].startsWith(`${SHA}:`)); return files[args[1].slice(SHA.length + 1)]; }
  throw new Error(`unexpected git ${args[0]}`);
};
const REF = `origin/main@${SHA.slice(0, 7)}`;
const liveJson = (unlocked) => { const st = L.seedState('2026-10-26T00:00:00.000Z'); st.mode = 'live'; for (const k of Object.keys(st.rungs)) st.rungs[k].unlocked = unlocked.includes(k); return JSON.stringify(st); };
let rootN = 0;
const freshRoot = () => { const d = mkdtempSync(join(tmpdir(), 'ladder-')); rootN += 1; return join(d, String(rootN)); };

test('ladderAccess: reads origin/main; shadow = baseline, missing = not set up, corrupt fails closed', () => {
  const base = { source: 'baseline', minScore: -6, cloudDataRouteLocked: false, reviewTextsLocked: false };
  const shadow = JSON.stringify(L.seedState('2026-10-26T00:00:00.000Z'));
  assert.deepEqual(L.ladderAccess({ root: freshRoot(), env: {}, git: fakeGit({ [L.STATE_FILE]: shadow }) }), { ...base, mode: 'shadow', ref: REF });
  assert.deepEqual(L.ladderAccess({ root: freshRoot(), env: {}, git: fakeGit({}) }), { ...base, mode: 'not set up', ref: REF }, 'a file not on main is not corrupt');
  const bad = L.ladderAccess({ root: freshRoot(), env: {}, git: fakeGit({ [L.STATE_FILE]: '{ not json' }) });
  assert.deepEqual(bad, { source: 'corrupt-locked', minScore: -6, cloudDataRouteLocked: true, reviewTextsLocked: true, mode: 'corrupt', ref: REF });
  const live = L.ladderAccess({ root: freshRoot(), env: {}, git: fakeGit({ [L.STATE_FILE]: liveJson(['larger-cards', 'review-texts-ro']) }) });
  assert.deepEqual(live, { source: 'ladder', minScore: -9, cloudDataRouteLocked: true, reviewTextsLocked: false, mode: 'live', ref: REF });
  // The owner's kill switch on main wins over a live state.
  const killedOwner = JSON.stringify({ ...L.seedOwner(), killSwitch: true });
  assert.equal(L.ladderAccess({ root: freshRoot(), env: {}, git: fakeGit({ [L.STATE_FILE]: liveJson([]), [L.OWNER_FILE]: killedOwner }) }).source, 'killed');
});

test('ladderAccess: a git failure fails closed (every rung locked), never reads as "not set up"', () => {
  const locked = { source: 'corrupt-locked', minScore: -6, cloudDataRouteLocked: true, reviewTextsLocked: true };
  const files = { [L.STATE_FILE]: liveJson(['cloud-data-route', 'review-texts-ro']) };
  for (const [what, fail] of [['rev-parse', (a) => a[0] === 'rev-parse'], ['ls-tree', (a) => a[0] === 'ls-tree'], ['show', (a) => a[0] === 'show']]) {
    const a = L.ladderAccess({ root: freshRoot(), env: {}, git: fakeGit(files, [], fail) });
    assert.deepEqual({ source: a.source, minScore: a.minScore, cloudDataRouteLocked: a.cloudDataRouteLocked, reviewTextsLocked: a.reviewTextsLocked }, locked, what);
  }
  // Outside any git repo at all: locked too.
  const outside = L.ladderAccess({ root: mkdtempSync(join(tmpdir(), 'ladder-nogit-')), env: {} });
  assert.equal(outside.source, 'corrupt-locked');
});

test('ladderAccess: no origin/main ref reads the working tree; the working tree never overrides main', () => {
  const root = freshRoot();
  mkdirSync(join(root, 'data/audit'), { recursive: true });
  writeFileSync(join(root, L.STATE_FILE), liveJson(['larger-cards']));
  const wt = L.ladderAccess({ root, env: {}, git: fakeGit(null) });
  assert.equal(wt.ref, 'worktree');
  assert.equal(wt.minScore, -9);
  const root2 = freshRoot();
  mkdirSync(join(root2, 'data/audit'), { recursive: true });
  writeFileSync(join(root2, L.STATE_FILE), liveJson(['larger-cards'])); // a worktree edit main does not have
  assert.equal(L.ladderAccess({ root: root2, env: {}, git: fakeGit({ [L.STATE_FILE]: liveJson([]) }) }).minScore, -6);
});

test('ladderAccess: cached per root for ACCESS_TTL_MS, so a long runner still sees a relock within minutes', () => {
  const root = freshRoot();
  const calls = [];
  const files = { [L.STATE_FILE]: liveJson(['review-texts-ro']) };
  const t0 = Date.parse('2026-10-26T10:00:00Z');
  assert.equal(L.ladderAccess({ root, env: {}, nowMs: t0, git: fakeGit(files, calls) }).reviewTextsLocked, false);
  files[L.STATE_FILE] = liveJson([]); // relocked on main
  assert.equal(L.ladderAccess({ root, env: {}, nowMs: t0 + 60_000, git: fakeGit(files, calls) }).reviewTextsLocked, false, 'cached');
  assert.equal(L.ladderAccess({ root, env: {}, nowMs: t0 + L.ACCESS_TTL_MS, git: fakeGit(files, calls) }).reviewTextsLocked, true, 'reread after the TTL');
  assert.ok(L.ACCESS_TTL_MS <= 10 * 60_000);
  // The env kill switch reads no file at all and is never cached either way.
  const killCalls = [];
  assert.deepEqual(L.ladderAccess({ root, env: { CODEX_TRUST_LADDER_DISABLED: '1' }, nowMs: t0 + L.ACCESS_TTL_MS + 1, git: fakeGit(files, killCalls) }),
    { source: 'killed', minScore: -6, cloudDataRouteLocked: false, reviewTextsLocked: false, mode: 'killed', ref: 'env' });
  assert.deepEqual(killCalls, []);
  assert.equal(L.ladderAccess({ root, env: {}, nowMs: t0 + L.ACCESS_TTL_MS + 2, git: fakeGit(files) }).reviewTextsLocked, true);
});

test('ladderAccess: the committed ladder on this checkout is shadow, so the runner keeps its baseline', () => {
  const a = L.ladderAccess({ env: {} });
  assert.ok(['shadow', 'not set up'].includes(a.mode) || a.source !== 'baseline', JSON.stringify(a));
  if (a.mode === 'shadow') assert.deepEqual({ source: a.source, minScore: a.minScore, cloudDataRouteLocked: a.cloudDataRouteLocked, reviewTextsLocked: a.reviewTextsLocked }, { source: 'baseline', minScore: -6, cloudDataRouteLocked: false, reviewTextsLocked: false });
});

test('accessLine: one summary line naming the mode, the source and every gate', () => {
  assert.equal(L.accessLine({ source: 'baseline', minScore: -6, cloudDataRouteLocked: false, reviewTextsLocked: false, mode: 'shadow', ref: 'origin/main@abc1234' }),
    '- Trust ladder: shadow (baseline, read from origin/main@abc1234); min score -6, cloud data route open, review-texts open');
  assert.match(L.accessLine(L.access({ corrupt: true, env: {} })), /corrupt-locked\); min score -6, cloud data route locked, review-texts locked$/);
});
