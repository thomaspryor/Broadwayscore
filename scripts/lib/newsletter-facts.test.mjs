import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const nf = require('./newsletter-facts.js');
const { processMessages, processPosts, emailPosts, canonicalPostUrl, readWebSource, parseArgs } = require('../read-theater-newsletters.js');

const CHROMO = nf.WEB_SOURCES[0];
const SUBSTACK = nf.WEB_SOURCES[1];
const BRIEFING = nf.EMAIL_SENDERS[0];

test('buildQuery names only the Gmail-read sender (the other two are read from the web)', () => {
  const q = nf.buildQuery();
  assert.equal(q, 'newer_than:14d (from:broadwaybriefing@broadwaybriefing.com)');
  assert.equal(nf.buildQuery(3).startsWith('newer_than:3d '), true);
});

test('senderFor matches exact addresses only', () => {
  assert.equal(nf.senderFor('Ido Gal <ido@chromolume.io>'), null);
  assert.equal(nf.senderFor('gordoncox@substack.com'), null);
  assert.equal(nf.senderFor('"Broadway Briefing" <BroadwayBriefing@broadwaybriefing.com>'), BRIEFING);
  assert.equal(nf.senderFor('Broadway Briefing <broadwaybriefing@broadwaybriefing.com> (via list)'), BRIEFING);
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
  assert.equal(nf.pickIssueUrl(CHROMO, ['https://chromolume.io/issues/commission-26/?utm=x']), null);
  assert.equal(nf.pickIssueUrl(CHROMO, ['https://chromolume.io/blog/composite-october-4-2026?utm=x']), 'https://chromolume.io/blog/composite-october-4-2026');
  assert.equal(nf.pickIssueUrl(CHROMO, ['https://chromolume.io/blog/composite-wordmark.png', 'https://chromolume.io/blog/composite-october-4-2026']), 'https://chromolume.io/blog/composite-october-4-2026');
  assert.equal(nf.pickIssueUrl(CHROMO, ['https://chromolume.io/blog/week-18-analysis']), null);
  assert.equal(nf.pickIssueUrl(CHROMO, ['https://chromolume.io/blog']), null);
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

// ---- end to end through processMessages (Briefing) and processPosts, with fakes ----
const NOW = Date.parse('2026-10-26T12:00:00Z');
const auth = 'mx.google.com; dkim=pass header.i=@broadwaybriefing.com';
const LONG = 'The producers said the show has recouped its investment. '.repeat(20);
const SRC = 'https://www.broadwaynews.com/some-article/';
const msg = (over) => ({ id: 'm', date: '2026-10-21T12:00:00Z', from: 'broadwaybriefing@broadwaybriefing.com', subject: 'Briefing', authResults: [auth], text: 'The show closes after raising $20 million (https://bway.ly/abc123)', ...over });
const extractor = (facts) => { const calls = []; const fn = async (p) => { calls.push(p); return JSON.stringify({ facts }); }; fn.calls = calls; return fn; };
const fresh = { show: 'Hamilton', field: 'weeklyCost', value: 640000, broadway: true, explicit: true };
const okLink = async () => ({ ok: true, url: SRC });
const okPage = async () => ({ ok: true, body: `<article>${LONG}</article>` });
const base = (ex, over = {}) => ({ extract: ex, shows: SHOWS, commercial: COMMERCIAL, windowDays: 7, now: NOW, resolveLink: okLink, fetchArticle: okPage, ...over });

test('processMessages: only the approved sender reaches the extractor', async () => {
  const ex = extractor([good]);
  const r = await processMessages([msg({ from: 'newsletter@other.com', id: 'other' }), msg({ from: 'ido@chromolume.io' }), msg()], base(ex));
  assert.equal(ex.calls.length, 1);
  assert.equal(r.skipped['sender-not-allowlisted'], 2);
  assert.equal(r.issues.length, 1);
});

test('processMessages: facts are extracted from and cited to the resolved original article', async () => {
  const ex = extractor([fresh]);
  const r = await processMessages([msg()], base(ex));
  assert.equal(r.issues[0].status, 'read');
  assert.deepEqual(r.issues[0].citations, [SRC]);
  assert.equal(r.items[0].fact.issueUrl, SRC);
  assert.match(ex.calls[0], /news article/);
});

test('processMessages: dkim failure and old issues never reach the extractor', async () => {
  const ex = extractor([good]);
  const r = await processMessages([msg({ authResults: [] }), msg({ date: '2026-10-01T00:00:00Z' })], base(ex));
  assert.equal(ex.calls.length, 0);
  assert.equal(r.skipped['dkim-not-verified'], 1);
  assert.equal(r.skipped['older-than-window'], 1);
});

test('processMessages: unresolvable links are skipped and counted, never cited', async () => {
  const ex = extractor([good]);
  const r = await processMessages([msg()], base(ex, { resolveLink: async () => ({ ok: false, reason: 'destination-not-registered-outlet' }) }));
  assert.equal(ex.calls.length, 0);
  assert.equal(r.skipped['link-destination-not-registered-outlet'], 1);
  assert.equal(r.issues[0].status, 'skipped');
  assert.equal(r.issues[0].reason, 'no-item-resolvable');
});

test('processMessages: a paywall stub or fetch block skips the item', async () => {
  const ex = extractor([good]);
  const stub = await processMessages([msg()], base(ex, { fetchArticle: async () => ({ ok: true, body: '<article>Subscribe to read</article>' }) }));
  assert.equal(stub.skipped['article-body-too-short'], 1);
  const blocked = await processMessages([msg()], base(ex, { fetchArticle: async () => ({ ok: false, reason: 'fetch-blocked' }) }));
  assert.equal(blocked.skipped['article-fetch-blocked'], 1);
  assert.equal(ex.calls.length, 0);
});

test('processMessages: an issue with no money or closing item is read, not skipped', async () => {
  const ex = extractor([good]);
  const r = await processMessages([msg({ text: 'Opening night party photos (https://bway.ly/zzz999)' })], base(ex));
  assert.equal(r.issues[0].status, 'read');
  assert.equal(r.issues[0].candidates, 0);
  assert.equal(ex.calls.length, 0);
});

test('processMessages: the same article linked twice is extracted once', async () => {
  const ex = extractor([good]);
  await processMessages([msg(), msg({ id: 'm2', date: '2026-10-22T12:00:00Z' })], base(ex));
  assert.equal(ex.calls.length, 1);
});

test('processMessages: new and conflicting facts are reported, known and unsafe ones are not', async () => {
  const ex = extractor([
    { show: 'Hamilton', field: 'capitalization', value: 15000000, broadway: true, explicit: true },
    { show: 'Hamilton', field: 'capitalization', value: 12500000, broadway: true, explicit: true },
    { show: 'The Lost Boys', field: 'recouped', value: 'recouped its $20M investment', broadway: true, explicit: true },
    { show: 'Hamilton', field: 'weeklyCost', value: 1, broadway: false, explicit: true },
    { show: 'Hamilton', field: 'profit', value: 5000000, broadway: true, explicit: false },
  ]);
  const r = await processMessages([msg()], base(ex));
  assert.deepEqual(r.items.map((i) => `${i.status}:${i.slug}:${i.fact.field}`), ['conflict:hamilton:capitalization', 'conflict:the-lost-boys-2026:recouped']);
  assert.equal(r.skipped['already-in-commercial'], 1);
  assert.equal(r.skipped['not-broadway'], 1);
  assert.equal(r.skipped['not-explicit'], 1);
});

test('processMessages: nothing stored from the email body ends up in the report', async () => {
  const secret = 'PRIVATE-BODY-SENTENCE-7731';
  const ex = extractor([good]);
  const r = await processMessages([msg({ text: `${secret} raised $5 million (https://bway.ly/abc123)` })], base(ex));
  assert.equal(JSON.stringify(r).includes(secret), false);
  assert.equal(JSON.stringify(nf.buildAlertOpts(r.items)).includes(secret), false);
});

test('processPosts: reads web posts, cites the post URL, skips stubs and bad URLs', async () => {
  const ex = extractor([fresh]);
  const items = [];
  const skipped = {};
  const deps = { extract: ex, shows: SHOWS, commercial: COMMERCIAL, items, bump: (k) => { skipped[k] = (skipped[k] || 0) + 1; } };
  const issues = await processPosts(CHROMO, [
    { url: 'https://chromolume.io/blog/composite-october-4-2026', date: '2026-10-04', text: LONG },
    { url: 'https://chromolume.io/blog/composite-october-11-2026', date: '2026-10-11', text: 'short' },
    { url: 'https://evil.example/blog/composite-october-18-2026', date: '2026-10-18', text: LONG },
    { url: 'https://chromolume.io/blog/composite-october-25-2026', date: '2026-10-25', error: 'post-fetch-blocked' },
  ], deps);
  assert.deepEqual(issues.map((i) => i.status), ['read', 'skipped', 'skipped', 'skipped']);
  assert.deepEqual(issues.map((i) => i.reason), [null, 'body-too-short', 'issue-has-no-public-url', 'post-fetch-blocked']);
  assert.equal(items[0].fact.issueUrl, 'https://chromolume.io/blog/composite-october-4-2026');
  assert.equal(ex.calls.length, 1);
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
  const r = await processMessages([msg({ id: 'a' }), msg({ id: 'b', text: 'raised $9 million (https://bway.ly/other11)' })], base(extract, { resolveLink: async (u) => ({ ok: true, url: `${SRC}${u.slice(-3)}` }) }));
  assert.equal(r.skipped['extraction-failed'], 1);
  assert.equal(r.issues.length, 2);
});

test('processMessages: an issue whose only extraction failed is skipped, not read', async () => {
  const extract = async () => { throw new Error('Anthropic HTTP 529'); };
  const r = await processMessages([msg()], base(extract));
  assert.equal(r.issues[0].status, 'skipped');
  assert.equal(r.issues[0].reason, 'extraction-failed');
  assert.equal(r.skipped['extraction-failed'], 1);
});

test('processMessages: an email with no bway.ly links at all is a skip (format drift)', async () => {
  const ex = extractor([good]);
  const r = await processMessages([msg({ html: '<p>Raised $20 million, no short links here</p>', text: 'Raised $20 million' })], base(ex));
  assert.equal(r.issues[0].status, 'skipped');
  assert.equal(r.issues[0].reason, 'no-bway-links');
});

// BRO-6265: Substack blocks GitHub runners, so Abroad/Way falls back to its email copy.
const AW = nf.WEB_SOURCES.find((w) => w.key === 'abroadway');
const AW_POST = 'https://gordoncox.substack.com/p/international-theater-news-x';
const AW_TEXT = `View this post on the web at ${AW_POST}\n${'Producers in Seoul and London announced new musicals. '.repeat(20)}`;
const awMsg = (over) => ({ from: 'Gordon Cox <gordoncox@substack.com>', authResults: ['mx.google.com; dkim=pass header.i=@substack.com header.s=s1'], date: '2026-10-21T12:00:00.000Z', subject: 'ABROAD/WAY', text: AW_TEXT, html: `<a href="https://gordoncox.substack.com/p/older-issue">older</a>`, ...over });

test('emailPosts keeps only DKIM-verified Gordon Cox issues, cited by the canonical post URL', () => {
  const posts = emailPosts(AW, [
    awMsg(),
    awMsg({ from: 'someone@substack.com' }),
    awMsg({ authResults: ['mx.google.com; dkim=fail header.i=@substack.com'] }),
    awMsg({ text: `New comment on ${AW_POST}/comments` }), // short notification, not an issue
    awMsg({ text: 'x'.repeat(700), html: '<a href="https://otherwriter.substack.com/p/y">y</a>' }),
  ]);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].url, AW_POST); // the text part's own link wins over an older post in the html
  assert.equal(posts[0].date, '2026-10-21');
});

test('canonicalPostUrl strips share/comment variants to gordoncox.substack.com/p/<slug>', () => {
  assert.equal(canonicalPostUrl('https://open.substack.com/pub/gordoncox/p/abc?utm_source=x'), 'https://gordoncox.substack.com/p/abc');
  assert.equal(canonicalPostUrl('https://gordoncox.substack.com/p/abc/comments'), 'https://gordoncox.substack.com/p/abc');
  assert.equal(canonicalPostUrl(null), null);
});

const blocked = async () => ({ ok: false, status: 403, headers: { get: () => null } });
const awArgs = { days: 8, maxNew: 2, dryRun: false };

test('readWebSource falls back to email when Substack blocks, and skips already-processed issues', async () => {
  const readEmail = async (q) => { assert.match(q, /^newer_than:8d from:gordoncox@substack\.com$/); return [awMsg()]; };
  const first = await readWebSource(AW, { fetchImpl: blocked, args: awArgs, state: { processed: {} }, readEmail });
  assert.equal(first.posts.length, 1);
  assert.equal(first.listingEmpty, false);
  const again = await readWebSource(AW, { fetchImpl: blocked, args: awArgs, state: { processed: { abroadway: [AW_POST] } }, readEmail });
  assert.equal(again.posts.length, 0, 'an issue read last week is not re-read');
});

test('readWebSource marks the run failed when the email fallback throws', async () => {
  const prev = process.exitCode;
  const r = await readWebSource(AW, { fetchImpl: blocked, args: awArgs, state: { processed: {} }, readEmail: async () => { throw new Error('invalid_grant'); } });
  assert.equal(r.listingEmpty, true);
  assert.equal(process.exitCode, 1);
  process.exitCode = prev;
});


test('Briefing query and processing windows both default to 14 days', () => {
  const args = parseArgs(['node', 'reader']);
  assert.equal(args.days, 14);
  assert.equal(args.windowDays, 14);
  assert.equal(parseArgs(['node', 'reader', '--days=3', '--window-days=2']).windowDays, 2);
});

test('processMessages skips persisted Briefing IDs live, but dry runs reread them', async () => {
  const state = { processed: { 'broadway-briefing': ['m'], chromolume: ['other'] } };
  const ex = extractor([]);
  let resolutions = 0;
  const options = base(ex, { state, resolveLink: async () => { resolutions++; return okLink(); } });
  const live = await processMessages([msg()], options);
  assert.deepEqual(live.issues, []);
  assert.deepEqual(live.items, []);
  assert.equal(live.skipped['already-processed'], 1);
  assert.equal(resolutions, 0);
  assert.equal(ex.calls.length, 0);
  const dry = await processMessages([msg()], { ...options, dryRun: true });
  assert.equal(dry.issues[0].status, 'read');
  assert.equal(ex.calls.length, 1);
  assert.deepEqual(state.processed['broadway-briefing'], ['m']);
  const other = await processMessages([msg({ id: 'other' })], options);
  assert.equal(other.issues[0].status, 'read', 'other sources do not suppress Gmail IDs');
});

test('processMessages catches up the previous week and excludes messages outside 14 days', async () => {
  const ex = extractor([]);
  const r = await processMessages([
    msg({ id: 'old', date: '2026-10-11T12:00:00Z' }),
    msg({ id: 'boundary', date: '2026-10-12T12:00:00Z' }),
    msg({ id: 'last-week', date: '2026-10-16T12:00:00Z' }),
  ], base(ex, { windowDays: undefined }));
  assert.deepEqual(r.issues.map((i) => i.messageId), ['boundary', 'last-week']);
  assert.equal(r.skipped['older-than-window'], 1);
});

test('Briefing checkpoints only fully processed messages and retries failed extraction', async () => {
  let attempts = 0;
  const ex = async () => { if (++attempts === 1) throw new Error('temporary'); return '{"facts":[]}'; };
  const r = await processMessages([msg(), msg({ id: 'second' }), msg({ id: 'second' })], base(ex));
  assert.equal(attempts, 2);
  assert.equal(r.skipped['already-processed'], 1);
  assert.deepEqual(nf.processedBriefingIds([], r.issues), ['second']);
  const partial = await processMessages([msg({ text: 'Raised $20 million (https://bway.ly/abc123)\nRaised $9 million (https://bway.ly/other11)' })], base(extractor([]), {
    resolveLink: async (url) => url.endsWith('other11') ? { ok: false, reason: 'blocked' } : okLink(),
  }));
  assert.equal(partial.issues[0].status, 'read');
  assert.deepEqual(nf.processedBriefingIds([], partial.issues), []);
  const rejected = await processMessages([msg({ authResults: [] }), msg({ id: 'no-links', text: 'No links' })], base(extractor([])));
  assert.deepEqual(nf.processedBriefingIds([], rejected.issues), []);
});

test('Briefing checkpoint cap keeps the 200 newest IDs without duplicates', () => {
  const previous = Array.from({ length: 199 }, (_, i) => `old-${i}`);
  const issue = (messageId, date) => ({ source: 'broadway-briefing', messageId, date, status: 'read' });
  const ids = nf.processedBriefingIds(previous, [issue('newer', '2026-10-26'), issue('older', '2026-10-25'), issue('old-198', '2026-10-24')]);
  assert.equal(ids.length, 200);
  assert.equal(ids.includes('old-0'), false);
  assert.deepEqual(ids.slice(-2), ['older', 'newer']);
  assert.equal(previous.length, 199);
});

test('live CLI saves and reloads Gmail IDs, preserves web state, and does not alert on reruns', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'briefing-state-'));
  try {
    const statePath = path.join(dir, 'data', 'audit', 'newsletter-reader-state.json');
    const messagesPath = path.join(dir, 'messages.json');
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify({ processed: { chromolume: ['existing-web-url'], 'broadway-briefing': ['seen'] }, zeroRuns: {} }));
    const date = (days) => new Date(Date.now() - days * 86400000).toISOString();
    fs.writeFileSync(messagesPath, JSON.stringify([
      msg({ id: 'seen', date: date(1), text: 'Photos (https://bway.ly/abc123)' }),
      msg({ id: 'catch-up', date: date(10), text: 'Photos (https://bway.ly/abc123)' }),
      msg({ id: 'recent', date: date(2), text: 'Photos (https://bway.ly/abc123)' }),
    ]));
    const args = ['scripts/read-theater-newsletters.js', '--source=broadway-briefing', `--state=${statePath}`, `--from-file=${messagesPath}`];
    const run = (extra = []) => {
      const result = spawnSync(process.execPath, [...args, ...extra], { encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr + result.stdout);
      assert.doesNotMatch(result.stdout, /HEALTH ALERT|routeAlert /);
      return result.stdout;
    };
    assert.match(run(), /Issues found: 2/);
    const saved = fs.readFileSync(statePath, 'utf8');
    const state = JSON.parse(saved);
    assert.deepEqual(state.processed['broadway-briefing'], ['seen', 'catch-up', 'recent']);
    assert.deepEqual(state.processed.chromolume, ['existing-web-url']);
    assert.match(run(), /Issues found: 0/);
    assert.match(run(), /Issues found: 0/);
    assert.equal(JSON.parse(fs.readFileSync(statePath)).zeroRuns['broadway-briefing'], 0);
    assert.match(run(['--dry-run']), /Issues found: 3/);
    assert.equal(fs.readFileSync(statePath, 'utf8'), saved);

    // A routing failure must not checkpoint even successfully read messages.
    // Replace the alert transport in this child only; never contact the owner.
    const preload = path.join(dir, 'failed-alert.cjs');
    const router = require.resolve('./owner-alert-router');
    fs.writeFileSync(preload, `require.cache[${JSON.stringify(router)}] = { exports: { routeAlert: async () => ({ dispatchOk: false }) } };`);
    fs.writeFileSync(messagesPath, JSON.stringify([
      msg({ id: 'retry-after-alert', date: date(1), text: 'Photos (https://bway.ly/abc123)' }),
      msg({ id: 'bad-format-1', date: date(1), text: 'No links' }),
      msg({ id: 'bad-format-2', date: date(1), text: 'No links' }),
    ]));
    const failed = spawnSync(process.execPath, ['--require', preload, ...args], { encoding: 'utf8' });
    assert.equal(failed.status, 1, failed.stderr + failed.stdout);
    assert.match(failed.stdout, /"dispatchOk":false/);
    assert.equal(fs.readFileSync(statePath, 'utf8'), saved);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
