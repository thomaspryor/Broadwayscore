// LIVE-DATA-LANE: reads data/shows.json (untracked core data). Runs in check-corpus-drift.yml, not test.yml's blocking batch (BRO-7847).
// BRO-7847: the reader-feedback "proposed fix" email. Real functions, real
// data. Each test names the owner-visible failure it prevents.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const P = require('../../scripts/lib/feedback-proposal.js');
const T = require('../../scripts/lib/owner-email-thread.js');
const { verifyDispatchSignature } = require('../../scripts/lib/dispatch-link.js');

const raw = JSON.parse(fs.readFileSync(path.join(root, 'data/shows.json'), 'utf8'));
const shows = raw.shows || raw;

test('"add show X" for a show already in the catalog is caught (#1190, #1124)', () => {
  const a = P.findCatalogMatches('Please add 13 Going on 30 at Toronto, I saw it there', shows);
  assert.ok(a.some((m) => m.id === '13-going-on-30-toronto-regional-2026'), JSON.stringify(a));
  const b = P.findCatalogMatches('You are missing Love, Love, Love from 2016', shows);
  assert.ok(b.some((m) => m.id === 'love-love-love-off-broadway-2016'), JSON.stringify(b));
  assert.deepEqual(P.findCatalogMatches('', shows), []);
});

test('a plan is "already applied" only when every data-edit already holds', () => {
  const s = shows.find((x) => x.status === 'closed' && x.runtime);
  const hit = { actions: [{ type: 'data-edit', showId: s.id, field: 'runtime', newValue: s.runtime }] };
  assert.equal(P.checkPlanAlreadyApplied(hit, shows).fixed, true);
  const miss = { actions: [{ type: 'data-edit', showId: s.id, field: 'runtime', newValue: s.runtime + 1 }] };
  assert.equal(P.checkPlanAlreadyApplied(miss, shows).fixed, false);
  const mixed = { actions: [...hit.actions, ...miss.actions] };
  assert.equal(P.checkPlanAlreadyApplied(mixed, shows).fixed, false);
  assert.equal(P.checkPlanAlreadyApplied({ actions: [{ type: 'run-script', script: 'x' }] }, shows).fixed, false);
});

test('similar-issue scan runs only for fields with a registered check, and says so otherwise', () => {
  const none = P.scanSimilar({ actions: [{ type: 'data-edit', field: 'synopsis', showId: 'x' }] }, shows);
  assert.equal(none.ran, false);
  const cast = P.scanSimilar({ actions: [{ type: 'data-edit', field: 'cast', showId: 'x' }] }, shows);
  assert.equal(cast.ran, true);
  assert.equal(typeof cast.findings[0].count, 'number');
  const email = P.buildProposalEmail({ issueNumber: 1, reader: {}, alreadyFixed: false, plan: { summary: 's' }, scan: none, reply: {} });
  assert.match(email.html, /No automated check covers this kind of issue, so nothing was scanned/);
});

test('cap: one email per issue and at most 10 per UTC day', () => {
  const now = new Date('2026-11-19T12:00:00Z');
  let l = { entries: {} };
  assert.equal(P.decideSend(l, 5, now).send, true);
  P.recordSent(l, 5, { sentAt: now.toISOString(), submittedAt: '2026-11-19T11:50:00Z', kind: 'needs-fix' });
  assert.equal(P.decideSend(l, 5, now).reason, 'already-sent');
  assert.equal(l.entries['5'].minutes, 10);
  for (let i = 100; i < 109; i++) P.recordSent(l, i, { sentAt: now.toISOString(), kind: 'x' });
  assert.equal(P.decideSend(l, 999, now).reason, 'daily-cap-10');
  assert.equal(P.decideSend(l, 999, new Date('2026-11-20T00:01:00Z')).send, true);
});

test('kill switch reads FEEDBACK_PROPOSAL_DISABLED', () => {
  assert.equal(P.proposalsDisabled({ FEEDBACK_PROPOSAL_DISABLED: 'true' }), true);
  assert.equal(P.proposalsDisabled({}), false);
});

test('ledger round-trips on disk', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'prop-')), 'l.json');
  const l = P.loadLedger(f);
  P.recordSent(l, 7, { sentAt: '2026-11-19T00:00:00Z', kind: 'k' });
  P.saveLedger(l, f);
  assert.equal(P.loadLedger(f).entries['7'].kind, 'k');
});

test('root-cause button is a signed dispatch link with no reader details', () => {
  const secret = 'test-secret';
  const url = P.buildRootCauseUrl({ issueNumber: 42, rootCause: { summary: 'Router parks asks it already fixed', approach: 'Close and comment' }, secret });
  const u = new URL(url);
  assert.equal(u.pathname, '/api/autonomous-action');
  assert.equal(u.searchParams.get('action'), 'dispatch');
  assert.ok(verifyDispatchSignature({
    conditionKey: u.searchParams.get('conditionKey'), title: u.searchParams.get('title'),
    description: u.searchParams.get('description') || '', exp: u.searchParams.get('exp'), secret, sig: u.searchParams.get('sig'),
  }));
  assert.equal(P.buildRootCauseUrl({ issueNumber: 42, rootCause: null, secret }), null);
});

test('email has the four sections, the reply is a draft for the owner, and no em dashes', () => {
  const reply = P.buildReaderReplyDraft({ reader: { name: 'Sam', email: 'sam@example.com', show: 'Wanted' }, show: 'Wanted', url: 'https://broadwayscorecard.com/show/wanted' });
  const { html, text } = P.buildProposalEmail({
    issueNumber: 9, reader: { name: 'Sam', email: 'sam@example.com', show: 'Wanted', message: 'The cast is wrong' },
    alreadyFixed: false, plan: { summary: 'Fix the cast', steps: ['a', 'b'], riskLevel: 'Low' },
    approveUrl: 'https://x/approve', rejectUrl: 'https://x/reject',
    rootCause: { summary: 'Retry tombstoned casts', approach: 'Add retry' }, rootCauseUrl: 'https://x/root',
    scan: { ran: true, findings: [{ label: 'shows with no cast', count: 2, sample: ['A', 'B'] }] }, reply,
  });
  for (const n of ['1. Fix for this issue', '2. Root-cause fix', '3. Similar issues', '4. Reply to the reader']) assert.ok(html.includes(n), n);
  assert.match(html, /Approve fix/);
  assert.match(html, /Approve root-cause fix/);
  assert.match(html, /mailto:sam@example\.com/);
  assert.ok(!/—/.test(html + text), 'no em dashes');
});

test('already-fixed variant offers no Approve fix button but keeps root cause and reply', () => {
  const { html } = P.buildProposalEmail({
    issueNumber: 3, reader: { name: 'Pat', message: 'add it' }, alreadyFixed: true,
    fixedEvidence: ['exists'], catalogMatches: [{ id: 'a', title: 'A', status: 'open', url: 'https://x/a' }],
    rootCause: { summary: 'Router parked it', approach: 'close it' }, rootCauseUrl: 'https://x/r',
    scan: { ran: false, findings: [] }, reply: { text: 'hi' },
  });
  assert.ok(!/Approve fix/.test(html));
  assert.match(html, /already fixed/i);
  assert.match(html, /Approve root-cause fix/);
});

test('thread helper: owner only, stable subject, replies reference the root', async () => {
  assert.equal(T.threadMessageId('12'), '<bsc-feedback-12@broadwayscorecard.com>');
  assert.equal(T.threadMessageId('12-systematic'), T.threadMessageId(12));
  assert.deepEqual(T.threadHeaders(12, { root: true }), { 'Message-ID': '<bsc-feedback-12@broadwayscorecard.com>' });
  assert.deepEqual(T.threadHeaders(12), { 'In-Reply-To': '<bsc-feedback-12@broadwayscorecard.com>', References: '<bsc-feedback-12@broadwayscorecard.com>' });
  assert.equal(T.threadSubject({ show: 'Wanted', issueNumber: 12 }), 'Reader feedback: Wanted (#12)');
  const sent = [];
  const env = { OWNER_EMAIL: 'owner@example.com' };
  const r = await T.sendOwnerThreadEmail({ issueNumber: 12, subject: 's', html: 'h', env, transport: async (p) => sent.push(p) });
  assert.equal(r.sent, true);
  assert.deepEqual(sent[0].to, ['owner@example.com']);
  const none = await T.sendOwnerThreadEmail({ issueNumber: 12, subject: 's', html: 'h', env: {}, transport: async (p) => sent.push(p) });
  assert.equal(none.sent, false);
  assert.equal(sent.length, 1);
});

test('the "fix applied" owner email joins the proposal thread only when a proposal was sent', async () => {
  const { sendReaderFixOwnerEmail } = require('../../scripts/lib/owner-email-thread.js') && require('../../scripts/lib/owner-fix-email.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thr-'));
  const dry = path.join(dir, 'out.json');
  const ledgerFile = path.join(dir, 'l.json');
  const saved = { ...process.env };
  Object.assign(process.env, { OWNER_EMAIL: 'owner@example.com', RESEND_API_KEY: 'k', OWNER_EMAIL_DRY_RUN_FILE: dry, FEEDBACK_PROPOSALS_LEDGER: ledgerFile });
  try {
    const l = P.loadLedger(ledgerFile);
    P.recordSent(l, 321, { sentAt: '2026-11-19T00:00:00Z', kind: 'needs-fix' });
    P.saveLedger(l, ledgerFile);
    const ok = await sendReaderFixOwnerEmail({ issueNumber: 321, reader: { show: 'Wanted' }, summary: 's', changes: ['x'] });
    assert.equal(ok, true);
    const out = JSON.parse(fs.readFileSync(dry, 'utf8'));
    assert.equal(out.subject, 'Reader feedback: Wanted (#321)');
    assert.equal(out.headers['In-Reply-To'], '<bsc-feedback-321@broadwayscorecard.com>');
    assert.deepEqual(out.to, ['owner@example.com']);
  } finally {
    for (const k of ['OWNER_EMAIL', 'RESEND_API_KEY', 'OWNER_EMAIL_DRY_RUN_FILE', 'FEEDBACK_PROPOSALS_LEDGER']) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  }
});

test('auto-close needs one clear catalog match and no review/transfer ask (review fix)', () => {
  const one = P.selectAutoCloseMatch('Please add 13 Going on 30 at Toronto, I saw it there', '', shows);
  assert.ok(one.length === 1 && one[0].id === '13-going-on-30-toronto-regional-2026', JSON.stringify(one));
  assert.deepEqual(P.selectAutoCloseMatch('Please add the missing reviews for Love, Love, Love', '', shows), []);
  assert.deepEqual(P.selectAutoCloseMatch('add the West End transfer of Love, Love, Love', '', shows), []);
  assert.deepEqual(P.selectAutoCloseMatch('', '', shows), []);
});

test('auto-close never selects a closed production through any fallback', () => {
  const closed = { id: 'unique-show-boston-2020', title: 'Unique Show', status: 'closed' };
  assert.deepEqual(P.selectAutoCloseMatch('Please add Unique Show', 'Unique Show', [closed]), []);
  assert.deepEqual(P.selectAutoCloseMatch('Please add Unique Show in Boston', '', [closed]), []);
  assert.deepEqual(P.selectAutoCloseMatch('Please add Unique Show', '', [closed]), []);
  const upcoming = { ...closed, status: 'upcoming' };
  assert.equal(P.selectAutoCloseMatch('Please add Unique Show', 'Unique Show', [upcoming]).length, 1);
  const open = { ...closed, id: 'unique-show-new-york-2026', status: 'open' };
  assert.deepEqual(P.selectAutoCloseMatch('Please add Unique Show in Boston', '', [closed, open]), []);
});

test('a plan edit with no newValue is never "already applied"', () => {
  const s = shows.find((x) => x.status === 'closed');
  assert.equal(P.checkPlanAlreadyApplied({ actions: [{ type: 'data-edit', showId: s.id, field: 'definitelyMissingField' }] }, shows).fixed, false);
});
