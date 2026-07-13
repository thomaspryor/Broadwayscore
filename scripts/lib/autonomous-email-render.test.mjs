import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { renderEmail, renderUsageBlock, extractWhy } = require('./autonomous-email-render.js');

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
