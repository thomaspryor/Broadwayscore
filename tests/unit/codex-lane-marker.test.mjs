// BRO-6139 (BRO-6134 stages 2+3): every runner summary names its lane, every quiet exit says why,
// and the lane alarm reads both. Real headings come from the BRO-4745 history in
// tests/fixtures/codex-lane-history.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const R = require(path.join(ROOT, 'scripts/lib/codex-runner.js'));
const { codexLaneHealth } = require(path.join(ROOT, 'scripts/lib/codex-lane-health.js'));
const HIST = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/fixtures/codex-lane-history.json'), 'utf8'));
const H = 3600_000;
const T = (s) => Date.parse(`2026-${s}:00Z`);
const summary = (at, head, rest = '- Landed and Done: none\n- Stopped early: no') => ({ createdAt: new Date(at).toISOString(), body: `${head}\n${rest}` });

test('summaryHeading: names slot and lane, parses back, and still matches the pre-marker readers', () => {
  const h = R.summaryHeading({ date: '2026-10-24', worked: 2, mins: 80, slot: 3, lane: 'gha' });
  assert.equal(h, '## Codex runner 2026-10-24: 2 card(s) worked in 80 min (slot 3) (lane gha)');
  assert.deepEqual(R.parseSummaryHeading(h), { date: '2026-10-24', worked: 2, mins: 80, slot: 3, lane: 'gha' });
  assert.match(h, /^## Codex runner \d{4}-\d{2}-\d{2}:/, 'runnerHealth / claude-session-cost still see it as a summary');
  assert.match(h, /\(slot 3\)/);
  // A gha launch that fell back to the cloud lane's slot 0 is still the gha lane.
  assert.equal(R.laneOfSummary(R.summaryHeading({ date: '2026-10-24', worked: 0, mins: 3, slot: 0, lane: 'gha' }), 0), 'gha');
  assert.equal(R.parseSummaryHeading('## Codex runner: landed\n\nnot a summary'), null);
});

test('laneOfSummary: real slotless BRO-4745 headings go to the lane that ran them', () => {
  const slotless = HIST.summaries.filter((c) => { const h = R.parseSummaryHeading(c.body); return h && h.slot === null; });
  assert.ok(slotless.length >= 40, `the fixture keeps the slotless history (${slotless.length})`);
  const lane = (iso) => {
    const c = HIST.summaries.find((x) => x.createdAt.startsWith(iso));
    assert.ok(c, `fixture has the ${iso} summary`);
    return R.laneOfSummary(c.body, Date.parse(c.createdAt), HIST.runs);
  };
  // codex-runner.yml runs of 150, 125 and 141 min posted these single-slot summaries.
  assert.equal(lane('2026-10-18T17:01'), 'gha');
  assert.equal(lane('2026-10-18T20:41'), 'gha');
  assert.equal(lane('2026-10-20T02:38'), 'gha');
  // Cloud runs of 61 min that merely ended 2-5 min after a 3-min gha stand-down.
  assert.equal(lane('2026-10-24T05:51'), 'cloud');
  assert.equal(lane('2026-10-23T23:51'), 'cloud');
  // Stage 1's reader (slotOf) took every one of them for cloud; only those three are gha.
  const gha = slotless.filter((c) => R.laneOfSummary(c.body, Date.parse(c.createdAt), HIST.runs) === 'gha');
  assert.deepEqual(gha.map((c) => c.createdAt.slice(0, 16)).sort(), ['2026-10-18T17:01', '2026-10-18T20:41', '2026-10-20T02:38']);
  // Without the run list a slotless summary stays cloud, as before; an explicit slot decides on its own.
  assert.equal(R.laneOfSummary(slotless[0].body, Date.parse(slotless[0].createdAt)), 'cloud');
  assert.equal(R.laneOfSummary('## Codex runner 2026-10-21: 3 card(s) worked in 142 min (slot 4)', 0), 'gha');
  assert.equal(R.laneOfSummary('## Codex runner 2026-10-21: 1 card(s) worked in 36 min (slot 2)', 0), 'cloud');
});

test('firingThroughput: a launch counts once from its first slot in either lane', () => {
  const s = (worked, slot, lane) => ({ body: `${R.summaryHeading({ date: '2026-10-25', worked, mins: 100, slot, lane })}\n- Landed and Done: none` });
  const t = R.firingThroughput([s(2, 0, 'cloud'), s(1, 1, 'cloud'), s(1, 2, 'cloud'), s(3, 3, 'gha'), s(2, 4, 'gha'), s(1, 0, 'gha'),
    { body: '## Codex runner 2026-10-15: 3 card(s) worked in 100 min\n- Landed and Done: BRO-1' }]);
  assert.equal(t.firings, 4, 'cloud slot 0, gha slot 3, the gha fallback on slot 0, and a legacy lone runner');
  assert.equal(t.worked, 13);
});

test('codex-lane-health: gha summaries never count as cloud runs', () => {
  const now = T('10-25T12:00');
  const ghaOnly = [summary(now - 0.5 * H, R.summaryHeading({ date: '2026-10-25', worked: 2, mins: 100, slot: 0, lane: 'gha' }))];
  const r = codexLaneHealth({ nowMs: now, summaries: ghaOnly });
  assert.ok(r.breaches.some((b) => b.lane === 'cloud' && b.cls === 'no-run'), 'a gha fallback on slot 0 does not mask cloud:no-run');
  assert.equal(r.facts.ghaSummaries12h, 1);
  const cloud = [summary(now - 0.5 * H, R.summaryHeading({ date: '2026-10-25', worked: 1, mins: 60, slot: 0, lane: 'cloud' }))];
  assert.equal(codexLaneHealth({ nowMs: now, summaries: cloud }).breaches.length, 0);
});

test('standDownNote: round trip, fixed classes, and the legacy login note', () => {
  const b = R.standDownNote({ lane: 'gha', slot: 0, cls: 'lock-held', why: 'another run holds the lock (locked BRO-1, 20 min old)', holderStartedMs: T('10-25T10:00') });
  assert.match(b, /^## Codex runner did not start \(slot 0\) \(lane gha\) \(reason lock-held\)/);
  assert.deepEqual(R.parseStandDownNote(b), { lane: 'gha', slot: 0, cls: 'lock-held', why: 'another run holds the lock (locked BRO-1, 20 min old)', holderStartedMs: T('10-25T10:00'), loginExpiresMs: NaN });
  const fence = '\n```\n' + 'x'.repeat(600) + '\n```';
  assert.ok(R.standDownNote({ cls: 'login', why: `No usable Codex login.${fence}` }).endsWith('```'), 'a login note keeps its closing fence');
  assert.equal(R.parseStandDownNote(R.standDownNote({ cls: 'nonsense', why: 'x' })).cls, 'crash', 'an unknown class is a crash, never silent');
  assert.equal(R.parseStandDownNote('## Codex runner did not start\n\nNo usable Codex login (it may have expired).').cls, 'login');
  assert.equal(R.parseStandDownNote('## Codex runner 2026-10-25: 1 card(s) worked in 3 min'), null);
  assert.equal(R.lockStartedMs(R.runnerLockBody({ run: 'gha-1', startedMs: T('10-25T10:00'), hardEndMs: T('10-25T14:50'), phase: 'cards' })), T('10-25T10:00'));
});

const ghaRun = (startMs, min) => ({ startMs, endMs: startMs + min * 60_000, durationMin: min, conclusion: 'success' });
const note = (at, lane, cls, why = 'x', holderStartedMs, loginExpiresMs) => ({ createdAt: new Date(at).toISOString(), body: R.standDownNote({ lane, cls, why, holderStartedMs, loginExpiresMs }) });

test('gha:stand-down: deliberate login-refresh stand-downs near expiry are not a fault; elsewhere they say why', () => {
  const now = T('10-25T23:30');
  const runs = [ghaRun(T('10-25T16:13'), 2), ghaRun(T('10-25T21:13'), 3)];
  const cloud = [summary(now - H, R.summaryHeading({ date: '2026-10-25', worked: 1, mins: 60, slot: 0, lane: 'cloud' }), '- Landed and Done: BRO-9\n- Stopped early: no')];
  const refresh = [note(T('10-25T16:14'), 'gha', 'login-refresh', 'the Codex login expires 2026-10-25T21:30Z, within this run'), note(T('10-25T21:15'), 'gha', 'login-refresh')];
  // Both firings start within a gha run (290 min + 30 min margin) of expiry, as the runner's own gate requires.
  const nearExpiry = { lastRefreshMs: T('10-15T21:30'), savedMs: T('10-15T21:30'), accessExpiresMs: T('10-25T21:30') };
  const ok = codexLaneHealth({ nowMs: now, summaries: [...cloud, ...refresh], ghRuns: runs, login: nearExpiry });
  assert.ok(!ok.breaches.some((b) => b.cls === 'stand-down'), JSON.stringify(ok.breaches));
  assert.match(ok.facts.ghaStandDown, /deliberate/);
  // E6: the same "deliberate" stand-down days before expiry is the gate stuck on, so it breaches.
  const farOff = { ...nearExpiry, accessExpiresMs: T('10-30T22:52') };
  const stuck = codexLaneHealth({ nowMs: now, summaries: [...cloud, ...refresh], ghRuns: runs, login: farOff }).breaches.find((b) => b.lane === 'gha' && b.cls === 'stand-down');
  assert.match(stuck.why, /login-refresh, but the stored login expires 2026-10-30T22:52Z.*stuck on/);
  // A refresh saved since: judged against the expiry each stand-down saw, they stay deliberate.
  const stamped = [note(T('10-25T16:14'), 'gha', 'login-refresh', 'x', undefined, T('10-25T21:30')), note(T('10-25T21:15'), 'gha', 'login-refresh', 'x', undefined, T('10-25T21:30'))];
  const refreshed = { lastRefreshMs: T('10-25T21:31'), savedMs: T('10-25T21:40'), accessExpiresMs: T('11-04T21:31') };
  assert.ok(!codexLaneHealth({ nowMs: now, summaries: [...cloud, ...stamped], ghRuns: runs, login: refreshed }).breaches.some((b) => b.cls === 'stand-down'));
  // No login read: cannot excuse it.
  assert.ok(codexLaneHealth({ nowMs: now, summaries: [...cloud, ...refresh], ghRuns: runs }).breaches.some((b) => b.cls === 'stand-down'));
  // A lock-held stand-down is named in the breach; no note at all is called out as a quiet exit.
  const held = codexLaneHealth({ nowMs: now, summaries: [...cloud, note(T('10-25T21:15'), 'gha', 'lock-held', 'another run holds the lock')], ghRuns: runs, login: farOff });
  assert.match(held.breaches.find((b) => b.cls === 'stand-down').why, /lock-held: another run holds the lock/);
  assert.match(codexLaneHealth({ nowMs: now, summaries: cloud, ghRuns: runs }).breaches.find((b) => b.cls === 'stand-down').why, /said nothing/);
});

test('cloud stand-down notes: blocking classes are stopped runs, a long-held lock is lock-stale', () => {
  const now = T('10-25T12:00');
  const ran = summary(now - 3 * H, R.summaryHeading({ date: '2026-10-25', worked: 1, mins: 60, slot: 0, lane: 'cloud' }), '- Landed and Done: BRO-1\n- Stopped early: no');
  const sandbox = [note(now - 1.5 * H, 'cloud', 'sandbox', 'unusable namespace sandbox'), note(now - 0.5 * H, 'cloud', 'sandbox', 'unusable namespace sandbox')];
  const r = codexLaneHealth({ nowMs: now, summaries: [ran, ...sandbox] });
  assert.ok(r.breaches.some((b) => b.lane === 'cloud' && b.cls === 'stopped' && /did not start \(sandbox\)/.test(b.why)), JSON.stringify(r.breaches));
  // Three slots of one launch posting the same failure are one stopped run, not a streak.
  const perSlot = [0, 1, 2].map((k) => note(now - 0.5 * H + k * 60_000, 'cloud', 'picker', 'picker failed'));
  assert.ok(!codexLaneHealth({ nowMs: now, summaries: [ran, ...perSlot] }).breaches.some((b) => b.cls === 'stopped'));
  // lock-held is a run still working, not a stop; but a holder 7h in is a dead or stuck run.
  const busy = [note(now - 0.5 * H, 'cloud', 'lock-held', 'another run holds the lock', now - 1.5 * H)];
  const fine = codexLaneHealth({ nowMs: now, summaries: [ran, ...busy] });
  assert.equal(fine.breaches.length, 0, JSON.stringify(fine.breaches));
  assert.equal(Math.round(fine.facts.lockAgeH * 10) / 10, 1.5);
  const stuck = [note(now - 0.5 * H, 'cloud', 'lock-held', 'another run holds the lock', now - 7 * H)];
  assert.ok(codexLaneHealth({ nowMs: now, summaries: [ran, ...stuck] }).breaches.some((b) => b.cls === 'lock-stale'));
  // The holder was a gha fallback on slot 0 that has since posted its summary: the lock is free.
  const ghaDone = summary(now - 0.2 * H, R.summaryHeading({ date: '2026-10-25', worked: 1, mins: 400, slot: 0, lane: 'gha' }));
  assert.ok(!codexLaneHealth({ nowMs: now, summaries: [ran, ...stuck, ghaDone] }).breaches.some((b) => b.cls === 'lock-stale'));
  // no-run carries the lane's last word.
  const silent = codexLaneHealth({ nowMs: now, summaries: [summary(now - 5 * H, R.summaryHeading({ date: '2026-10-25', worked: 1, mins: 60, slot: 0, lane: 'cloud' })), note(now - H, 'cloud', 'login', 'No usable Codex login')] });
  assert.match(silent.breaches.find((b) => b.cls === 'no-run').why, /stand-down \(login\): No usable Codex login/);
});

test('login precondition: a refresh not saved to BRO-4799 after expiry breaches (the E6 class)', () => {
  const exp = T('10-25T22:52');
  const stamps = { lastRefreshMs: T('10-15T22:52'), savedMs: T('10-15T22:53'), accessExpiresMs: exp };
  assert.ok(!codexLaneHealth({ nowMs: exp + 5 * H, login: stamps }).breaches.some((b) => b.cls === 'login-not-saved'), 'inside the save grace');
  const late = codexLaneHealth({ nowMs: exp + 7 * H, login: stamps });
  assert.ok(late.breaches.some((b) => b.lane === 'codex' && b.cls === 'login-not-saved'));
  // Saved after the refresh: the stored expiry moved on.
  assert.equal(codexLaneHealth({ nowMs: exp + 7 * H, login: { lastRefreshMs: exp + H, savedMs: exp + 2 * H, accessExpiresMs: exp + 240 * H } }).breaches.length, 0);
  // No access_expires stamp yet (saved before BRO-6139): estimated from last_refresh + 10 days.
  const est = codexLaneHealth({ nowMs: exp + 7 * H, login: { lastRefreshMs: T('10-15T22:52'), savedMs: NaN, accessExpiresMs: NaN } });
  assert.match(est.facts.loginExpires, /2026-10-25T22:52Z \(estimated/);
  assert.ok(est.breaches.some((b) => b.cls === 'login-not-saved'));
  assert.ok(codexLaneHealth({ nowMs: exp, login: null }).unknown.includes('BRO-4799 login stamps'));
  assert.ok(!codexLaneHealth({ nowMs: exp }).unknown.includes('BRO-4799 login stamps'), 'not passed (the backtest) is skipped, not unknown');
  // The stored comment exposes the expiry stamp and nothing of the blob.
  const body = R.authCommentBody('U0VDUkVU', '2026-10-15T22:52:56.848618415Z', '2026-10-24T10:00:00Z', '2026-10-25T22:52:56.000Z');
  assert.deepEqual(R.parseAuthMeta(body), { lastRefreshMs: Date.parse('2026-10-15T22:52:56.848Z'), savedMs: Date.parse('2026-10-24T10:00:00Z'), accessExpiresMs: Date.parse('2026-10-25T22:52:56.000Z') });
  assert.equal(R.parseAuthComment(body).blob, 'U0VDUkVU', 'restore still reads the blob');
  const jwt = `x.${Buffer.from(JSON.stringify({ exp: exp / 1000 })).toString('base64url')}.y`;
  assert.equal(R.authAccessExpires(JSON.stringify({ tokens: { access_token: jwt } })), new Date(exp).toISOString());
  assert.equal(R.authAccessExpires('not json'), '');
});

test('daily-runner: the summary uses summaryHeading and no exit path is silent', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts/codex/daily-runner.js'), 'utf8');
  assert.match(src, /R\.summaryHeading\(\{[^}]*lane: OPTS\.lane/);
  assert.doesNotMatch(src, /`## Codex runner \$\{new Date\(\)\.toISOString\(\)\.slice\(0, 10\)\}: \$\{worked\}/, 'no hand-built heading');
  assert.doesNotMatch(src, /log\(`not starting: /, 'a "not starting" exit goes through standDown, which posts the reason');
  assert.doesNotMatch(src, /## Codex runner did not start\\n/, 'stand-down notes are built by R.standDownNote');
  const ensure = src.slice(src.indexOf('function ensureTools'), src.indexOf('\n}\n', src.indexOf('function ensureTools')));
  assert.doesNotMatch(ensure, /process\.exit\(/, 'a missing tool throws into the stand-down path instead of exiting quietly');
  // BRO-6303: the summary body is built by R.runnerSummaryText (codex-runner-grading.js, protected from Codex edits).
  assert.match(src, /R\.runnerSummaryText\(\{/, 'the summary is built by the protected builder');
  const stats = { landed: [], landedPartial: [], alreadyFixed: [], bounced: [], inReview: [], landFailed: [], crashed: [], recoveredStops: [], carried: [], outOfTime: [], wouldLand: [] };
  assert.match(R.runnerSummaryText({ heading: 'h', stats, worked: 0, skipped: 0, picks: [], stop: null, settingsLine: '', weeklyPct: null, checkCount: 0, checkSpentUsd: 0, checkByModel: {} }), /- Why nothing was worked: the picker returned no Codex-fit card/, 'a run that worked nothing says why');
  assert.match(src, /standDownClass/, 'main() turns a start failure or crash into a stand-down note');
  assert.match(src, /standDown\('crash', `killed by \$\{sig\}/, 'a kill before the summary says so');
  assert.doesNotMatch(src, /await standDown\(/, 'standDown is one bounded sync post, not linearBrain retries');
  assert.match(src, /held\.startsWith\('another run holds the lock'\) \? R\.lockStartedMs/, 'a lost race never reports the old holder');
  assert.match(src, /restore\.code === 0 && plan\.lane !== OPTS\.lane/, 'a login that did not restore is never a deliberate fallback');
});

test('runnerHealth (daily row): only a login stand-down reads as a lapsed login', () => {
  const now = T('10-25T12:00');
  const at = new Date(now - H).toISOString();
  assert.match(R.runnerHealth([{ createdAt: at, body: R.standDownNote({ cls: 'login', why: 'No usable Codex login' }) }], now).message, /login is not usable/);
  assert.match(R.runnerHealth([{ createdAt: at, body: R.standDownNote({ cls: 'lock-held', why: 'another run holds the lock' }) }], now).message, /not running/);
});
