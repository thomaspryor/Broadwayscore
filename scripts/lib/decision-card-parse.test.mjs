// BRO-6131: the morning digest shows each DECISION NEEDED card as a readable
// card. These use the real BRO-6111 / BRO-6112 text (markdown escapes included).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { cleanOwnerText, parseDecisionDescription, recommendedKey } = require('./decision-card-parse.js');
const { buildDecisionsSection } = require('./owner-decision-notify.js');
const { renderNamedDigestBlock } = require('./autonomous-email-render.js');

const BRO_6111 = `PARKED: owner decision

DECISION NEEDED: Retire the Mac dispatch fleet (cmux + headless jobs, \\~79 supervision files) in favour of cloud board workers?
Why this is your call: cloud-worker-pick lacks attempt memory/retry cap/spend breaker and only takes P0/P1; Mac is \\~33% trouble rate. Trade-off of reliability vs capability.
Option A - Cut over after cloud worker gets caps: more reliable / weeks of work.
Option B - Keep Mac for now: no risk / ongoing Mac-infra failures (\\~241 titles since 08-11).
My recommendation: A, staged, because cloud sessions proved more reliable.
Default: Mac fleet stays.
Context: BRO-4622 plan, BRO-5846.`;

const BRO_6112 = `DECISION NEEDED: Cloud lacks 8 of 13 Tier-1 keys (BRIGHTDATA\\_*, SCRAPINGBEE, BROWSERBASE\\_*, RESEND, ANTHROPIC). Needed to move the cloud Morning email (RESEND) and scraping jobs off the Mac.
Why this is your call: pasting production secrets into the cloud environment is a security/spend decision.
Option A - Add RESEND only: unblocks the morning email / scraping stays on Mac.
Option B - Add all 8 in [claude.ai](<http://claude.ai>) environment settings: full cloud move / larger secret exposure.
My recommendation: A now, B later.
Default: the three Mac email jobs keep running.`;

test('cleanOwnerText strips markdown escapes and wrapped links', () => {
  assert.equal(cleanOwnerText('BRIGHTDATA\\_*, \\~79 files'), 'BRIGHTDATA_*, ~79 files');
  assert.equal(cleanOwnerText('in [claude.ai](<http://claude.ai>) settings'), 'in claude.ai settings');
  assert.equal(cleanOwnerText('**bold**  and\n spaced'), 'bold and spaced');
});

test('parses question, why, options, recommendation and default (full, untruncated)', () => {
  const d = parseDecisionDescription(BRO_6111);
  assert.match(d.question, /^Retire the Mac dispatch fleet \(cmux \+ headless jobs, ~79 supervision files\) in favour of cloud board workers\?$/);
  assert.match(d.why, /^cloud-worker-pick lacks/);
  assert.deepEqual(d.options.map((o) => o.key), ['A', 'B']);
  assert.equal(d.options[0].name, 'Cut over after cloud worker gets caps');
  assert.equal(d.options[0].upside, 'more reliable');
  assert.equal(d.options[0].downside, 'weeks of work.');
  assert.equal(d.defaultLine, 'Mac fleet stays.');
  assert.equal(recommendedKey(d.recommendation, d.options), 'A');
});

test('a card with no options or fields still parses its question; no marker returns null', () => {
  const d = parseDecisionDescription('DECISION NEEDED: Is Cyrus Team Cloud still used?');
  assert.equal(d.question, 'Is Cyrus Team Cloud still used?');
  assert.deepEqual(d.options, []);
  assert.equal(parseDecisionDescription('just a normal card'), null);
  assert.equal(recommendedKey('Neither', []), null);
});

test('digest section carries the parsed card, and every row renders a visible link and button', () => {
  const issues = [
    { identifier: 'BRO-6111', title: 'DECISION NEEDED: Cut over', url: 'https://linear.app/x/issue/BRO-6111', description: BRO_6111, createdAt: '2026-10-20T00:00:00Z' },
    { identifier: 'BRO-6112', title: 'DECISION NEEDED: Add secrets', url: 'https://linear.app/x/issue/BRO-6112', description: BRO_6112, createdAt: '2026-10-24T00:00:00Z' },
  ];
  const section = buildDecisionsSection(issues, { now: new Date('2026-10-24T12:00:00Z') });
  assert.equal(section.items[0].decision.question.startsWith('Retire the Mac'), true);
  const html = renderNamedDigestBlock('Decisions waiting on you', section, { actionCards: true });
  // Full question, no truncation ellipsis, no markdown escape leakage.
  assert.doesNotMatch(html, /\\_|\\~|…/);
  assert.match(html, /BRIGHTDATA_\*/);
  // Options, pick, default, age.
  assert.match(html, /<b>A\.<\/b> Cut over after cloud worker gets caps/);
  assert.match(html, /my pick/);
  assert.match(html, /If you do nothing:<\/b> Mac fleet stays/);
  assert.match(html, /waiting 4d/);
  // One real button per card, titles are visibly links (blue, underlined).
  assert.equal((html.match(/background-color:#1d4ed8/g) || []).length, 2);
  assert.match(html, /href="https:\/\/linear\.app\/x\/issue\/BRO-6111"[^>]*text-decoration:underline/);
  assert.doesNotMatch(html, /color:#333;text-decoration:none/);
});

test('non-decision rows (review queue) split the id, show a button, and drop unsafe urls', () => {
  const html = renderNamedDigestBlock('Review queue', {
    bannerText: '2 finished items waiting for your review',
    items: [
      { title: 'BRO-5596: Dispatch flow is DEAD', detail: 'finished; idle in review 4d', url: 'https://linear.app/x/issue/BRO-5596' },
      { title: 'BRO-1: bad link', detail: 'x', url: 'javascript:alert(1)' },
    ],
    moreCount: 0,
  }, { actionCards: true, showBanner: true });
  assert.match(html, />BRO-5596<\/span>/);
  assert.match(html, />Open →<\/a>/);
  assert.doesNotMatch(html, /javascript:/);
  assert.match(html, /2 finished items waiting for your review/);
});

test('a context URL in the question is not the button target; a signed owner link is; long questions get the card title as headline', () => {
  const quoted = { identifier: 'BRO-6110', title: 'DECISION NEEDED: Is Cyrus Team Cloud still used?', url: 'https://linear.app/x/issue/BRO-6110', createdAt: '2026-10-21T00:00:00Z',
    description: `DECISION NEEDED: Do you still use Cyrus? The relay https://cyrus-relay.vercel.app now returns 404 so the drain job logs fetch failed every tick and has done for weeks now.\nOption A - Retire: x / y\nOption B - Keep: x / y` };
  const signed = { identifier: 'BRO-7', title: 'DECISION NEEDED: Renew Gmail login', url: 'https://linear.app/x/issue/BRO-7', createdAt: '2026-10-24T00:00:00Z',
    description: 'DECISION NEEDED: Tap https://broadwayscorecard.com/api/admin/gmail-reauth?e=1793000000&s=0123456789abcdef0123456789abcdef and press Allow' };
  const section = buildDecisionsSection([quoted, signed], { now: new Date('2026-10-24T12:00:00Z') });
  const byId = Object.fromEntries(section.items.map((i) => [i.identifier, i]));
  assert.equal(byId['BRO-6110'].url, 'https://linear.app/x/issue/BRO-6110');
  assert.equal(byId['BRO-6110'].actionLabel, undefined);
  assert.match(byId['BRO-7'].url, /^https:\/\/broadwayscorecard\.com\/api\/admin\/gmail-reauth\?e=1793000000&s=0123456789abcdef/);
  assert.equal(byId['BRO-7'].cardUrl, 'https://linear.app/x/issue/BRO-7');
  const html = renderNamedDigestBlock('Decisions', section, { actionCards: true });
  assert.match(html, />Is Cyrus Team Cloud still used\?<\/a>/);
  assert.match(html, /Do you still use Cyrus\? The relay/);
  assert.match(html, />Tap to do this \u2192<\/a>/);
  assert.match(html, /see the full card/);
});

// ── ship-check findings (BRO-6131) ───────────────────────────────────────────
const { extractDecisionQuestion } = require('./owner-decision-notify.js');

test('the card headline is the same question the decision email uses (placeholder, settled, numbered, code)', () => {
  const cases = {
    template: '- DECISION NEEDED: <what, one sentence>\nDECISION NEEDED: Ship the real thing?\nOption A - go: x / y',
    settled: 'DECISION NEEDED: answered: we chose A\nDECISION NEEDED: Is the second one open?',
    numbered: '1. DECISION NEEDED: Pick X?\nOption A - x: a / b',
    fenced: '```\nDECISION NEEDED: inside a code block\n```\nDECISION NEEDED: Outside the block?',
  };
  const expected = { template: 'Ship the real thing?', settled: 'Is the second one open?', numbered: 'Pick X?', fenced: 'Outside the block?' };
  for (const [name, text] of Object.entries(cases)) {
    assert.equal(extractDecisionQuestion(text), expected[name], `${name}: extractor`);
    assert.equal(parseDecisionDescription(text).question, expected[name], `${name}: card`);
  }
});

test('hostile text stays cheap: option and link regexes do not blow up', () => {
  const t0 = Date.now();
  parseDecisionDescription(`DECISION NEEDED: q?\nOption A${' '.repeat(50000)}x`);
  cleanOwnerText('['.repeat(50000));
  cleanOwnerText(`[${'a'.repeat(50000)}](`);
  assert.ok(Date.now() - t0 < 500, `took ${Date.now() - t0}ms`);
});

test('"A staged rollout" is the article, not option A; real picks still resolve', () => {
  const opts = [{ key: 'A' }, { key: 'B' }];
  assert.equal(recommendedKey('A staged rollout of B, because it is safer.', opts), null);
  assert.equal(recommendedKey('A, staged, because X', opts), 'A');
  assert.equal(recommendedKey('A now, B later.', opts), 'A');
  assert.equal(recommendedKey('Option B because Y', opts), 'B');
  assert.equal(recommendedKey('A \u2014 now, then B', opts), 'A');
  assert.equal(recommendedKey('A (staged), because X', opts), 'A');
  assert.equal(recommendedKey('B', opts), 'B');
  assert.equal(recommendedKey('C because Z', opts), null);
});

test('renderActionCard escapes hostile text and drops unsafe urls (no button without a safe link)', () => {
  const evil = '<img src=x onerror=alert(1)>';
  const html = renderNamedDigestBlock('Decisions', {
    items: [{
      title: evil, url: 'javascript:alert(1)', cardUrl: 'data:text/html,x', identifier: evil, ageDays: 3,
      decision: { question: evil, why: evil, options: [{ key: 'A', name: evil, upside: evil, downside: evil }], recommendation: `A ${evil}`, defaultLine: evil },
    }],
  }, { actionCards: true });
  assert.doesNotMatch(html, /<img|javascript:|data:text/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(html, /background-color:#1d4ed8/, 'no safe URL, no button');
});

// ── what-else cousins (BRO-6131) ─────────────────────────────────────────────
const digestSender = require('../send-morning-digest.js');

test('mergeNeedsYouSections keeps cardUrls from both sides (a hidden decision that is also In Review is not counted twice)', () => {
  const cmux = { generatedAt: 'x', bannerText: '1 tab', items: [{ title: 't' }], moreCount: 0 };
  const linear = { generatedAt: 'y', bannerText: '2 cards', items: [{ title: 'a' }], moreCount: 1, cardUrls: ['https://linear.app/x/BRO-1', 'https://linear.app/x/BRO-2'] };
  assert.deepEqual(digestSender.mergeNeedsYouSections(cmux, linear).cardUrls, linear.cardUrls);
  assert.equal(digestSender.mergeNeedsYouSections(null, linear), linear);
  assert.equal(digestSender.mergeNeedsYouSections(cmux, null), cmux);
});

test('whole email: every link above Technical details is visibly a link or a button (owner complaint 2026-10-24)', () => {
  const now = new Date('2026-10-24T11:30:00Z');
  const card = (id) => ({ identifier: id, title: `DECISION NEEDED: ${id}`, url: `https://linear.app/x/issue/${id}`, createdAt: '2026-10-22T00:00:00Z', description: `DECISION NEEDED: Question ${id}?\nOption A - a: x / y\nOption B - b: x / y\nMy recommendation: A because z.\nDefault: nothing.` });
  const html = digestSender.buildHtml({
    sections: {
      health: { errors: [], warns: [], queued: [{ title: 'Tour candidate', description: 'd', url: 'https://example.com/v', decision: true, decisionPrompt: 'Add it?' }] },
      needsYou: buildDecisionsSection([card('BRO-1'), card('BRO-2')], { now }),
      awaitingOwner: { bannerText: '1 waiting', items: [{ title: 'BRO-3: approve', detail: 'Waiting', url: 'https://linear.app/x/issue/BRO-3' }] },
      inReviewBacklog: { bannerText: '1 parked', moreCount: 0, items: [{ title: 'BRO-4: finished', detail: 'idle 4d', url: 'https://linear.app/x/issue/BRO-4' }] },
    },
    autofixRows: [], now,
  });
  const cut = html.indexOf('>Technical details<');
  assert.ok(cut > 0, 'the Technical details heading marks where the owner-facing top ends');
  const top = html.slice(0, cut);
  // Gmail's display sanitizer drops the `background:` shorthand (button and card fills vanish,
  // leaving white text on a pale card, owner report 2026-10-24); `background-color:` survives.
  assert.doesNotMatch(top, /background:/, 'use background-color, never the background shorthand, above Technical details');
  const anchors = top.match(/<a\b[^>]*>/g) || [];
  assert.ok(anchors.length >= 8, `expected many links above Technical details, got ${anchors.length}`);
  for (const a of anchors) {
    const hidden = /text-decoration:none/.test(a) && !/background(?:-color)?:/.test(a);
    assert.equal(hidden, false, `camouflaged link: ${a.slice(0, 120)}`);
  }
});

// ── final-commit review (BRO-6131): which URL in a question becomes the button ──
test('button link: only /api/admin/ links on this site count, cleaned of wrappers, read from the uncapped question', () => {
  const mk = (n, text) => ({ identifier: `BRO-${n}`, title: `t${n}`, url: `https://linear.app/x/BRO-${n}`, createdAt: new Date().toISOString(), description: `DECISION NEEDED: ${text}` });
  const link = 'https://broadwayscorecard.com/api/admin/gmail-reauth?e=1793000000&s=0123456789abcdef0123456789abcdef';
  const cases = [
    ['trailing period', `Tap ${link}.`, link],
    ['double quotes', `Tap "${link}" now`, link],
    ['single quotes', `Tap '${link}' now`, link],
    ['bold wrapper', `Tap **${link}** now`, link],
    ['markdown self-link', `Tap [${link}](<${link}>) now`, link],
    ['parenthesised', `Tap (${link}) now`, link],
    ['two links, first wins', `Tap ${link} or ${link.replace('gmail-reauth', 'mezzanine-token')}`, link],
    ['public api path is context', 'Is https://broadwayscorecard.com/api/health/drift down?', null],
    ['site page is context', 'Is https://broadwayscorecard.com/show/hamilton right?', null],
    ['dead relay is context', 'Is https://cyrus-relay.vercel.app still used?', null],
    ['look-alike host', 'Tap https://broadwayscorecard.com.evil.io/api/admin/x?e=1793000000&s=abc', null],
    ['long question, link past the 220-char display cap is still whole', `${'Context sentence. '.repeat(14)}Tap ${link} and press Allow`, link],
  ];
  const section = buildDecisionsSection(cases.map(([name, text], i) => mk(i, text)), { now: new Date(), max: 20 });
  cases.forEach(([name, , expected], i) => {
    const it = section.items.find((x) => x.identifier === `BRO-${i}`);
    assert.equal(it.url, expected || `https://linear.app/x/BRO-${i}`, name);
    assert.equal(it.actionLabel, expected ? 'Tap to do this →' : undefined, `${name}: label`);
  });
});
