// BRO-5887: tests for the pre-send review check (scripts/lib/reddit-review-check.js
// and the runner's runShowCheck). Each test require()s the real functions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const chk = require('./reddit-review-check.js');
const mail = require('./reddit-post-email.js');
const opening = require('./reddit-opening-post.js');
const { runShowCheck, TOOLS } = require('./reddit-review-check-runner.js');

const NOW = Date.parse('2026-10-22T06:00:00Z');
const hoursAgo = h => new Date(NOW - h * 3600e3).toISOString();

const baseDraft = (over = {}) => ({
  showId: 'x-off-broadway-2026', status: 'ready', title: 't', body: 'b', subreddit: 'offbroadwayNYC', submitUrl: 'https://a',
  showTitle: 'X', score: 74, reviewCount: 14, createdAt: hoursAgo(5), ...over,
});

function makeReviewTexts(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rrc-'));
  for (const [rel, rec] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), JSON.stringify(rec));
  }
  return dir;
}
const longText = 'x'.repeat(900);
const rec = (over = {}) => ({ outlet: 'Outlet', outletId: 'outlet', criticName: 'Jane Doe', publishDate: '2026-10-20', url: 'https://o.com/a', fullText: longText, contentTier: 'complete', ...over });

// ── what is due ──────────────────────────────────────────────────────────────

test('selectDueChecks: new and update drafts only, reminders skipped, cap and fresh-check reuse', () => {
  const mk = (id, over) => baseDraft({ showId: id, ...over });
  const drafts = { drafts: {
    brandNew: mk('brandNew'),
    updateDue: mk('updateDue', { emailedAt: hoursAgo(30), emailedScore: 70, emailedReviewCount: 14 }),
    reminderDue: mk('reminderDue', { emailedAt: hoursAgo(25), emailedScore: 74, emailedReviewCount: 14 }),
    fresh: mk('fresh', { verification: { status: 'clean', checkedAt: hoursAgo(2), score: 74, reviewCount: 14 } }),
    stale: mk('stale', { verification: { status: 'clean', checkedAt: hoursAgo(30), score: 74, reviewCount: 14 } }),
    moved: mk('moved', { verification: { status: 'clean', checkedAt: hoursAgo(2), score: 70, reviewCount: 14 } }),
    failedBefore: mk('failedBefore', { verification: { status: 'failed', checkedAt: hoursAgo(2), score: 74, reviewCount: 14 } }),
  } };
  const ids = chk.selectDueChecks(drafts, NOW, { max: 99 }).map(x => x.draft.showId).sort();
  assert.deepEqual(ids, ['brandNew', 'failedBefore', 'moved', 'stale', 'updateDue']);
  assert.equal(chk.selectDueChecks(drafts, NOW, { max: 2 }).length, 2, 'cap');
  assert.equal(chk.selectDueChecks(drafts, NOW, { only: ['fresh', 'reminderDue', 'brandNew', 'updateDue'], max: 3 }).length, 4, 'a list the owner named is never cut by the daily cap');
  // the owner's resend list is checked whatever the email state, even a fresh check
  assert.deepEqual(chk.selectDueChecks(drafts, NOW, { only: ['fresh', 'reminderDue', 'ghost'] }).map(x => x.draft.showId).sort(), ['fresh', 'reminderDue']);
  assert.deepEqual(chk.selectDueChecks(null, NOW), []);
});

// ── snapshots and change summary ─────────────────────────────────────────────

test('summarizeChanges: added, named, dated, recovered text, cleared flag, resolved pending', () => {
  const id = 'x-off-broadway-2026';
  const dir = makeReviewTexts({
    [`${id}/keep.json`]: rec(),
    [`${id}/noname.json`]: rec({ outlet: 'Time Out', outletId: 'timeout', criticName: 'Unknown', url: 'https://t.com/a' }),
    [`${id}/nodate.json`]: rec({ outlet: 'Edge', publishDate: '' }),
    [`${id}/stub.json`]: rec({ outlet: 'Bachtrack', fullText: '' }),
    [`${id}/flagged.json`]: rec({ outlet: 'Air Mail', wrongProduction: true }),
    [`_pending/${id}/p1.json`]: rec({ outlet: 'Pending Outlet', criticName: '' }),
    [`_pending/${id}/p2.json`]: rec({ outlet: 'Still Pending', criticName: '' }),
  });
  const before = chk.snapshotShow(dir, id);
  assert.equal(before.size, 7);
  assert.ok(before.has('_pending/p1.json'), 'pending files keyed with the _pending/ prefix');
  // the tools run
  fs.writeFileSync(path.join(dir, id, 'noname.json'), JSON.stringify(rec({ outlet: 'Time Out', outletId: 'timeout', criticName: 'Adam Feldman', url: 'https://t.com/a' })));
  fs.writeFileSync(path.join(dir, id, 'nodate.json'), JSON.stringify(rec({ outlet: 'Edge', publishDate: '2026-10-21' })));
  fs.writeFileSync(path.join(dir, id, 'stub.json'), JSON.stringify(rec({ outlet: 'Bachtrack' })));
  fs.writeFileSync(path.join(dir, id, 'flagged.json'), JSON.stringify(rec({ outlet: 'Air Mail', wrongProduction: false })));
  fs.writeFileSync(path.join(dir, id, 'brandnew.json'), JSON.stringify(rec({ outlet: 'Guardian', url: 'https://g.com/a' })));
  fs.renameSync(path.join(dir, '_pending', id, 'p1.json'), path.join(dir, id, 'p1.json'));
  const after = chk.snapshotShow(dir, id);
  const s = chk.summarizeChanges(before, after);
  assert.deepEqual(s.added.map(x => x.outlet).sort(), ['Guardian', 'Pending Outlet']);
  assert.deepEqual(s.named.map(x => `${x.outlet}:${x.to}`), ['Time Out:Adam Feldman']);
  assert.deepEqual(s.dated.map(x => x.outlet), ['Edge']);
  assert.deepEqual(s.recovered.map(x => x.outlet), ['Bachtrack']);
  assert.deepEqual(s.flagCleared.map(x => x.outlet), ['Air Mail']);
  assert.equal(s.pendingResolved, 1);
  assert.equal(s.needsScoring, true);
  assert.equal(s.changed, true);
  // nothing changed: nothing reported
  const none = chk.summarizeChanges(after, chk.snapshotShow(dir, id));
  assert.deepEqual([none.changed, none.needsScoring], [false, false]);
  // names and dates alone never claim new counts
  const metaOnly = chk.summarizeChanges(new Map([['a.json', chk.snapshotShow(dir, id).get('keep.json')]]), new Map([['a.json', { ...chk.snapshotShow(dir, id).get('keep.json'), publishDate: '2026-01-01' }]]));
  assert.equal(metaOnly.needsScoring, false);
  assert.deepEqual(chk.snapshotShow(dir, 'no-such-show').size, 0, 'missing dirs are empty, not fatal');
});

// ── census gaps ──────────────────────────────────────────────────────────────

test('censusFromAudit + explainGaps give the owner a reason per missing review', () => {
  const audit = { results: [
    { showId: 'x', censusVerdict: { verdict: 'incomplete', missing: [
      { outletId: 'outinjersey', outlet: 'outinjersey', url: 'https://outinjersey.net/a' },
      { outletId: 'timeout', outlet: 'timeout', url: 'https://timeout.com/a' },
      { outletId: 'bachtrack', outlet: 'bachtrack', url: 'https://bachtrack.com/a' },
      { outletId: 'theatremonkey', outlet: 'theatremonkey', url: 'https://tm.com/a' },
      { outletId: '1883magazine', outlet: '1883magazine', url: 'https://1883.com/a' },
      { outletId: 'edge', outlet: 'edge', url: 'https://edge.com/a' },
    ] } },
    { showId: 'y' },
  ] };
  const c = chk.censusFromAudit(audit, 'x');
  assert.equal(c.verdict, 'incomplete');
  assert.equal(c.missing.length, 6);
  assert.equal(chk.censusFromAudit(audit, 'y'), null, 'no verdict: nothing to report');
  assert.equal(chk.censusFromAudit(null, 'x'), null);
  const snap = new Map([
    ['a.json', { outlet: 'OutInJersey', outletId: 'outinjersey', criticName: 'A B', url: 'https://www.outinjersey.net/a/', textLen: 5000, flags: ['wrongProduction'] }],
    ['b.json', { outlet: 'Bachtrack', outletId: 'bachtrack', criticName: 'Unknown', url: 'https://bachtrack.com/a', textLen: 0, flags: [] }],
    ['c.json', { outlet: 'Theatre Monkey', outletId: 'theatremonkey', criticName: 'Unknown', url: 'https://tm.com/a', textLen: 3000, flags: [] }],
    ['d.json', { outlet: 'Edge', outletId: 'other-id', criticName: 'Z', url: 'https://edge.com/a?utm=1', textLen: 4000, flags: [] }],
    ['_pending/e.json', { outlet: 'Pending', outletId: 'p', criticName: '', url: '', textLen: 0, flags: [] }],
  ]);
  const why = Object.fromEntries(chk.explainGaps(c.missing, snap).map(g => [g.outlet, g.reason]));
  assert.match(why.outinjersey, /another production/);
  assert.equal(why.timeout, 'not found yet');
  assert.match(why.bachtrack, /blocked/);
  assert.match(why.theatremonkey, /critic not named/);
  assert.equal(why['1883magazine'], 'not found yet');
  assert.match(why.edge, /different name/);
});

test('explainGaps: a census-missing review owned by another show is "filed under another show"', () => {
  const missing = [{ outletId: 'nytimes', outlet: 'nytimes', url: 'https://www.nytimes.com/2026/10/21/theater/a-b-review.html?smid=x' },
    { outletId: 'timeout', outlet: 'timeout', url: 'https://timeout.com/a' }];
  const owners = { 'nytimes.com/2026/10/21/theater/a-b-review.html': 'other-show-2026' };
  const ownerOf = u => owners[String(u).replace(/^https?:\/\/(www\.)?/, '').replace(/[?#].*$/, '')] || null;
  const why = Object.fromEntries(chk.explainGaps(missing, new Map(), new Set(), ownerOf).map(g => [g.outlet, g.reason]));
  assert.equal(why.nytimes, 'filed under another show (one article reviewing both)');
  assert.equal(why.timeout, 'not found yet', 'unowned stays "not found yet"');
  const noLookup = Object.fromEntries(chk.explainGaps(missing, new Map()).map(g => [g.outlet, g.reason]));
  assert.equal(noLookup.nytimes, 'not found yet', 'no lookup supplied: old wording');
  // and it flows through buildVerification into the draft's record
  const same = new Map();
  const v = chk.buildVerification({ draft: baseDraft(), nowIso: 'T', mode: 'apply', snapshotBefore: same, snapshotAfter: same, census: { verdict: 'incomplete', missing }, ownerOf });
  assert.equal(v.gaps.find(g => g.outlet === 'nytimes').reason, 'filed under another show (one article reviewing both)');
});

// ── guard ────────────────────────────────────────────────────────────────────

test('guardChangedPaths: only the checked shows and their _pending folders', () => {
  const ok = chk.guardChangedPaths(['a-2026', 'b-2026'], [' M a-2026/x.json', '?? b-2026/y.json', 'D  _pending/a-2026/z.json', 'R  a-2026/old.json -> a-2026/new.json']);
  assert.equal(ok.ok, true);
  const bad = chk.guardChangedPaths(['a-2026'], [' M a-2026/x.json', ' M other-show/x.json', 'R  a-2026/o.json -> elsewhere/n.json', ' M a-2026-copy/x.json']);
  assert.deepEqual(bad.violations, ['other-show/x.json', 'a-2026/o.json -> elsewhere/n.json', 'a-2026-copy/x.json']);
  assert.equal(chk.guardChangedPaths('solo', []).ok, true);
});

// ── the record and the email text ────────────────────────────────────────────

const snapOf = obj => new Map(Object.entries(obj).map(([k, v]) => [k, { outlet: 'O', outletId: 'o', criticName: 'N', publishDate: '2026-10-20', dateSource: '', url: 'u', contentTier: '', textLen: 900, flags: [], ...v }]));

test('buildVerification statuses and pendingScoring', () => {
  const draft = baseDraft();
  const same = snapOf({ 'a.json': {} });
  const mk = (over) => chk.buildVerification({ draft, nowIso: '2026-10-22T06:00:00Z', mode: 'apply', snapshotBefore: same, snapshotAfter: same, census: { verdict: 'complete', missing: [] }, ...over });
  assert.equal(mk({}).status, 'clean');
  assert.equal(mk({}).pendingScoring, false);
  const withNew = snapOf({ 'a.json': {}, 'b.json': { outlet: 'Guardian' } });
  const fixed = mk({ snapshotAfter: withNew });
  assert.deepEqual([fixed.status, fixed.pendingScoring, fixed.added], ['fixed', true, [{ outlet: 'Guardian' }]]);
  assert.deepEqual([fixed.unnamedLeft, fixed.undatedLeft], [0, 0]);
  // excluded files never count toward "still on file"
  const withExcluded = mk({ snapshotBefore: snapOf({ 'a.json': {} }), snapshotAfter: snapOf({ 'a.json': {}, 'x.json': { criticName: 'Unknown', publishDate: '', flags: ['wrongShow'] } }) });
  assert.deepEqual([withExcluded.unnamedLeft, withExcluded.undatedLeft], [0, 0]);
  const leftovers = mk({ snapshotBefore: snapOf({ 'a.json': { criticName: 'Unknown', publishDate: '' } }), snapshotAfter: snapOf({ 'a.json': { criticName: 'Unknown', publishDate: '' }, 'b.json': {} }) });
  assert.deepEqual([leftovers.unnamedLeft, leftovers.undatedLeft], [1, 1]);
  const named = mk({ snapshotBefore: snapOf({ 'a.json': { criticName: 'Unknown' } }), snapshotAfter: snapOf({ 'a.json': { criticName: 'Jane Roe' } }) });
  assert.deepEqual([named.status, named.pendingScoring], ['fixed', false], 'a name fix does not move counts');
  const gaps = mk({ census: { verdict: 'incomplete', missing: [{ outlet: 'Time Out', outletId: 'timeout', url: 'https://t.com/a' }] } });
  assert.equal(gaps.status, 'gaps');
  assert.equal(gaps.gaps[0].reason, 'not found yet');
  const failed = mk({ error: 'every recovery tool failed or timed out' });
  assert.deepEqual([failed.status, failed.pendingScoring], ['failed', false]);
  assert.equal(mk({ mode: 'report-only', snapshotAfter: withNew }).status, 'skipped');
  assert.equal(mk({ mode: 'report-only', snapshotAfter: withNew }).pendingScoring, false);
});

test('describeVerification: plain lines, list cap, banner on failure, nothing when unchecked', () => {
  assert.equal(chk.describeVerification(null), null);
  assert.equal(chk.describeVerification({ status: 'skipped' }), null);
  assert.match(chk.describeVerification({ status: 'failed' }).banner, /did not finish/);
  const clean = chk.describeVerification({ status: 'clean', filesChecked: 14 });
  assert.match(clean.lines[0], /Checked 14 reviews/);
  assert.ok(!/names or dates/.test(clean.lines.join(' ')), 'clean never claims names and dates are all fine');
  const left = chk.describeVerification({ status: 'clean', filesChecked: 14, unnamedLeft: 3, undatedLeft: 1 });
  assert.match(left.lines.join(' '), /Still on file: 3 without a critic name, 1 without a date\./);
  const fixed = chk.describeVerification({
    status: 'gaps', pendingScoring: true,
    added: [1, 2, 3, 4, 5, 6, 7].map(i => ({ outlet: `O${i}` })), named: [{ outlet: 'Time Out', name: 'Adam Feldman' }], dated: [{ outlet: 'x' }, { outlet: 'y' }],
    recovered: [{ outlet: 'Bachtrack' }], flagCleared: [{ outlet: 'Air Mail' }], gaps: [{ outlet: 'Edge', reason: 'not found yet' }],
  });
  const text = fixed.lines.join('\n');
  assert.match(text, /Added 7 missing reviews: O1, O2, O3, O4, O5, and 2 more\./);
  assert.match(text, /Named 1 critic: Adam Feldman \(Time Out\)\./);
  assert.match(text, /Filled in 2 missing dates\./);
  assert.match(text, /Recovered the full text for Bachtrack/);
  assert.match(text, /being scored now/);
  assert.match(text, /Still not counted: Edge \(not found yet\)\./);
  assert.ok(!/[—–]/.test(text), 'no dashes in owner-facing text');
});

// ── the runner, with fake tools ──────────────────────────────────────────────

function fakeDeps({ before, after, runTool, guard = () => ({ ok: true, violations: [] }), audit = null }) {
  let snaps = 0;
  const reverted = [];
  return {
    allowedShows: [],
    snapshot: () => (snaps++ === 0 ? before : after),
    runTool: runTool || (() => ({ ok: true, secs: 1 })),
    readAudit: () => audit,
    guard,
    revert: p => reverted.push(...p),
    reverted,
  };
}
const auditFor = (id, verdict, missing = []) => ({ results: [{ showId: id, censusVerdict: { verdict, missing } }] });

test('runShowCheck: tools run in order, a clean show is clean, a fixed show reports changed', async () => {
  const draft = baseDraft();
  const ran = [];
  const same = snapOf({ 'a.json': {} });
  const clean = await runShowCheck({ draft, mode: 'apply', nowIso: 'T', deps: fakeDeps({ before: same, after: same, audit: auditFor(draft.showId, 'complete'), runTool: t => { ran.push(t.name); return { ok: true, secs: 1 }; } }) });
  assert.deepEqual(ran, ['replay-pending-bylines', 'gap-ingest', 'unknown-critics', 'missing-dates']);
  assert.deepEqual([clean.verification.status, clean.changed], ['clean', false]);
  const fixed = await runShowCheck({ draft, mode: 'apply', nowIso: 'T', deps: fakeDeps({ before: same, after: snapOf({ 'a.json': {}, 'b.json': { outlet: 'Guardian' } }), audit: auditFor(draft.showId, 'complete') }) });
  assert.deepEqual([fixed.verification.status, fixed.changed, fixed.verification.pendingScoring], ['fixed', true, true]);
  assert.equal(fixed.verification.tools.length, 4);
});

test('runShowCheck: one failing tool is recorded, all failing is a failed check', async () => {
  const draft = baseDraft();
  const same = snapOf({ 'a.json': {} });
  const partial = await runShowCheck({ draft, mode: 'apply', nowIso: 'T', deps: fakeDeps({ before: same, after: same, audit: auditFor(draft.showId, 'complete'), runTool: t => ({ ok: t.name !== 'gap-ingest', secs: 1 }) }) });
  assert.equal(partial.verification.status, 'clean');
  assert.deepEqual(partial.verification.tools.map(t => t.ok), [true, false, true, true]);
  const allFail = await runShowCheck({ draft, mode: 'apply', nowIso: 'T', deps: fakeDeps({ before: same, after: same, runTool: () => ({ ok: false, secs: 1 }) }) });
  assert.equal(allFail.verification.status, 'failed');
  assert.match(allFail.verification.error, /every recovery tool/);
  assert.equal(allFail.changed, false);
  const boom = await runShowCheck({ draft, mode: 'apply', nowIso: 'T', deps: fakeDeps({ before: same, after: same, runTool: () => { throw new Error('spawn exploded'); } }) });
  assert.deepEqual([boom.verification.status, boom.verification.error], ['failed', 'spawn exploded']);
});

test('runShowCheck: a tool that writes outside the show is reverted and the check fails', async () => {
  const draft = baseDraft();
  const same = snapOf({ 'a.json': {} });
  const deps = fakeDeps({ before: same, after: same, guard: () => ({ ok: false, violations: ['other-show/x.json'] }) });
  const r = await runShowCheck({ draft, mode: 'apply', nowIso: 'T', deps });
  assert.equal(r.verification.status, 'failed');
  assert.match(r.verification.error, /outside this show's folder/);
  assert.deepEqual(deps.reverted, ['other-show/x.json']);
  assert.equal(r.changed, false);
});

test('runShowCheck: report-only runs the census only and never claims a change', async () => {
  const draft = baseDraft();
  const ran = [];
  const r = await runShowCheck({ draft, mode: 'report-only', nowIso: 'T', deps: fakeDeps({ before: snapOf({}), after: snapOf({ 'b.json': {} }), runTool: t => { ran.push(t.name); return { ok: true, secs: 1 }; } }) });
  assert.deepEqual(ran, ['census']);
  assert.deepEqual([r.verification.status, r.changed], ['skipped', false]);
  assert.ok(TOOLS.apply.every(t => t.argv('x-2026').some(a => a === '--show=x-2026')), 'every apply tool is scoped to the show');
  assert.ok(!TOOLS['report-only'][0].argv('x').includes('--ingest-missing'), 'report-only never ingests');
});

// ── integration with the update flow and the email ───────────────────────────

test('carryOverState keeps the verification across a redraft', () => {
  const prev = baseDraft({ emailedAt: hoursAgo(3), verification: { status: 'fixed', pendingScoring: true } });
  const entry = opening.carryOverState(prev, { showId: prev.showId, score: 75, reviewCount: 15 }, 'T');
  assert.deepEqual(entry.verification, { status: 'fixed', pendingScoring: true });
});

test('any review-count change triggers the update, pending scoring or not (BRO-6634)', () => {
  const emailed = { emailedAt: hoursAgo(30), emailedScore: 74, emailedReviewCount: 14 };
  const plain = baseDraft({ ...emailed, reviewCount: 15 });
  assert.equal(opening.numbersMoved(plain), true, '+1 review is a change');
  const pending = baseDraft({ ...emailed, reviewCount: 15, verification: { status: 'fixed', pendingScoring: true } });
  assert.equal(opening.numbersMoved(pending), true);
  assert.deepEqual(mail.dueEmails({ drafts: { x: pending } }, NOW).map(x => x.kind), ['update']);
  const settled = baseDraft({ ...emailed, reviewCount: 15, verification: { status: 'fixed', pendingScoring: false } });
  assert.equal(opening.numbersMoved(settled), true);
});

test('an update email ends the pending-scoring watch; a first email does not', () => {
  const d = baseDraft({ verification: { status: 'fixed', pendingScoring: true, added: [{ outlet: 'Guardian' }] } });
  const afterNew = mail.afterSend(d, mail.stampsFor('new', d, 'T'));
  assert.equal(afterNew.verification.pendingScoring, true, 'the first email still has numbers that will move');
  const afterUpdate = mail.afterSend(d, mail.stampsFor('update', d, 'T'));
  assert.equal(afterUpdate.verification.pendingScoring, false);
  assert.deepEqual(afterUpdate.verification.added, [{ outlet: 'Guardian' }], 'the rest of the record is kept');
  assert.equal(mail.afterSend(baseDraft(), mail.stampsFor('update', baseDraft(), 'T')).verification, undefined);
});

test('the email shows what the check did, and a banner when it failed', () => {
  const v = { status: 'gaps', filesChecked: 14, pendingScoring: true, added: [{ outlet: 'Guardian' }], gaps: [{ outlet: 'Time Out', reason: 'not found yet' }] };
  const html = mail.buildHtml(baseDraft({ verification: v }), 'new');
  assert.match(html, /Reviews checked:/);
  assert.match(html, /Added 1 missing review: Guardian\./);
  assert.match(html, /Still not counted: Time Out \(not found yet\)\./);
  assert.ok(!html.includes('Heads up.'));
  const failed = mail.buildHtml(baseDraft({ verification: { status: 'failed', error: 'x' } }), 'new');
  assert.match(failed, /Heads up\./);
  assert.match(failed, /review check did not finish/);
  const none = mail.buildHtml(baseDraft(), 'new');
  assert.ok(!none.includes('Reviews checked:') && !none.includes('Heads up.'), 'older drafts render exactly as before');
});

// ── the real spawn / git paths, against a throwaway repo and stub tools ──────

test('real deps: stub tools run in a git repo; an in-show write is kept, a stray write is reverted (BRO-5887)', async () => {
  const { spawnSync } = require('node:child_process');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rrc-root-'));
  const rt = path.join(root, 'review-texts');
  const id = 'x-off-broadway-2026';
  fs.mkdirSync(path.join(rt, id), { recursive: true });
  fs.mkdirSync(path.join(rt, 'other-show'), { recursive: true });
  fs.writeFileSync(path.join(rt, id, 'keep.json'), JSON.stringify(rec()));
  fs.writeFileSync(path.join(rt, 'other-show', 'theirs.json'), JSON.stringify(rec({ outlet: 'Theirs' })));
  const git = (...a) => spawnSync('git', ['-C', rt, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { encoding: 'utf8' });
  git('init', '-q'); git('add', '-A'); git('commit', '-q', '-m', 'base');
  // Stub tools: every tool is the same script; STUB_MODE picks the behavior.
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  const stub = `
    const fs = require('fs'), path = require('path');
    const rt = process.env.STUB_RT, id = process.env.STUB_SHOW, mode = process.env.STUB_MODE;
    if (process.argv[1].includes('audit-show-review-gap')) {
      fs.writeFileSync(process.env.STUB_AUDIT, JSON.stringify({ results: [{ showId: id, censusVerdict: { verdict: 'complete', missing: [] } }] }));
      if (mode === 'ingest') fs.writeFileSync(path.join(rt, id, 'guardian--jane-roe.json'), JSON.stringify({ outlet: 'Guardian', outletId: 'guardian', criticName: 'Jane Roe', url: 'https://g.com/a', fullText: 'x'.repeat(900), publishDate: '2026-10-21' }));
      if (mode === 'stray') fs.writeFileSync(path.join(rt, 'other-show', 'theirs.json'), '{"tampered":true}');
    }
    if (mode === 'stray' && process.argv[1].includes('replay-pending')) fs.writeFileSync(path.join(rt, 'brand-new-show.json'), '{}');
  `;
  for (const t of TOOLS.apply) fs.writeFileSync(path.join(root, t.argv('x')[0]), stub);
  const auditPath = path.join(root, 'audit.json');
  const run = async mode => {
    process.env.STUB_RT = rt; process.env.STUB_SHOW = id; process.env.STUB_MODE = mode; process.env.STUB_AUDIT = auditPath;
    return await runShowCheck({ draft: baseDraft({ showId: id }), mode: 'apply', nowIso: 'T', deps: require('./reddit-review-check-runner.js').realDeps({ root, reviewTexts: rt, auditPath, quiet: true }) });
  };
  const ok = await run('ingest');
  assert.equal(ok.verification.status, 'fixed');
  assert.equal(ok.changed, true);
  assert.deepEqual(ok.verification.added, [{ outlet: 'Guardian' }]);
  assert.deepEqual(ok.verification.tools.map(t => t.ok), [true, true, true, true]);
  assert.ok(fs.existsSync(path.join(rt, id, 'guardian--jane-roe.json')), 'a legitimate in-show write stays');
  // a second show's run: the first show's uncommitted file must not trip the guard
  git('add', '-A'); git('commit', '-q', '-m', 'push');
  const bad = await run('stray');
  assert.equal(bad.verification.status, 'failed');
  assert.match(bad.verification.error, /outside this show's folder/);
  assert.equal(bad.changed, false);
  assert.equal(fs.readFileSync(path.join(rt, 'other-show', 'theirs.json'), 'utf8'), JSON.stringify(rec({ outlet: 'Theirs' })), 'the stray edit is reverted');
  assert.equal(fs.existsSync(path.join(rt, 'brand-new-show.json')), false, 'the stray new file is removed');
  assert.equal(git('status', '--porcelain').stdout.trim(), '', 'tree is clean afterwards');
  // a tool that is missing fails cleanly, never throws
  fs.rmSync(path.join(root, 'scripts'), { recursive: true });
  const missing = await run('none');
  assert.equal(missing.verification.status, 'failed');
});

// ── the reader end to end: fake model, real field-edit writes ────────────────

test('makeJudge: valid decisions are written through review-field-edit, invalid ones are refused, dry-run writes nothing', async () => {
  const { makeJudge } = require('./reddit-review-check-runner.js');
  const id = 'midnight-off-broadway-2026';
  const show = { id, title: 'Midnight', venue: 'Daryl Roth Theatre', openingDate: '2026-10-15', previewsStartDate: '2026-10-01', cast: [{ name: 'Todrick Hall' }], creativeTeam: [], priorRuns: [] };
  const body = 'The review goes on about the evening. '.repeat(20);
  const file = (over) => ({
    showId: id, outletId: 'outinjersey', outlet: 'Out in Jersey', url: 'https://oij.net/a', criticName: 'Unknown', fullText: `${body}`, contentTier: 'complete', source: 'ingest-urls', ...over,
  });
  const mkDir = () => makeReviewTexts({
    [`${id}/held.json`]: file({ wrongProduction: true, publishDate: '2026-10-16', fullText: `Out in Jersey review. Todrick Hall is spectacular at the Daryl Roth Theatre, in Midnight. ${body}`, criticName: 'Allen Neuner' }),
    [`${id}/nocritic.json`]: file({ outletId: 'edge', outlet: 'Edge', url: 'https://edge.com/a', publishDate: '2026-10-17', fullText: `Edge Midnight review. By Kyle Torrence Todrick Hall stars. ${body}` }),
    [`${id}/nodate.json`]: file({ outletId: 'timeout', outlet: 'Time Out', url: 'https://to.com/a', criticName: 'Adam Feldman', fullText: `Time Out 18 October 2026 Midnight review. ${body}` }),
    [`${id}/bad.json`]: file({ outletId: 'bad', outlet: 'Bad Outlet', url: 'https://bad.com/a', publishDate: '2026-10-16', fullText: `Bad Outlet review. By Real Person. ${body}` }),
  });
  const reply = JSON.stringify({ decisions: [
    { id: 'held.json', production: { verdict: 'this-production', quote: 'spectacular at the Daryl Roth Theatre, in Midnight' }, critic: null, date: null },
    { id: 'nocritic.json', production: null, critic: { name: 'Kyle Torrence', quote: 'By Kyle Torrence' }, date: null },
    { id: 'nodate.json', production: null, critic: null, date: { value: '2026-10-18', quote: '18 October 2026 Midnight review' } },
    { id: 'bad.json', production: null, critic: { name: 'Made Up', quote: 'By Made Up' }, date: null },
  ] });
  const census = { verdict: 'incomplete', missing: [{ outletId: 'outinjersey', outlet: 'outinjersey', url: 'https://oij.net/a' }] };
  const read = (dir, f) => JSON.parse(fs.readFileSync(path.join(dir, id, f), 'utf8'));
  const run = async (dir, dryRun, callModel) => {
    const judge = makeJudge({ reviewTexts: dir, loadShow: () => show, callModel, todayIso: '2026-10-22' });
    return judge({ showId: id, census, snapshot: chk.snapshotShow(dir, id), dryRun });
  };

  const dry = mkDir();
  const d = await run(dry, true, async () => reply);
  assert.equal(d.asked, 4);
  assert.deepEqual(d.applied.map(a => a.id).sort(), ['held.json', 'nocritic.json', 'nodate.json']);
  assert.ok(d.applied.every(a => a.dryRun));
  assert.equal(read(dry, 'held.json').wrongProduction, true, 'dry run writes nothing');
  assert.equal(read(dry, 'nocritic.json').criticName, 'Unknown');

  const dir = mkDir();
  const r = await run(dir, false, async () => reply);
  assert.deepEqual(r.applied.map(a => a.id).sort(), ['held.json', 'nocritic.json', 'nodate.json']);
  assert.deepEqual(r.rejected.map(x => `${x.id}:${x.check}`), ['bad.json:critic']);
  const held = read(dir, 'held.json');
  assert.equal(held.wrongProduction, false);
  assert.equal(held.wrongProductionManualClear, true);
  assert.equal(read(dir, 'nocritic.json').criticName, 'Kyle Torrence');
  const dated = read(dir, 'nodate.json');
  assert.deepEqual([dated.publishDate, dated.dateSource], ['2026-10-18', 'text-regex']);
  assert.equal(read(dir, 'bad.json').criticName, 'Unknown', 'the made-up byline never reached disk');
  assert.ok(read(dir, 'held.json').approvedFixes.some(f => f.fixId === 'reddit-review-check'), 'edits carry their provenance');
  assert.match(r.applied.find(a => a.id === 'nocritic.json').changes, /criticName: "Unknown" -> "Kyle Torrence"/, 'the log says exactly what changed');
  // the snapshot diff sees exactly these changes
  const before = chk.snapshotShow(mkDir(), id);
  const s = chk.summarizeChanges(before, chk.snapshotShow(dir, id));
  assert.deepEqual([s.named.length, s.dated.length, s.flagCleared.length, s.needsScoring], [1, 1, 1, true]);

  // a model failure and an unusable reply are reported, never thrown
  const boom = await run(mkDir(), false, async () => { throw new Error('529 overloaded'); }).catch(e => ({ thrown: e.message }));
  assert.equal(boom.thrown, '529 overloaded', 'the model error surfaces to runShowCheck, which records it');
  const junk = await run(mkDir(), false, async () => 'I cannot do that');
  assert.deepEqual([junk.applied.length, junk.error], [0, 'no JSON in the reply']);
  assert.deepEqual((await makeJudge({ reviewTexts: dir, loadShow: () => null, callModel: async () => '' })({ showId: id, census, snapshot: new Map() })).error, `show ${id} not in shows.json`);
});

test('runShowCheck records a judge crash as a failed judge tool but keeps the check, and the status reflects the judge\'s edits', async () => {
  const draft = baseDraft();
  const same = snapOf({ 'a.json': {} });
  const crashed = await runShowCheck({ draft, mode: 'apply', nowIso: 'T', deps: { ...fakeDeps({ before: same, after: same, audit: auditFor(draft.showId, 'complete') }), judge: async () => { throw new Error('boom'); } } });
  assert.equal(crashed.verification.status, 'clean');
  assert.deepEqual(crashed.verification.tools.map(t => `${t.name}:${t.ok}`).slice(-1), ['judge:false']);
  assert.equal(crashed.verification.judge.error, 'boom');
  const named = await runShowCheck({ draft, mode: 'apply', nowIso: 'T', deps: { ...fakeDeps({ before: snapOf({ 'a.json': { criticName: 'Unknown' } }), after: snapOf({ 'a.json': { criticName: 'Jane Roe' } }), audit: auditFor(draft.showId, 'complete') }), judge: async () => ({ asked: 1, applied: [{ id: 'a.json', checks: ['critic'] }], rejected: [] }) } });
  assert.deepEqual([named.verification.status, named.verification.named, named.verification.judge], ['fixed', [{ outlet: 'O', name: 'Jane Roe' }], { asked: 1, applied: 1, rejected: 0 }]);
  // a census gap that the reader just released is no longer a gap
  const flagged = snapOf({ 'a.json': { outletId: 'airmail', outlet: 'Air Mail', url: 'https://am.com/a', flags: ['wrongProduction'] } });
  const cleared = snapOf({ 'a.json': { outletId: 'airmail', outlet: 'Air Mail', url: 'https://am.com/a', flags: [] } });
  const gapAudit = auditFor(draft.showId, 'incomplete', [{ outletId: 'airmail', outlet: 'airmail', url: 'https://am.com/a' }]);
  const stillHeld = await runShowCheck({ draft, mode: 'apply', nowIso: 'T', deps: fakeDeps({ before: flagged, after: flagged, audit: gapAudit }) });
  assert.match(stillHeld.verification.gaps[0].reason, /another production/);
  const released = await runShowCheck({ draft, mode: 'apply', nowIso: 'T', deps: { ...fakeDeps({ before: flagged, after: cleared, audit: gapAudit }), judge: async () => ({ asked: 1, applied: [{ id: 'a.json', checks: ['held'] }], rejected: [] }) } });
  assert.deepEqual([released.verification.status, released.verification.gaps, released.verification.pendingScoring], ['fixed', [], true]);
});

// ── regressions found by the ship-check review (BRO-5887) ────────────────────

test('a second check before the update keeps the watch: pendingScoring survives and the update still goes out', () => {
  const emailed = { emailedAt: hoursAgo(30), emailedScore: 74, emailedReviewCount: 14 };
  const same = snapOf({ 'a.json': {} });
  const first = chk.buildVerification({ draft: baseDraft(), nowIso: 'T', mode: 'apply', snapshotBefore: same, snapshotAfter: snapOf({ 'a.json': {}, 'b.json': { outlet: 'Guardian' } }), census: { verdict: 'complete', missing: [] } });
  assert.deepEqual([first.pendingScoring, first.addedThisCheck], [true, true]);
  // the added review lands (+1): the draft is due an update, so it is checked again; the check finds nothing new
  const landed = baseDraft({ ...emailed, reviewCount: 15, verification: first });
  const second = chk.buildVerification({ draft: landed, nowIso: 'T2', mode: 'apply', snapshotBefore: same, snapshotAfter: same, census: { verdict: 'complete', missing: [] }, previous: landed.verification });
  assert.deepEqual([second.pendingScoring, second.addedThisCheck], [true, false], 'carried from the first check, nothing new this time');
  const rechecked = { ...landed, verification: second };
  assert.deepEqual(mail.dueEmails({ drafts: { x: rechecked } }, NOW).map(e => e.kind), ['update'], 'the corrected draft is still sent');
  // a failed check does not forget it either
  const failed = chk.buildVerification({ draft: landed, nowIso: 'T3', mode: 'apply', snapshotBefore: same, snapshotAfter: same, census: null, error: 'boom', previous: first });
  assert.equal(failed.pendingScoring, true);
  // and once the update is sent with nothing new added, the watch ends
  assert.equal(mail.afterSend(rechecked, mail.stampsFor('update', rechecked, 'T')).verification.pendingScoring, false);
});

test('an update email keeps the watch when the check just before it added reviews that are not live yet', () => {
  const d = baseDraft({ verification: { status: 'fixed', pendingScoring: true, addedThisCheck: true, added: [{ outlet: 'Time Out' }] } });
  const after = mail.afterSend(d, mail.stampsFor('update', d, 'T'));
  assert.equal(after.verification.pendingScoring, true);
  assert.equal(mail.afterSend(d, mail.stampsFor('reminder', d, 'T')).verification.pendingScoring, true, 'a reminder never ends it');
});

test('summarizeChanges counts an outlet-named critic given a real name and new _pending files; the runner pushes whatever is dirty', async () => {
  const before = snapOf({ 'a.json': { outlet: 'Edge', criticName: 'Edge' } });
  const after = snapOf({ 'a.json': { outlet: 'Edge', criticName: 'Jane Roe' }, '_pending/p.json': {} });
  const s = chk.summarizeChanges(before, after);
  assert.deepEqual(s.named.map(x => `${x.from}->${x.to}`), ['Edge->Jane Roe']);
  assert.equal(s.pendingAdded, 1);
  assert.equal(chk.summarizeChanges(snapOf({}), snapOf({ '_pending/p.json': {} })).changed, true, 'a new _pending file alone is a change');
  // the runner decides "push" from the working tree, not from the summary
  const draft = baseDraft();
  const same = snapOf({ 'a.json': {} });
  const dirtyOnly = await runShowCheck({ draft, mode: 'apply', nowIso: 'T', deps: { ...fakeDeps({ before: same, after: same, audit: auditFor(draft.showId, 'complete') }), dirty: () => true } });
  assert.equal(dirtyOnly.changed, true, 'unreported metadata edits are still pushed');
  const failedButDirty = await runShowCheck({ draft, mode: 'apply', nowIso: 'T', deps: { ...fakeDeps({ before: same, after: same, runTool: () => ({ ok: false, secs: 1 }) }), dirty: () => true } });
  assert.deepEqual([failedButDirty.verification.status, failedButDirty.changed], ['failed', true], 'a failed check does not strand good writes');
  const clean = await runShowCheck({ draft, mode: 'apply', nowIso: 'T', deps: { ...fakeDeps({ before: same, after: same, audit: auditFor(draft.showId, 'complete') }), dirty: () => false } });
  assert.equal(clean.changed, false);
});

test('markPushFailed: only this run\'s drafts that changed data, and the email stops saying "being scored"', () => {
  const touched = { status: 'fixed', mode: 'apply', checkedAt: hoursAgo(1), added: [{ outlet: 'Guardian' }], named: [], dated: [], recovered: [], flagCleared: [], pendingScoring: true, addedThisCheck: true, score: 74, reviewCount: 14 };
  const file = { drafts: {
    a: baseDraft({ showId: 'a', verification: touched }),
    old: baseDraft({ showId: 'old', verification: { ...touched, checkedAt: hoursAgo(30) } }),
    nothing: baseDraft({ showId: 'nothing', verification: { ...touched, added: [] } }),
    plain: baseDraft({ showId: 'plain' }),
  } };
  assert.deepEqual(chk.markPushFailed(file, NOW), ['a']);
  assert.deepEqual([file.drafts.a.verification.pushFailed, file.drafts.a.verification.pendingScoring], [true, false]);
  const text = chk.describeVerification(file.drafts.a.verification, file.drafts.a, NOW).lines.join(' ');
  assert.match(text, /could not save these fixes/);
  assert.ok(!/being scored/.test(text));
  assert.deepEqual(chk.markPushFailed(file, NOW), [], 'idempotent');
});

test('a note older than 36 hours, or a "being scored" line after the numbers moved, is not repeated', () => {
  const v = { status: 'fixed', checkedAt: hoursAgo(3), score: 74, reviewCount: 14, pendingScoring: true, added: [{ outlet: 'Guardian' }] };
  assert.match(chk.describeVerification(v, baseDraft(), NOW).lines.join(' '), /being scored/);
  const moved = chk.describeVerification(v, baseDraft({ reviewCount: 16 }), NOW).lines.join(' ');
  assert.ok(!/being scored/.test(moved) && /Added 1 missing review/.test(moved), 'the history stays, the stale promise goes');
  assert.equal(chk.describeVerification({ ...v, checkedAt: hoursAgo(40) }, baseDraft(), NOW), null);
});

test('the workflow never lets the check, the push or the rebuild cost the owner the email', () => {
  const yml = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..', '.github', 'workflows', 'reddit-engagement-digest.yml'), 'utf8');
  const job = yml.slice(yml.indexOf('draft-opening-posts:'));
  const step = name => { const i = job.indexOf(`- name: ${name}`); return job.slice(i, job.indexOf('\n      - name:', i + 5)); };
  for (const n of ['Review check before emailing', 'Push review-texts', 'Trigger rebuild after review check']) assert.match(step(n), /continue-on-error: true/, `${n} must not fail the job`);
  assert.match(step('Mark drafts when the review-texts push failed'), /--mark-push-failed/);
  assert.match(step('Mark drafts when the review-texts push failed'), /pushed != 'true'/);
  assert.ok(job.indexOf('Review check before emailing') < job.indexOf('Email new Reddit drafts'), 'the check runs before the email');
  assert.ok(job.indexOf('Push review-texts') < job.indexOf('Trigger rebuild after review check'), 'push before rebuild');
  assert.doesNotMatch(step('Email new Reddit drafts'), /continue-on-error/, 'a failed draft step must still stop the email');
});

test('makeJudge: one atomic write stamped as a script clear; a guard that keeps a field restores the file; one critic name is given once per run', async () => {
  const { makeJudge } = require('./reddit-review-check-runner.js');
  const id = 'midnight-off-broadway-2026';
  const show = { id, title: 'Midnight', venue: 'Daryl Roth Theatre', openingDate: '2026-10-15', previewsStartDate: '2026-10-01', cast: [{ name: 'Todrick Hall' }], creativeTeam: [], priorRuns: [] };
  const body = 'The review goes on about the evening. '.repeat(20);
  const f = over => ({ showId: id, outletId: 'edge', outlet: 'Edge', url: 'https://edge.com/a', criticName: 'Unknown', fullText: body, contentTier: 'complete', source: 'ingest-urls', publishDate: '2026-10-17', ...over });
  const dir = makeReviewTexts({
    [`${id}/held.json`]: f({ outletId: 'outinjersey', outlet: 'Out in Jersey', url: 'https://oij.net/a', wrongProduction: true, criticName: 'Allen Neuner', fullText: `Out in Jersey review. Todrick Hall is spectacular at the Daryl Roth Theatre, in Midnight. ${body}` }),
    [`${id}/one.json`]: f({ url: 'https://edge.com/1', fullText: `Edge. By Kyle Torrence. ${body}` }),
    [`${id}/two.json`]: f({ url: 'https://edge.com/2', fullText: `Edge. By Kyle Torrence. ${body}` }),
  });
  const reply = JSON.stringify({ decisions: [
    { id: 'held.json', production: { verdict: 'this-production', quote: 'spectacular at the Daryl Roth Theatre, in Midnight' } },
    { id: 'one.json', critic: { name: 'Kyle Torrence', quote: 'By Kyle Torrence' } },
    { id: 'two.json', critic: { name: 'Kyle Torrence', quote: 'By Kyle Torrence' } },
  ] });
  const census = { verdict: 'incomplete', missing: [{ outletId: 'outinjersey', outlet: 'outinjersey', url: 'https://oij.net/a' }] };
  const r = await makeJudge({ reviewTexts: dir, loadShow: () => show, callModel: async () => reply, todayIso: '2026-10-22' })({ showId: id, census, snapshot: chk.snapshotShow(dir, id), dryRun: false });
  const read = n => JSON.parse(fs.readFileSync(path.join(dir, id, n), 'utf8'));
  assert.deepEqual(r.applied.map(a => a.id).sort(), ['held.json', 'one.json'], 'the second file cannot take the same critic');
  assert.deepEqual(r.rejected.map(x => `${x.id}:${x.why}`), ['two.json:another file from this outlet already has that critic']);
  const held = read('held.json');
  assert.deepEqual([held.wrongProduction, held.wrongProductionManualClear, held.wrongProductionOverrideSetBy], [false, true, 'reddit-review-check.js'], 'stamped as a machine clear in the same write');
  assert.match(held.wrongProductionClearedNote, /Daryl Roth Theatre/);
  const guards = require('./review-write-guard.js');
  assert.equal(guards.isScriptWrongProductionClear(held), true, 'a later flag plan may overrule it');

  // a write that the guard changes is rolled back to the original bytes
  const { writeRecordAtomically } = require('./reddit-review-check-runner.js');
  const original = fs.readFileSync(path.join(dir, id, 'two.json'), 'utf8');
  const bad = writeRecordAtomically(dir, id, 'two.json', { ...read('two.json'), criticName: 'Written Name' }, [{ field: 'criticName', oldValue: 'Unknown', newValue: 'A Different Name' }]);
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /file restored/);
  assert.equal(fs.readFileSync(path.join(dir, id, 'two.json'), 'utf8'), original, 'byte-for-byte restore');
});

test('review of BRO-5887 ship-check: with no owner list the freshness skip applies (a checked-today draft is not re-run)', () => {
  const mk = (id, over) => baseDraft({ showId: id, ...over });
  const drafts = { drafts: {
    fresh: mk('fresh', { verification: { status: 'clean', checkedAt: hoursAgo(2), score: 74, reviewCount: 14 } }),
    brandNew: mk('brandNew'),
  } };
  assert.deepEqual(chk.selectDueChecks(drafts, NOW, { only: [], max: 9 }).map(x => x.draft.showId), ['brandNew']);
  assert.deepEqual(chk.selectDueChecks(drafts, NOW, { max: 9 }).map(x => x.draft.showId), ['brandNew']);
});
