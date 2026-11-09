// Tests for the superseded-Reddit-draft-email sweep. Subjects below are the real
// ones from the owner's inbox on 2026-11-09, plus the reminder kind.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const a = require('./reddit-email-archive.js');
const mail = require('./reddit-post-email.js');

const FROM = 'Broadway Scorecard <updates@broadwayscorecard.com>';
const msg = (id, subject, at, from = FROM) => ({ id, subject, from, internalDate: String(at) });

test('parseDraftSubject round-trips every subject buildSubject can emit', () => {
  const d = { showTitle: 'Iphigenie en Tauride - English National Opera', score: 73, subreddit: 'TheWestEnd' };
  for (const kind of ['new', 'update', 'reminder']) {
    const p = a.parseDraftSubject(mail.buildSubject(d, kind));
    assert.ok(p, kind);
    assert.equal(p.showTitle, d.showTitle);
    assert.equal(p.score, 73);
    assert.equal(p.subreddit, 'thewestend');
  }
});

test('parseDraftSubject handles titles with colons and parentheses', () => {
  const p = a.parseDraftSubject('Updated Reddit post: 2:22 - A Ghost Story (61/100) for r/offbroadwayNYC');
  assert.equal(p.showTitle, '2:22 - A Ghost Story');
  assert.equal(p.score, 61);
  const q = a.parseDraftSubject('Reddit post ready: Hamilton (Original Cast) (92/100) for r/Broadway');
  assert.equal(q.showTitle, 'Hamilton (Original Cast)');
});

test('parseDraftSubject ignores everything that is not one of the draft emails', () => {
  for (const s of ['1 needs help · 1 broadcast-ready · 1 opening today · Nov 9', 'Re: Updated Reddit post: Nero (40/100) for r/TheWestEnd',
    'Broadway opening-night draft ready in Resend: Wanted', 'Updated Reddit post: Nero for r/TheWestEnd', '']) {
    assert.equal(a.parseDraftSubject(s), null, s);
  }
});

test('planArchive keeps only the newest email per show and subreddit', () => {
  const r = a.planArchive([
    msg('n40', 'Updated Reddit post: Nero (40/100) for r/TheWestEnd', 4000),
    msg('n41', 'Updated Reddit post: Nero (41/100) for r/TheWestEnd', 3000),
    msg('n39', 'Updated Reddit post: Nero (39/100) for r/TheWestEnd', 2000),
    msg('n38', 'Reddit post ready: Nero (38/100) for r/TheWestEnd', 1000),
    msg('mb71', 'Updated Reddit post: Ms. Blakk for President (71/100) for r/offbroadwayNYC', 3500),
    msg('mb68', 'Updated Reddit post: Ms. Blakk for President (68/100) for r/offbroadwayNYC', 500),
  ]);
  assert.deepEqual(new Set(r.keep), new Set(['n40', 'mb71']));
  assert.deepEqual(new Set(r.archive), new Set(['n41', 'n39', 'n38', 'mb68']));
  assert.equal(r.groups, 2);
});

test('the order of the input does not change the result', () => {
  const list = [
    msg('a', 'Reddit post ready: Nero (38/100) for r/TheWestEnd', 1),
    msg('b', 'Updated Reddit post: Nero (39/100) for r/TheWestEnd', 2),
    msg('c', 'Still ready to post: Nero (39/100) for r/TheWestEnd', 3),
  ];
  const fwd = a.planArchive(list);
  const rev = a.planArchive([...list].reverse());
  assert.deepEqual(fwd.keep, ['c']);
  assert.deepEqual(rev.keep, ['c']);
  assert.deepEqual(new Set(fwd.archive), new Set(rev.archive));
});

test('the same show in two subreddits, or two different shows, are separate drafts', () => {
  const r = a.planArchive([
    msg('1', 'Reddit post ready: Nero (40/100) for r/TheWestEnd', 1),
    msg('2', 'Reddit post ready: Nero (40/100) for r/offbroadwayNYC', 2),
    msg('3', 'Reddit post ready: Speculations (47/100) for r/TheWestEnd', 3),
  ]);
  assert.deepEqual(r.archive, []);
  assert.equal(r.groups, 3);
});

test('a lone email is never archived', () => {
  assert.deepEqual(a.planArchive([msg('x', 'Reddit post ready: Wanted (80/100) for r/Broadway', 1)]).archive, []);
});

test('mail from another sender, or with a lookalike subject, is never touched', () => {
  const r = a.planArchive([
    msg('real-new', 'Updated Reddit post: Nero (40/100) for r/TheWestEnd', 5),
    msg('fake-old', 'Updated Reddit post: Nero (39/100) for r/TheWestEnd', 1, 'Someone <someone@example.com>'),
    msg('spoof', 'Updated Reddit post: Nero (38/100) for r/TheWestEnd', 1, 'x <updates@broadwayscorecard.com.evil.io>'),
    msg('reply', 'Re: Updated Reddit post: Nero (37/100) for r/TheWestEnd', 1),
  ]);
  assert.deepEqual(r.archive, []);
});

test('isOurSender accepts bare and display-name forms only', () => {
  assert.ok(a.isOurSender('updates@broadwayscorecard.com'));
  assert.ok(a.isOurSender('"Broadway Scorecard" <updates@broadwayscorecard.com>'));
  assert.ok(!a.isOurSender('updates@broadwayscorecard.com.evil.io'));
  assert.ok(!a.isOurSender('xupdates@broadwayscorecard.com'));
  assert.ok(!a.isOurSender(''));
});

// ---- sweep against a fake Gmail ----

function fakeGmail({ messages, patchStatus = 200, patchBody = {}, scope = 'https://www.googleapis.com/auth/gmail.modify', messagesAt = null }) {
  const calls = [];
  let listCalls = 0;
  const current = () => (messagesAt ? messagesAt(listCalls) : messages);
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    calls.push({ path: u.pathname, method: init.method || 'GET', body: init.body });
    const json = (status, body) => ({ ok: status < 400, status, json: async () => body });
    if (u.hostname === 'oauth2.googleapis.com') return json(200, { access_token: 'tok', scope });
    if (u.pathname.endsWith('/messages/batchModify')) return json(patchStatus, patchBody);
    if (u.pathname.endsWith('/messages')) { listCalls++; return json(200, { messages: current().map((m) => ({ id: m.id })) }); }
    const m = current().find((x) => u.pathname.endsWith(`/messages/${x.id}`));
    return json(200, { id: m.id, internalDate: m.internalDate, payload: { headers: [{ name: 'Subject', value: m.subject }, { name: 'From', value: m.from }] } });
  };
  return { fetchImpl, calls };
}
const ENV = { GMAIL_CLIENT_ID: 'i', GMAIL_CLIENT_SECRET: 's', GMAIL_REFRESH_TOKEN: 'r' };
const INBOX = [
  msg('n40', 'Updated Reddit post: Nero (40/100) for r/TheWestEnd', 4000),
  msg('n41', 'Updated Reddit post: Nero (41/100) for r/TheWestEnd', 3000),
  msg('digest', '1 needs help · 1 broadcast-ready · 1 opening today · Nov 9', 3900),
];

test('sweep archives only the superseded ids, removing only the INBOX label', async () => {
  const { fetchImpl, calls } = fakeGmail({ messages: INBOX });
  const r = await a.sweep({ env: ENV, fetchImpl, log: () => {} });
  assert.equal(r.archived, 1);
  const patch = calls.filter((c) => c.path.endsWith('/batchModify'));
  assert.equal(patch.length, 1);
  assert.deepEqual(JSON.parse(patch[0].body), { ids: ['n41'], removeLabelIds: ['INBOX'] });
});

test('sweep --dry-run changes nothing', async () => {
  const { fetchImpl, calls } = fakeGmail({ messages: INBOX });
  const r = await a.sweep({ env: ENV, fetchImpl, dryRun: true, log: () => {} });
  assert.equal(r.archived, 0);
  assert.equal(r.wouldArchive, 1);
  assert.equal(calls.filter((c) => c.method === 'POST' && c.path.endsWith('/batchModify')).length, 0);
});

test('sweep with nothing superseded makes no write call', async () => {
  const { fetchImpl, calls } = fakeGmail({ messages: [INBOX[0], INBOX[2]] });
  const r = await a.sweep({ env: ENV, fetchImpl, log: () => {} });
  assert.equal(r.archived, 0);
  assert.equal(calls.filter((c) => c.path.endsWith('/batchModify')).length, 0);
});

test('a read-only key is reported as such, not as a generic failure', async () => {
  const { fetchImpl } = fakeGmail({ messages: INBOX, patchStatus: 403, patchBody: { error: { status: 'PERMISSION_DENIED', message: 'Request had insufficient authentication scopes.' } } });
  await assert.rejects(() => a.sweep({ env: ENV, fetchImpl, log: () => {} }), a.GmailScopeError);
});

test('missing credentials fail with a plain message and no network call', async () => {
  const fetchImpl = async () => { throw new Error('should not be called'); };
  await assert.rejects(() => a.sweep({ env: {}, fetchImpl, log: () => {} }), /not set/);
});

test('a refused token refresh surfaces the Google error code only', async () => {
  const fetchImpl = async () => ({ ok: false, status: 400, json: async () => ({ error: 'invalid_grant', error_description: 'secret-ish detail' }) });
  await assert.rejects(() => a.sweep({ env: ENV, fetchImpl, log: () => {} }), (e) => /invalid_grant/.test(e.message) && !/secret-ish/.test(e.message));
});

const READONLY = 'https://www.googleapis.com/auth/gmail.readonly';

test('a read-only key is caught from its granted scope before any write is attempted', async () => {
  const { fetchImpl, calls } = fakeGmail({ messages: INBOX, scope: READONLY });
  await assert.rejects(() => a.sweep({ env: ENV, fetchImpl, log: () => {} }), a.GmailScopeError);
  assert.equal(calls.filter((c) => c.path.endsWith('/batchModify')).length, 0);
});

test('a read-only key can still do a dry run, so the plan can be checked before the renewal', async () => {
  const { fetchImpl } = fakeGmail({ messages: INBOX, scope: READONLY });
  const r = await a.sweep({ env: ENV, fetchImpl, dryRun: true, log: () => {} });
  assert.equal(r.wouldArchive, 1);
});

test('a 403 rate limit is not mistaken for a read-only key', async () => {
  const body = { error: { status: 'PERMISSION_DENIED', message: 'Rate Limit Exceeded', errors: [{ reason: 'userRateLimitExceeded' }] } };
  const { fetchImpl } = fakeGmail({ messages: INBOX, patchStatus: 403, patchBody: body });
  await assert.rejects(() => a.sweep({ env: ENV, fetchImpl, log: () => {} }), (e) => !(e instanceof a.GmailScopeError) && /403/.test(e.message));
});

test('the sweep waits for the just-sent email, then archives its predecessor', async () => {
  const newest = 'Updated Reddit post: Nero (42/100) for r/TheWestEnd';
  const withNew = [...INBOX, msg('n42', newest, 5000)];
  const { fetchImpl, calls } = fakeGmail({ messages: INBOX, messagesAt: (n) => (n >= 3 ? withNew : INBOX) });
  let slept = 0;
  const r = await a.sweep({ env: ENV, fetchImpl, expectSubjects: [newest], sleep: async () => { slept++; }, log: () => {} });
  assert.equal(slept, 2);
  assert.deepEqual(r.missing, []);
  const patch = JSON.parse(calls.find((c) => c.path.endsWith('/batchModify')).body);
  assert.deepEqual(new Set(patch.ids), new Set(['n40', 'n41']));
});

test('if the just-sent email never shows, the sweep gives up waiting without failing or over-archiving', async () => {
  const { fetchImpl, calls } = fakeGmail({ messages: INBOX });
  const logs = [];
  const r = await a.sweep({ env: ENV, fetchImpl, expectSubjects: ['Updated Reddit post: Nero (99/100) for r/TheWestEnd'], waitMs: 30000, sleep: async () => {}, log: (m) => logs.push(m) });
  assert.equal(r.missing.length, 1);
  assert.ok(logs.some((l) => /not in the inbox/.test(l)));
  assert.deepEqual(JSON.parse(calls.find((c) => c.path.endsWith('/batchModify')).body).ids, ['n41']);
});

test('class guard: the archiver reads the sender\'s own subject table, so a new email kind cannot drift out of the sweep', () => {
  assert.deepEqual(a.LEADS, Object.values(mail.SUBJECT_LEADS));
  for (const [kind, lead] of Object.entries(mail.SUBJECT_LEADS)) {
    const subject = mail.buildSubject({ showTitle: 'X', score: 50, subreddit: 'Broadway' }, kind);
    assert.ok(subject.startsWith(`${lead}: `), kind);
    assert.ok(a.parseDraftSubject(subject), `${kind} subject must parse`);
  }
});
