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

function fakeGmail({ messages, patchStatus = 200, patchBody = {}, scope = 'https://www.googleapis.com/auth/gmail.modify', messagesAt = null, pageSize = 0 }) {
  const calls = [];
  let listCalls = 0;
  const current = () => (messagesAt ? messagesAt(listCalls) : messages);
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    calls.push({ path: u.pathname, method: init.method || 'GET', body: init.body });
    const json = (status, body) => ({ ok: status < 400, status, json: async () => body });
    if (u.hostname === 'oauth2.googleapis.com') return json(200, { access_token: 'tok', scope });
    if (u.pathname.endsWith('/messages/batchModify')) return json(patchStatus, patchBody);
    if (u.pathname.endsWith('/messages')) {
      listCalls++;
      const all = current();
      if (!pageSize) return json(200, { messages: all.map((m) => ({ id: m.id })) });
      const from = Number(u.searchParams.get('pageToken') || 0);
      const page = all.slice(from, from + pageSize);
      return json(200, { messages: page.map((m) => ({ id: m.id })), ...(from + pageSize < all.length ? { nextPageToken: String(from + pageSize) } : {}) });
    }
    const m = current().find((x) => u.pathname.endsWith(`/messages/${x.id}`));
    return json(200, { id: m.id, internalDate: m.internalDate, payload: { headers: [{ name: 'Subject', value: m.subject }, { name: 'From', value: m.from }, ...(m.showId ? [{ name: 'X-BSC-Show-Id', value: m.showId }] : [])] } });
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
  const r = await a.sweep({ now: () => 10000, env: ENV, fetchImpl, log: () => {} });
  assert.equal(r.archived, 1);
  const patch = calls.filter((c) => c.path.endsWith('/batchModify'));
  assert.equal(patch.length, 1);
  assert.deepEqual(JSON.parse(patch[0].body), { ids: ['n41'], removeLabelIds: ['INBOX'] });
});

test('sweep --dry-run changes nothing', async () => {
  const { fetchImpl, calls } = fakeGmail({ messages: INBOX });
  const r = await a.sweep({ now: () => 10000, env: ENV, fetchImpl, dryRun: true, log: () => {} });
  assert.equal(r.archived, 0);
  assert.equal(r.wouldArchive, 1);
  assert.equal(calls.filter((c) => c.method === 'POST' && c.path.endsWith('/batchModify')).length, 0);
});

test('sweep with nothing superseded makes no write call', async () => {
  const { fetchImpl, calls } = fakeGmail({ messages: [INBOX[0], INBOX[2]] });
  const r = await a.sweep({ now: () => 10000, env: ENV, fetchImpl, log: () => {} });
  assert.equal(r.archived, 0);
  assert.equal(calls.filter((c) => c.path.endsWith('/batchModify')).length, 0);
});

test('a read-only key is reported as such, not as a generic failure', async () => {
  const { fetchImpl } = fakeGmail({ messages: INBOX, patchStatus: 403, patchBody: { error: { status: 'PERMISSION_DENIED', message: 'Request had insufficient authentication scopes.' } } });
  await assert.rejects(() => a.sweep({ now: () => 10000, env: ENV, fetchImpl, log: () => {} }), a.GmailScopeError);
});

test('missing credentials fail with a plain message and no network call', async () => {
  const fetchImpl = async () => { throw new Error('should not be called'); };
  await assert.rejects(() => a.sweep({ now: () => 10000, env: {}, fetchImpl, log: () => {} }), /not set/);
});

test('a refused token refresh surfaces the Google error code only', async () => {
  const fetchImpl = async () => ({ ok: false, status: 400, json: async () => ({ error: 'invalid_grant', error_description: 'secret-ish detail' }) });
  await assert.rejects(() => a.sweep({ now: () => 10000, env: ENV, fetchImpl, log: () => {} }), (e) => /invalid_grant/.test(e.message) && !/secret-ish/.test(e.message));
});

const READONLY = 'https://www.googleapis.com/auth/gmail.readonly';

test('a read-only key is caught from its granted scope before any write is attempted', async () => {
  const { fetchImpl, calls } = fakeGmail({ messages: INBOX, scope: READONLY });
  await assert.rejects(() => a.sweep({ now: () => 10000, env: ENV, fetchImpl, log: () => {} }), a.GmailScopeError);
  assert.equal(calls.filter((c) => c.path.endsWith('/batchModify')).length, 0);
});

test('a read-only key can still do a dry run, so the plan can be checked before the renewal', async () => {
  const { fetchImpl } = fakeGmail({ messages: INBOX, scope: READONLY });
  const r = await a.sweep({ now: () => 10000, env: ENV, fetchImpl, dryRun: true, log: () => {} });
  assert.equal(r.wouldArchive, 1);
});

test('a 403 rate limit is not mistaken for a read-only key', async () => {
  const body = { error: { status: 'PERMISSION_DENIED', message: 'Rate Limit Exceeded', errors: [{ reason: 'userRateLimitExceeded' }] } };
  const { fetchImpl } = fakeGmail({ messages: INBOX, patchStatus: 403, patchBody: body });
  await assert.rejects(() => a.sweep({ now: () => 10000, env: ENV, fetchImpl, log: () => {} }), (e) => !(e instanceof a.GmailScopeError) && /403/.test(e.message));
});

test('the sweep waits for the just-sent email, then archives its predecessor', async () => {
  const newest = 'Updated Reddit post: Nero (42/100) for r/TheWestEnd';
  const withNew = [...INBOX, msg('n42', newest, 5000)];
  const { fetchImpl, calls } = fakeGmail({ messages: INBOX, messagesAt: (n) => (n >= 3 ? withNew : INBOX) });
  let slept = 0;
  const r = await a.sweep({ now: () => 10000, env: ENV, fetchImpl, expectSubjects: [newest], sleep: async () => { slept++; }, log: () => {} });
  assert.equal(slept, 2);
  assert.deepEqual(r.missing, []);
  const patch = JSON.parse(calls.find((c) => c.path.endsWith('/batchModify')).body);
  assert.deepEqual(new Set(patch.ids), new Set(['n40', 'n41']));
});

test('if the just-sent email never shows, the sweep gives up waiting without failing or over-archiving', async () => {
  const { fetchImpl, calls } = fakeGmail({ messages: INBOX });
  const logs = [];
  const r = await a.sweep({ now: () => 10000, env: ENV, fetchImpl, expectSubjects: ['Updated Reddit post: Nero (99/100) for r/TheWestEnd'], waitMs: 30000, sleep: async () => {}, log: (m) => logs.push(m) });
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

// ---- same title, different shows; pagination; polling cost ----

test('two shows with the same title in one subreddit are kept apart when their emails carry a show id', () => {
  const m = [
    { ...msg('a1', 'Updated Reddit post: Hamlet (60/100) for r/TheWestEnd', 1000), showId: 'hamlet-2025' },
    { ...msg('a2', 'Updated Reddit post: Hamlet (61/100) for r/TheWestEnd', 2000), showId: 'hamlet-2025' },
    { ...msg('b1', 'Reddit post ready: Hamlet (70/100) for r/TheWestEnd', 1500), showId: 'hamlet-2026' },
  ];
  const p = a.planArchive(m);
  assert.deepEqual(p.archive, ['a1']);
  assert.deepEqual(p.keep.sort(), ['a2', 'b1']);
});

test('when show ids disagree, an older email without one is left alone rather than guessed at', () => {
  const m = [
    msg('old', 'Updated Reddit post: Hamlet (58/100) for r/TheWestEnd', 500),
    { ...msg('a1', 'Updated Reddit post: Hamlet (60/100) for r/TheWestEnd', 1000), showId: 'hamlet-2025' },
    { ...msg('b1', 'Reddit post ready: Hamlet (70/100) for r/TheWestEnd', 1500), showId: 'hamlet-2026' },
  ];
  assert.deepEqual(a.planArchive(m).archive, []);
});

test('emails with one show id (or none) still supersede each other as before', () => {
  const m = [
    msg('old', 'Updated Reddit post: Nero (40/100) for r/TheWestEnd', 500),
    { ...msg('new', 'Updated Reddit post: Nero (41/100) for r/TheWestEnd', 1000), showId: 'nero' },
  ];
  assert.deepEqual(a.planArchive(m).archive, ['old']);
});

test('sweep reads the show id header from Gmail and uses it', async () => {
  const { fetchImpl, calls } = fakeGmail({ messages: [
    { ...msg('a1', 'Updated Reddit post: Hamlet (60/100) for r/TheWestEnd', 1000), showId: 'x' },
    { ...msg('b1', 'Updated Reddit post: Hamlet (61/100) for r/TheWestEnd', 2000), showId: 'y' },
  ] });
  const r = await a.sweep({ now: () => 10000, env: ENV, fetchImpl, log: () => {} });
  assert.equal(r.archived, 0);
  assert.ok(calls.some((c) => c.path.includes('/messages/a1')));
});

test('sweep follows Gmail result pages and sees an email on the second page', async () => {
  const many = Array.from({ length: 5 }, (_, i) => msg(`m${i}`, `Updated Reddit post: Nero (4${i}/100) for r/TheWestEnd`, 1000 + i));
  const { fetchImpl, calls } = fakeGmail({ messages: many, pageSize: 2 });
  const r = await a.sweep({ now: () => 10000, env: ENV, fetchImpl, log: () => {} });
  assert.equal(r.candidates, 5);
  assert.equal(r.archived, 4);
  assert.equal(JSON.parse(calls.find((c) => c.path.endsWith('/batchModify')).body).ids.includes('m4'), false);
});

test('while waiting for a just-sent email, messages already read are not fetched again', async () => {
  const early = [msg('n40', 'Updated Reddit post: Nero (40/100) for r/TheWestEnd', 1000)];
  const late = [...early, msg('n41', 'Updated Reddit post: Nero (41/100) for r/TheWestEnd', 2000)];
  const { fetchImpl, calls } = fakeGmail({ messages: late, messagesAt: (n) => (n >= 3 ? late : early) });
  await a.sweep({ now: () => 10000, env: ENV, fetchImpl, log: () => {}, sleep: async () => {}, expectSubjects: ['Updated Reddit post: Nero (41/100) for r/TheWestEnd'] });
  assert.equal(calls.filter((c) => c.path.endsWith('/messages/n40')).length, 1);
});

// ---- 7-day expiry (owner 2026-11-09: "they should stop after 7 days") ----

const DAY = 86400000;
const NOW = 1_800_000_000_000;

test('an email older than 7 days is archived even when it is the only or newest one of its draft', () => {
  const m = [
    msg('old-only', 'Reddit post ready: Midnight (74/100) for r/offbroadwayNYC', NOW - 18 * DAY),
    msg('old-newest', 'Updated Reddit post: Phyl (80/100) for r/offbroadwayNYC', NOW - 8 * DAY),
    msg('fresh', 'Updated Reddit post: Nero (40/100) for r/TheWestEnd', NOW - 1 * DAY),
  ];
  const p = a.planArchive(m, { nowMs: NOW });
  assert.deepEqual(p.archive.sort(), ['old-newest', 'old-only']);
  assert.deepEqual(p.keep, ['fresh']);
});

test('exactly 7 days old is still kept, and an older email never revives a group', () => {
  const m = [
    msg('edge', 'Updated Reddit post: Medea (76/100) for r/offbroadwayNYC', NOW - 7 * DAY),
    msg('stale', 'Updated Reddit post: Medea (74/100) for r/offbroadwayNYC', NOW - 9 * DAY),
  ];
  const p = a.planArchive(m, { nowMs: NOW });
  assert.deepEqual(p.keep, ['edge']);
  assert.deepEqual(p.archive, ['stale']);
});

test('without a clock, planArchive applies no age rule (the old behaviour)', () => {
  const m = [msg('x', 'Updated Reddit post: Medea (76/100) for r/offbroadwayNYC', 1)];
  assert.deepEqual(a.planArchive(m).archive, []);
});

test('sweep archives an expired email and only removes the INBOX label', async () => {
  const { fetchImpl, calls } = fakeGmail({ messages: [
    msg('old', 'Reddit post ready: Midnight (74/100) for r/offbroadwayNYC', NOW - 18 * DAY),
    msg('new', 'Updated Reddit post: Nero (40/100) for r/TheWestEnd', NOW - DAY),
  ] });
  const r = await a.sweep({ env: ENV, fetchImpl, log: () => {}, now: () => NOW });
  assert.equal(r.archived, 1);
  assert.deepEqual(JSON.parse(calls.find((c) => c.path.endsWith('/batchModify')).body), { ids: ['old'], removeLabelIds: ['INBOX'] });
});

// ---- Other recurring site emails (owner 2026-11-10 chose to extend the sweep). ----
// Subjects, senders and times below are the real ones from the owner's inbox on 2026-11-10.
const ALERTS = 'Broadway Scorecard <alerts@broadwayscorecard.com>';
const DIGEST = 'Broadway Scorecard Digest <updates@broadwayscorecard.com>';
const WEST_END = 'West End Scorecard <updates@broadwayscorecard.com>';
const MD = (d) => `Morning digest — ${d} · site mostly OK · 1 minor visitor issue · 3 decisions for you`;
const REAL_INBOX = [
  msg('md8', MD('Sun, Nov 8'), 1794142657000, ALERTS),
  msg('md7', MD('Sat, Nov 7'), 1794056385000, ALERTS),
  msg('md7t', `TEST: ${MD('Sat, Nov 7')}`, 1794065316000, ALERTS),
  msg('md6', MD('Fri, Nov 6'), 1793969477000, ALERTS),
  msg('md5', MD('Thu, Nov 5'), 1793888784000, ALERTS),
  msg('md4', MD('Wed, Nov 4'), 1793796864000, ALERTS),
  msg('od8', '1 opening today · Nov 8', 1794156663000, DIGEST),
  msg('od5', '2 broadcast-ready · 1 tomorrow · Nov 5', 1793902989000, DIGEST),
  msg('od4', '2 broadcast-ready · Nov 4', 1793816414000, DIGEST),
  msg('nb8', "[DRAFT] (Sunday refresh) 7 off-Broadway shows get reviews, We'll See scores highest with critics", 1794146670000),
  msg('nb7', '[DRAFT] 8 off-Broadway shows get reviews, The Morbs scores highest with critics', 1794069939000),
  msg('nw8', '[DRAFT] (Sunday refresh) Iphigenie en Tauride - English National Opera opens to decent reviews.', 1794146654000, WEST_END),
  msg('nw7', '[DRAFT] Speculations opens to rough reviews, The Bridge opens to strong reviews.', 1794070784000, WEST_END),
];
// Emails from the same senders that must never be touched.
const UNRELATED = [
  msg('x1', 'Decision needed: Should I hand you the critic outreach note to send from your own address to the 50 critic…', 1794164536000, ALERTS),
  msg('x2', 'New Profitability Scorecard sign-up #51', 1794190123000, ALERTS),
  msg('x3', 'Broadway opening-night draft ready in Resend: Wanted', 1794224377000),
  msg('x4', 'Welcome to Broadway Scorecard', 1793785578000),
  msg('x5', 'Fixed: reader report (reported by A reader)', 1793992181000, 'Tom at Broadway Scorecard <updates@broadwayscorecard.com>'),
  msg('x6', '3 decisions are still waiting on you', 1794079738000, ALERTS),
  msg('x7', 'Sunday newsletter review — 2026-11-02', 1794148806000, ALERTS),
  msg('x8', '[CRITICAL] Opening Night Poller Failed', 1793942317000, ALERTS),
];

test('planArchive keeps the newest Morning digest, Opening Digest and newsletter draft per edition', () => {
  const r = a.planArchive(REAL_INBOX);
  assert.deepEqual([...r.keep].sort(), ['md7t', 'md8', 'nb8', 'nw8', 'od8']);
  assert.deepEqual([...r.archive].sort(), ['md4', 'md5', 'md6', 'md7', 'nb7', 'nw7', 'od4', 'od5']);
});

test('recurring emails have no age rule: an old newest digest stays', () => {
  const r = a.planArchive(REAL_INBOX, { nowMs: 1794156663000 + 60 * 86400000 });
  assert.deepEqual([...r.keep].sort(), ['md7t', 'md8', 'nb8', 'nw8', 'od8']);
});

test('planArchive never touches other mail from the same senders', () => {
  const r = a.planArchive([...REAL_INBOX, ...UNRELATED]);
  const touched = new Set([...r.archive, ...r.keep]);
  for (const m of UNRELATED) assert.ok(!touched.has(m.id), m.id);
});

test('a lookalike subject from another sender or display name is ignored', () => {
  const fake = [
    msg('f1', MD('Mon, Nov 9'), 1794300000000, 'Someone <evil@example.com>'),
    msg('f2', '1 opening today · Nov 9', 1794300000000, 'Broadway Scorecard <updates@broadwayscorecard.com>'),
    msg('f3', '[DRAFT] hello', 1794300000000, 'Tom at Broadway Scorecard <updates@broadwayscorecard.com>'),
    msg('f4', MD('Mon, Nov 9'), 1794300000000, 'Broadway Scorecard <updates@broadwayscorecard.com>'),
  ];
  const r = a.planArchive([...REAL_INBOX, ...fake]);
  for (const id of ['f1', 'f2', 'f3', 'f4']) assert.ok(![...r.archive, ...r.keep].includes(id), id);
  assert.deepEqual([...r.keep].sort(), ['md7t', 'md8', 'nb8', 'nw8', 'od8']);
});

test('Reddit drafts and recurring emails are planned together without mixing groups', () => {
  const reddit = [msg('r1', 'Updated Reddit post: Nero (41/100) for r/TheWestEnd', 1794259000000), msg('r2', 'Updated Reddit post: Nero (40/100) for r/TheWestEnd', 1794259721000)];
  const r = a.planArchive([...reddit, ...REAL_INBOX], { nowMs: 1794300000000 });
  assert.ok(r.archive.includes('r1') && r.keep.includes('r2'));
  assert.equal(r.groups, 6);
});

test('parseFrom reads names and bare addresses', () => {
  assert.deepEqual(a.parseFrom('"West End Scorecard" <Updates@BroadwayScorecard.com>'), { name: 'West End Scorecard', addr: 'updates@broadwayscorecard.com' });
  assert.deepEqual(a.parseFrom('updates@broadwayscorecard.com'), { name: '', addr: 'updates@broadwayscorecard.com' });
});

test('the Gmail search covers every recurring kind', () => {
  for (const part of ['from:updates@broadwayscorecard.com', 'from:alerts@broadwayscorecard.com', 'subject:"Morning digest"', 'subject:"[DRAFT]"', 'from:"Broadway Scorecard Digest"', 'subject:"Reddit post"']) {
    assert.ok(a.LIST_QUERY.includes(part), part);
  }
});

test('Money Scorecard [DRAFT] preview is never grouped with the weekly newsletter drafts', () => {
  const money = msg('money', '[DRAFT] Money Scorecard, October: 2 recoupments and 1 closing', 1793900000000);
  const r = a.planArchive([money, ...REAL_INBOX.filter((m) => m.id === 'nb7' || m.id === 'nb8')]);
  assert.ok(!r.archive.includes('money'));
  assert.deepEqual(r.archive.filter((id) => id === 'nb7'), ['nb7']);
});
