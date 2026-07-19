import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  renderEmail, renderUsageBlock, extractWhy, summarizeQueue,
  buildPlainLanguageItemPrompt, sanitizePlainLanguageText,
} = require('./autonomous-email-render.js');

const STATS = {
  runId: 'run-x',
  tonight: { usd: 2.13, tokensIn: 150000, tokensOut: 22000, byModel: { 'claude-sonnet-5': { tokensIn: 150000, tokensOut: 22000, usd: 2.13 } } },
  week: { usd: 11.4, tokensIn: 800000, tokensOut: 90000 },
  paceMonthlyUSD: 48.86,
};

const ITEM = {
  name: 'Fix bsc-next tie-break', why: 'Sort order was wrong for equal priorities.',
  summary: 'Reordered the comparator and added a test.', branch: 'auto/fix-bsc-next-abc123',
  usd: 0.42, checks: ['colocated-tests: PASS', 'card-check: PASS'],
  approveUrl: 'https://x/api/autonomous-action?action=approve&sig=a',
  rejectUrl: 'https://x/api/autonomous-action?action=reject&sig=b',
};

test('email carries why-line ABOVE done-line, PASS badge, cost tag, both buttons', () => {
  const html = renderEmail({ items: [ITEM], stats: STATS, awaitingTotal: 1 });
  assert.match(html, /Why:<\/b> Sort order was wrong/);
  assert.match(html, /Done:<\/b> Reordered the comparator/);
  assert.ok(html.indexOf('Why:') < html.indexOf('Done:'), 'why line renders above done line');
  assert.match(html, />PASS</);
  assert.match(html, /~\$0\.42/);
  assert.match(html, /action=approve/);
  assert.match(html, /action=reject/);
});

test('usage block is the 3-row table with model split demoted to grey line', () => {
  const html = renderUsageBlock(STATS, null, {});
  assert.match(html, />Tonight<\/td>/);
  assert.match(html, /\$2\.13/);
  assert.match(html, />This week<\/td>/);
  assert.match(html, /\$11\.40/);
  assert.match(html, />Monthly pace<\/td>/);
  assert.match(html, /~\$48\.86/);
  assert.match(html, /sonnet-5 \$2\.13 \(150k in \/ 22k out\)/);
});

test('NO invented budget: no % without weeklyUSD or an admin spend limit', () => {
  assert.doesNotMatch(renderUsageBlock(STATS, null, {}), /%/);
  assert.doesNotMatch(renderUsageBlock(STATS, null, { weeklyUSD: null }), /%/);
});

test('weeklyUSD configured → % of weekly budget appears', () => {
  const html = renderUsageBlock(STATS, null, { weeklyUSD: 35 });
  assert.match(html, /33% of \$35\/wk budget/);
});

test('admin actuals replace ledger week + loop share broken out; spend limit anchors %', () => {
  const html = renderUsageBlock(STATS, { actualUSD7d: 40.25, spendLimitUSD: 200 }, {});
  assert.match(html, /This week \(account\)/);
  assert.match(html, /\$40\.25/);
  assert.match(html, /20% of \$200 account limit/);
  assert.match(html, /loop's share this week: \$11\.40 \(ledger\)/);
  // configured weeklyUSD outranks the account limit as the anchor
  const html2 = renderUsageBlock(STATS, { actualUSD7d: 40.25, spendLimitUSD: 200 }, { weeklyUSD: 40 });
  assert.match(html2, /101% of \$40\/wk budget/);
});

test('status items live in the footer, not the usage box', () => {
  const html = renderEmail({ items: [], stats: STATS, lastRunNote: 'last run activity 2026-07-13 07:45 UTC', awaitingTotal: 4 });
  const usageStart = html.indexOf('Tonight');
  const footer = html.indexOf('last run activity');
  assert.ok(footer > usageStart, 'footer renders after the usage block');
  assert.match(html, /4 awaiting approval/);
});

test('failed count renders only when nonzero; throttle note appears', () => {
  const none = renderEmail({ items: [], stats: STATS, failedCount: 0, awaitingTotal: 0 });
  assert.doesNotMatch(none, /failed overnight/);
  const some = renderEmail({ items: [], stats: STATS, failedCount: 2, throttled: '9 items already await approval (max 8)', awaitingTotal: 9 });
  assert.match(some, /2 cards failed overnight/);
  assert.match(some, /⚠️ 9 items already await approval/);
});

// ── Plain-language item copy (owner scope-add 2026-07-14) ──────────────────

test('renderItem: plainText present becomes the primary text, technical detail demotes', () => {
  const html = renderEmail({
    items: [{ ...ITEM, plainText: 'Some outlets were showing junk names like "co" instead of the real publication. This fix adds test coverage only, nothing changes on the live site today.' }],
    stats: STATS, awaitingTotal: 1,
  });
  assert.match(html, /Some outlets were showing junk names/);
  // technical detail still present, but demoted (no longer the bold Why:/Done: labels)
  assert.match(html, /Why: Sort order was wrong/);
  assert.match(html, /Done: Reordered the comparator/);
  assert.doesNotMatch(html, /<b>Why:<\/b>/);
  assert.doesNotMatch(html, /<b>Done:<\/b>/);
  // primary text renders before the demoted technical block
  assert.ok(html.indexOf('Some outlets were showing junk names') < html.indexOf('Why: Sort order was wrong'));
});

test('renderItem: no plainText falls back to the old bold Why/Done layout (backward compat)', () => {
  const html = renderEmail({ items: [ITEM], stats: STATS, awaitingTotal: 1 });
  assert.match(html, /<b>Why:<\/b> Sort order was wrong/);
  assert.match(html, /<b>Done:<\/b> Reordered the comparator/);
});

test('renderItem: plainText is html-escaped like every other card-sourced field', () => {
  const html = renderEmail({
    items: [{ ...ITEM, plainText: 'Uses <script>alert(1)</script> & other stuff' }],
    stats: STATS, awaitingTotal: 1,
  });
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /&lt;script&gt;/);
});

test('buildPlainLanguageItemPrompt: carries card context, forbids jargon, asks for exactly 2 sentences', () => {
  const p = buildPlainLanguageItemPrompt({ name: 'Fix garbage slugs', why: 'co.uk hosts produce junk outlet ids', summary: 'Added regression fixtures to provisional-outlet-onboarding.test.mjs' });
  assert.match(p, /Fix garbage slugs/);
  assert.match(p, /co\.uk hosts produce junk outlet ids/);
  assert.match(p, /EXACTLY 2 short sentences/);
  assert.match(p, /no em dashes/);
  assert.match(p, /never function names, file paths/);
});

test('buildPlainLanguageItemPrompt: tolerates missing why/summary', () => {
  const p = buildPlainLanguageItemPrompt({ name: 'X' });
  assert.match(p, /none given/);
});

test('sanitizePlainLanguageText: strips em/en dashes, collapses whitespace, never throws on garbage input', () => {
  assert.equal(sanitizePlainLanguageText('Reviews were wrong — now fixed'), 'Reviews were wrong, now fixed');
  assert.equal(sanitizePlainLanguageText('a  b   c'), 'a b c');
  assert.equal(sanitizePlainLanguageText('trailing space , here'), 'trailing space, here');
  assert.equal(sanitizePlainLanguageText(null), '');
  assert.equal(sanitizePlainLanguageText(undefined), '');
  assert.equal(sanitizePlainLanguageText('  '), '');
});

test('extractWhy pulls the first sentence of the Problem section', () => {
  assert.equal(
    extractWhy('## Problem\nSort order was wrong. It also crashed.\n\n## Evidence\nstuff'),
    'Sort order was wrong.',
  );
  assert.equal(extractWhy(''), null);
  assert.equal(extractWhy('no headings, just text about the card'), 'no headings, just text about the card');
  const long = extractWhy(`## Problem\n${'x'.repeat(400)}\n## Next`);
  assert.ok(long.length <= 220);
});

test('html-escapes card-sourced strings', () => {
  const html = renderEmail({
    items: [{ ...ITEM, name: 'XSS <script>alert(1)</script>', why: 'a & b' }],
    stats: STATS, awaitingTotal: 1,
  });
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /XSS &lt;script&gt;/);
  assert.match(html, /a &amp; b/);
});

// ── 0-planned skip breakdown (night-1 fix #2) ───────────────────────────────

// Mirrors the real 2026-07-13 night-1 queue shape: 30 triaged, 0 planned.
const ZERO_PLAN_QUEUE = {
  generatedAt: '2026-07-13T07:31:58.758Z',
  counts: { total: 6, fetched: 24, candidates: 3, attempt: 0, split: 0, skip: 6, failed: 0 },
  plan: [],
  entries: [
    { card: { name: 'a' }, preFilter: { eligible: false, reason: 'category "Marketing" is human territory' }, decision: 'skip' },
    { card: { name: 'b' }, preFilter: { eligible: false, reason: 'category "Partnerships" is human territory' }, decision: 'skip' },
    { card: { name: 'c' }, preFilter: { eligible: false, reason: 'title is a human action ("Email volunteers")' }, decision: 'skip' },
    { card: { name: 'd' }, preFilter: { eligible: false, reason: 'deny-tag "scoring"' }, decision: 'skip' },
    { card: { name: 'e' }, preFilter: { eligible: true, reason: null }, triage: { eligible: false, size: 'S', reason: 'requires editing src/' }, decision: 'skip' },
    { card: { name: 'f' }, preFilter: { eligible: true, reason: null }, triage: { eligible: false, size: 'M', reason: 'requires editing data/shows.json' }, decision: 'skip' },
  ],
};

test('summarizeQueue buckets skip reasons and produces the unlock line', () => {
  const qs = summarizeQueue(ZERO_PLAN_QUEUE);
  assert.equal(qs.total, 6);
  assert.equal(qs.fetched, 24);
  const byReason = Object.fromEntries(qs.buckets.map(b => [b.reason, b.n]));
  assert.equal(byReason['human territory (marketing/partnerships)'], 2);
  assert.equal(byReason['human-action title (emailing, posting, meeting)'], 1);
  assert.equal(byReason['deny-tagged domain (email/commercial/scoring/ios)'], 1);
  assert.equal(byReason['out of Tier-1 scope (needs src/, data/, or CI changes)'], 2);
  assert.match(qs.unlock, /Tier-1 paths/);
});

test('summarizeQueue is null when work WAS planned or the queue is unusable', () => {
  assert.equal(summarizeQueue({ ...ZERO_PLAN_QUEUE, counts: { ...ZERO_PLAN_QUEUE.counts, attempt: 2 } }), null);
  assert.equal(summarizeQueue(null), null);
  assert.equal(summarizeQueue({}), null);
});

test('0-planned email renders the breakdown; planned email omits it', () => {
  const qs = summarizeQueue(ZERO_PLAN_QUEUE);
  const html = renderEmail({ items: [], stats: STATS, queueSummary: qs, awaitingTotal: 0 });
  assert.match(html, /Why nothing was planned — 6 triaged \(of 24 fetched\), 0 workable/);
  assert.match(html, /human territory \(marketing\/partnerships\)/);
  assert.match(html, /What would unlock work/);
  const withItems = renderEmail({ items: [ITEM], stats: STATS, queueSummary: qs, awaitingTotal: 1 });
  assert.doesNotMatch(withItems, /Why nothing was planned/);
});

// ── run-skip banner (auth pre-flight, night-1 fix #3) ───────────────────────

test('run-skipped note renders as the top red banner', () => {
  const note = 'auth: claude CLI login expired on Mac Studio — run skipped, no cards attempted (401 authentication_error)';
  const html = renderEmail({ items: [], stats: STATS, runSkipped: note, awaitingTotal: 0 });
  assert.match(html, /⛔ auth: claude CLI login expired on Mac Studio/);
  const clean = renderEmail({ items: [], stats: STATS, awaitingTotal: 0 });
  assert.doesNotMatch(clean, /⛔/);
});

test('renderAttentionBlock: empty input renders nothing', () => {
  const { renderAttentionBlock } = require('./autonomous-email-render.js');
  assert.equal(renderAttentionBlock(null), '');
  assert.equal(renderAttentionBlock({ configWarnings: [], failedCards: [], parkedItems: [] }), '');
});

test('renderAttentionBlock: each category renders with its owner action, escaped', () => {
  const { renderAttentionBlock } = require('./autonomous-email-render.js');
  const html = renderAttentionBlock({
    configWarnings: ['size M is enabled but can never be admitted <script>'],
    failedCards: [{ name: 'Byline recovery & cleanup' }],
    parkedItems: [{ name: 'Clean up 10 clusters', size: 'L' }],
  });
  assert.match(html, /3 items stalling the loop/);
  assert.match(html, /&lt;script&gt;/);              // escaped
  assert.match(html, /Byline recovery &amp; cleanup/);
  assert.match(html, /clear the Auto tag/);
  assert.match(html, /sized L/);
  assert.match(html, /interactive session/);
  assert.doesNotMatch(html, /<script>/);
});

test('renderEmail: attention block appears above approval items', () => {
  const { renderEmail } = require('./autonomous-email-render.js');
  const html = renderEmail({
    items: [{ name: 'Some pass card', branch: 'b', usd: 1, checks: [], approveUrl: 'https://x/a', rejectUrl: 'https://x/r' }],
    attention: { failedCards: [{ name: 'Wedged card' }], configWarnings: [], parkedItems: [] },
    stats: { runId: null, tonight: { usd: 0, byModel: {} }, week: { usd: 0 }, paceMonthlyUSD: null },
  });
  const attnIdx = html.indexOf('stalling the loop');
  const itemIdx = html.indexOf('Some pass card');
  assert.ok(attnIdx > -1 && itemIdx > -1 && attnIdx < itemIdx, `attention(${attnIdx}) must precede items(${itemIdx})`);
});
