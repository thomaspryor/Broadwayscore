import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const nf = require('./newsletter-facts.js');
const { processMessages } = require('../read-theater-newsletters.js');

const CHROMO = nf.SENDERS[0];
const SUBSTACK = nf.SENDERS[1];
const BRIEFING = nf.SENDERS[2];

test('buildQuery names exactly the three approved senders', () => {
  const q = nf.buildQuery();
  assert.equal(q, 'newer_than:8d (from:ido@chromolume.io OR from:gordoncox@substack.com OR from:broadwaybriefing@broadwaybriefing.com)');
  assert.equal(nf.buildQuery(3).startsWith('newer_than:3d '), true);
});

test('senderFor matches exact addresses only', () => {
  assert.equal(nf.senderFor('Ido Gal <ido@chromolume.io>'), CHROMO);
  assert.equal(nf.senderFor('gordoncox@substack.com'), SUBSTACK);
  assert.equal(nf.senderFor('"Broadway Briefing" <BroadwayBriefing@broadwaybriefing.com>'), BRIEFING);
  assert.equal(nf.senderFor('Ido Gal <ido@chromolume.io> (via list)'), CHROMO);
  assert.equal(nf.senderFor('"ido@chromolume.io" <attacker@evil.com>'), null);
  assert.equal(nf.senderFor('ido@chromolume.io.evil.com'), null);
  assert.equal(nf.senderFor('Ido <ido@chromolume.io.evil.com>'), null);
  assert.equal(nf.senderFor('someone-else@substack.com'), null);
  assert.equal(nf.senderFor('investor-updates@example.com'), null);
  assert.equal(nf.senderFor(''), null);
  assert.equal(nf.senderFor(undefined), null);
});

test('dkimPassesFor needs a pass for the sender own domain', () => {
  const ok = 'mx.google.com; dkim=pass header.i=@substack.com header.s=s1; spf=pass';
  assert.equal(nf.dkimPassesFor(SUBSTACK, ok), true);
  assert.equal(nf.dkimPassesFor(SUBSTACK, [ok]), true);
  assert.equal(nf.dkimPassesFor(SUBSTACK, 'mx.google.com; dkim=pass header.d=mail.substack.com'), true);
  assert.equal(nf.dkimPassesFor(SUBSTACK, 'mx.google.com; dkim=pass header.i=@attacker.example'), false);
  assert.equal(nf.dkimPassesFor(SUBSTACK, 'mx.google.com; dkim=fail header.i=@substack.com'), false);
  assert.equal(nf.dkimPassesFor(SUBSTACK, 'mx.google.com; dkim=pass header.d=notsubstack.com'), false);
  assert.equal(nf.dkimPassesFor(SUBSTACK, []), false);
  // a forged header lower in the message, or one not from Gmail's receiver, never counts
  assert.equal(nf.dkimPassesFor(SUBSTACK, ['mx.google.com; dkim=fail header.i=@substack.com', 'x; dkim=pass header.i=@substack.com']), false);
  assert.equal(nf.dkimPassesFor(SUBSTACK, 'dkim=pass header.i=@substack.com'), false);
  assert.equal(nf.dkimPassesFor(null, ok), false);
});

test('pickIssueUrl returns a post link on the sender host, without tracking', () => {
  const links = [
    'https://chromolume.us16.list-manage.com/unsubscribe?u=1',
    'https://gordoncox.substack.com/p/abroadway-oct-21?utm_source=email&token=abc',
  ];
  assert.equal(nf.pickIssueUrl(SUBSTACK, links), 'https://gordoncox.substack.com/p/abroadway-oct-21');
  assert.equal(nf.pickIssueUrl(CHROMO, ['https://chromolume.io?utm_source=newsletter']), null);
  assert.equal(nf.pickIssueUrl(CHROMO, ['https://chromolume.io/issues/commission-26/?utm=x']), 'https://chromolume.io/issues/commission-26');
  assert.equal(nf.pickIssueUrl(CHROMO, ['https://chromolume.io/blog/week-18-analysis?utm=x']), 'https://chromolume.io/blog/week-18-analysis');
  assert.equal(nf.pickIssueUrl(CHROMO, ['https://chromolume.io/blog/chromolume-composite-wordmark.png', 'https://chromolume.io/blog/week-18-analysis']), 'https://chromolume.io/blog/week-18-analysis');
  assert.equal(nf.pickIssueUrl(CHROMO, ['https://chromolume.io/blog/chromolume-composite-wordmark.png']), null);
  assert.equal(nf.pickIssueUrl(CHROMO, ['https://chromolume.io/blog']), null);
  assert.equal(nf.pickIssueUrl(BRIEFING, ['https://www.broadwaybriefing.com/p/briefing-oct-23', 'https://example.com/p/x']), 'https://www.broadwaybriefing.com/p/briefing-oct-23');
  assert.equal(nf.pickIssueUrl(SUBSTACK, ['https://substack.com/redirect/2/abc']), null);
  assert.equal(nf.pickIssueUrl(SUBSTACK, ['not a url', 'https://evil.example/p/x']), null);
});

test('extractLinks trims trailing punctuation', () => {
  assert.deepEqual(nf.extractLinks('See (https://a.com/p/x). Also https://b.com/p/y, ok'), ['https://a.com/p/x', 'https://b.com/p/y']);
});

test('parseFacts survives prose around the JSON and bad output', () => {
  assert.deepEqual(nf.parseFacts('Here: {"facts":[{"show":"X"}]} done'), [{ show: 'X' }]);
  assert.deepEqual(nf.parseFacts('no json'), []);
  assert.deepEqual(nf.parseFacts('{"facts": 3}'), []);
  assert.deepEqual(nf.parseFacts(null), []);
});

test('buildExtractionPrompt truncates the body and fences it as untrusted data', () => {
  const p = nf.buildExtractionPrompt({ senderLabel: 'X', subject: 'S', date: 'D', text: 'a'.repeat(50000) });
  assert.match(p, /untrusted data/);
  assert.equal(p.includes('a'.repeat(30001)), false);
  assert.equal(p.includes('a'.repeat(30000)), true);
});

const URL1 = 'https://gordoncox.substack.com/p/x';
const good = { show: 'Hamilton', field: 'capitalization', value: '$12,500,000', broadway: true, explicit: true };

test('validateFact accepts a clean numeric fact and normalizes the number', () => {
  const v = nf.validateFact(good, URL1);
  assert.equal(v.ok, true);
  assert.deepEqual(v.fact, { show: 'Hamilton', field: 'capitalization', value: 12500000, issueUrl: URL1 });
});

test('validateFact skips each unsafe case with a stable reason', () => {
  const reason = (raw, url = URL1) => nf.validateFact(raw, url).reason;
  assert.equal(reason(good, null), 'no-public-url');
  assert.equal(reason({ ...good, broadway: false }), 'not-broadway');
  assert.equal(reason({ ...good, explicit: false }), 'not-explicit');
  assert.equal(reason({ ...good, field: 'grosses' }), 'unknown-field');
  assert.equal(reason({ ...good, show: ' ' }), 'no-show');
  assert.equal(reason({ ...good, value: 'lots' }), 'bad-number');
  assert.equal(reason({ ...good, value: -5 }), 'bad-number');
  assert.equal(reason({ ...good, field: 'closing', value: '' }), 'empty-value');
  assert.equal(reason(null), 'malformed');
  assert.equal(nf.validateFact({ ...good, field: 'profit', value: -2000000 }, URL1).ok, true);
});

const SHOWS = [{ slug: 'hamilton', id: 'hamilton-2015', title: 'Hamilton' }, { slug: 'the-lost-boys-2026', id: 'lost-boys', title: 'The Lost Boys' }];
const COMMERCIAL = {
  shows: {
    hamilton: { capitalization: 12500000, recouped: true, sources: [{ url: 'https://nyt.com/a' }] },
    'the-lost-boys-2026': { slug: 'the-lost-boys-2026', capitalization: null, recouped: false, sources: [] },
  },
};

test('matchShow resolves by normalized title and tolerates no record', () => {
  assert.equal(nf.matchShow('HAMILTON', SHOWS, COMMERCIAL.shows).slug, 'hamilton');
  assert.equal(nf.matchShow('Lost Boys', SHOWS, COMMERCIAL.shows).slug, 'the-lost-boys-2026');
  assert.equal(nf.matchShow('the lost boys', SHOWS, COMMERCIAL.shows).record.slug, 'the-lost-boys-2026');
  assert.equal(nf.matchShow('Nonexistent Show', SHOWS, COMMERCIAL.shows), null);
  assert.equal(nf.matchShow('Hamilton', SHOWS, {}).record, null);
});

test('diffFact classifies known, conflict and new', () => {
  const rec = COMMERCIAL.shows.hamilton;
  const f = (field, value, issueUrl = URL1) => ({ show: 'Hamilton', field, value, issueUrl });
  assert.equal(nf.diffFact(f('capitalization', 12600000), rec).status, 'known');
  assert.equal(nf.diffFact(f('capitalization', 15000000), rec).status, 'conflict');
  assert.equal(nf.diffFact(f('weeklyCost', 640000), rec).status, 'new');
  assert.equal(nf.diffFact(f('capitalization', 99), { ...rec, sources: [{ url: URL1 }] }).status, 'known');
  assert.equal(nf.diffFact(f('recouped', 'recouped'), rec).status, 'known');
  assert.equal(nf.diffFact(f('recouped', 'recouped'), COMMERCIAL.shows['the-lost-boys-2026']).status, 'conflict');
  assert.equal(nf.diffFact(f('capitalization', 1), null).status, 'new');
});

test('buildAlertOpts: null when nothing to review, one card otherwise, stable key', () => {
  assert.equal(nf.buildAlertOpts([]), null);
  assert.equal(nf.buildAlertOpts([{ fact: { show: 'X', field: 'closing', value: 'v', issueUrl: URL1 }, status: 'known' }]), null);
  const items = [
    { fact: { show: 'Hamilton', field: 'capitalization', value: 15000000, issueUrl: URL1 }, slug: 'hamilton', status: 'conflict', existing: 12500000 },
    { fact: { show: 'The Lost Boys', field: 'weeklyCost', value: 900000, issueUrl: URL1 }, slug: 'the-lost-boys-2026', status: 'new', existing: null },
  ];
  const a = nf.buildAlertOpts(items);
  assert.equal(a.disposition, 'auto');
  assert.match(a.title, /Review 2 Broadway business facts/);
  assert.match(a.description, /CONFLICT hamilton capitalization: 15000000 \(record has 12500000\)/);
  assert.match(a.description, /Nothing was written to commercial data/);
  assert.equal(nf.buildAlertOpts([...items].reverse()).conditionKey, a.conditionKey);
  assert.notEqual(nf.buildAlertOpts([items[0]]).conditionKey, a.conditionKey);
});

test('buildFetchFailureAlertOpts has a stable key and trims the message', () => {
  const o = nf.buildFetchFailureAlertOpts('x'.repeat(1000));
  assert.equal(o.conditionKey, 'theater-newsletter-reader-gmail-failure');
  assert.equal(o.description.length < 700, true);
});

// ---- end to end through processMessages, with a fake extractor ----
const NOW = Date.parse('2026-10-26T12:00:00Z');
const auth = 'mx.google.com; dkim=pass header.i=@substack.com';
const msg = (over) => ({ id: 'm', date: '2026-10-21T12:00:00Z', from: 'gordoncox@substack.com', subject: 'Issue', authResults: [auth], text: `Read online: ${URL1}?utm=1`, ...over });
const extractor = (facts) => { const calls = []; const fn = async (p) => { calls.push(p); return JSON.stringify({ facts }); }; fn.calls = calls; return fn; };

test('processMessages: only the approved senders reach the extractor', async () => {
  const ex = extractor([good]);
  const r = await processMessages([
    msg({ from: 'newsletter@other.com', id: 'other' }),
    msg({ from: 'ido@chromolume.io', authResults: ['mx.google.com; dkim=pass header.i=@chromolume.io'], text: 'https://chromolume.io/issues/c26', id: 'c' }),
    msg({ id: 's' }),
  ], { extract: ex, shows: SHOWS, commercial: COMMERCIAL, windowDays: 7, now: NOW });
  assert.equal(ex.calls.length, 2);
  assert.equal(r.skipped['sender-not-allowlisted'], 1);
  assert.equal(r.issues.length, 2);
});

test('processMessages: dkim failure, missing URL and old issues never reach the extractor', async () => {
  const ex = extractor([good]);
  const r = await processMessages([
    msg({ authResults: [] }),
    msg({ text: 'no links here' }),
    msg({ date: '2026-10-01T00:00:00Z' }),
  ], { extract: ex, shows: SHOWS, commercial: COMMERCIAL, windowDays: 7, now: NOW });
  assert.equal(ex.calls.length, 0);
  assert.equal(r.skipped['dkim-not-verified'], 1);
  assert.equal(r.skipped['issue-has-no-public-url'], 1);
  assert.equal(r.skipped['older-than-window'], 1);
  assert.equal(r.items.length, 0);
});

test('processMessages: new and conflicting facts are reported, known and unsafe ones are not', async () => {
  const ex = extractor([
    { show: 'Hamilton', field: 'capitalization', value: 15000000, broadway: true, explicit: true },
    { show: 'Hamilton', field: 'capitalization', value: 12500000, broadway: true, explicit: true },
    { show: 'The Lost Boys', field: 'recouped', value: 'recouped its $20M investment', broadway: true, explicit: true },
    { show: 'Hamilton', field: 'weeklyCost', value: 1, broadway: false, explicit: true },
    { show: 'Hamilton', field: 'profit', value: 5000000, broadway: true, explicit: false },
  ]);
  const r = await processMessages([msg()], { extract: ex, shows: SHOWS, commercial: COMMERCIAL, windowDays: 7, now: NOW });
  assert.deepEqual(r.items.map((i) => `${i.status}:${i.slug}:${i.fact.field}`), ['conflict:hamilton:capitalization', 'conflict:the-lost-boys-2026:recouped']);
  assert.equal(r.skipped['already-in-commercial'], 1);
  assert.equal(r.skipped['not-broadway'], 1);
  assert.equal(r.skipped['not-explicit'], 1);
  assert.equal(r.issues[0].issueUrl, URL1);
});

test('processMessages: nothing stored from the email body ends up in the report', async () => {
  const secret = 'PRIVATE-BODY-SENTENCE-7731';
  const ex = extractor([good]);
  const r = await processMessages([msg({ text: `${secret} ${URL1}` })], { extract: ex, shows: SHOWS, commercial: COMMERCIAL, windowDays: 7, now: NOW });
  assert.equal(JSON.stringify(r).includes(secret), false);
  assert.equal(JSON.stringify(nf.buildAlertOpts(r.items)).includes(secret), false);
});

test('pickIssueUrl only takes Gordon Cox posts on Substack hosts', () => {
  const links = ['https://otherwriter.substack.com/p/foo', 'https://open.substack.com/pub/other/p/bar', 'https://substack.com/home/post/p-123', 'https://open.substack.com/pub/gordoncox/p/real?x=1'];
  assert.equal(nf.pickIssueUrl(SUBSTACK, links), 'https://open.substack.com/pub/gordoncox/p/real');
  assert.equal(nf.pickIssueUrl(SUBSTACK, links.slice(0, 3)), null);
});

test('matchShow prefers the production that has a commercial record', () => {
  const shows = [{ id: 'x-2026', slug: 'x-2026', title: 'X' }, { id: 'x-2022', slug: 'x-2022', title: 'X' }];
  assert.equal(nf.matchShow('X', shows, { 'x-2022': { slug: 'x-2022' } }).slug, 'x-2022');
});

test('recouped facts never carry newsletter wording', () => {
  const v = nf.validateFact({ show: 'X', field: 'recouped', value: 'it earned back every dollar', broadway: true, explicit: true }, URL1);
  assert.equal(v.fact.value, 'recouped');
});

test('one failed extraction does not lose the other issues', async () => {
  let n = 0;
  const extract = async () => { if (n++ === 0) throw new Error('Anthropic HTTP 529'); return '{"facts":[]}'; };
  const r = await processMessages([msg({ id: 'a' }), msg({ id: 'b' })], { extract, shows: SHOWS, commercial: COMMERCIAL, windowDays: 7, now: Date.parse('2026-10-25T00:00:00Z') });
  assert.equal(r.skipped['extraction-failed'], 1);
  assert.equal(r.issues.length, 2);
});
