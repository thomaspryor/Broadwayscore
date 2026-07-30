import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  renderEmail, renderItem, renderUsageBlock, renderRecheckBlock, extractWhy, summarizeQueue,
  buildPlainLanguageItemPrompt, sanitizePlainLanguageText,
  renderHealthDigestBlock, healthIssueCount,
  renderNamedDigestBlock, renderDailyDigestBlock, renderOpeningDigestBlock, renderRedditDigestBlock,
} = require('./autonomous-email-render.js');
const { buildDispatchUrl, verifyDispatchSignature, selectOpenDispatchCard, attachHealthFixUrls } = require('./dispatch-link.js');

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
  assert.equal(byReason["outside the loop's write scope (needs excluded paths or human judgment)"], 2);
  assert.match(qs.unlock, /allowed paths/);
});

test('summarizeQueue is null when work WAS planned or the queue is unusable', () => {
  assert.equal(summarizeQueue({ ...ZERO_PLAN_QUEUE, counts: { ...ZERO_PLAN_QUEUE.counts, attempt: 2 } }), null);
  assert.equal(summarizeQueue(null), null);
  assert.equal(summarizeQueue({}), null);
});

test('0-planned email renders the breakdown; planned email omits it', () => {
  const qs = summarizeQueue(ZERO_PLAN_QUEUE);
  const html = renderEmail({ items: [], stats: STATS, queueSummary: qs, awaitingTotal: 0 });
  assert.match(html, /Why nothing was planned: 6 triaged \(of 24 fetched\), 0 workable/);
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

// #476: a monitor-night executor skip is a deliberate deferral, not a
// failure — it gets its own amber banner distinct from runSkipped's red one,
// and the deferred-work count must survive into the rendered HTML.
test('executor-skipped note renders as an amber banner, distinct from run-skipped', () => {
  const note = 'executor skipped (monitor night): 5 planned attempts deferred to tomorrow';
  const html = renderEmail({ items: [], stats: STATS, executorSkipped: note, awaitingTotal: 0 });
  assert.match(html, /⏸ executor skipped \(monitor night\): 5 planned attempts deferred/);
  assert.doesNotMatch(html, /⛔/);
  const clean = renderEmail({ items: [], stats: STATS, awaitingTotal: 0 });
  assert.doesNotMatch(clean, /⏸/);
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
    attemptMemoryParked: [{ name: 'Flaky migration card', reason: 'parked: failed 2x unchanged (fail 1 | fail 2) — edit the card or clear the park to retry' }],
  });
  assert.match(html, /4 items stalling the loop/);
  assert.match(html, /&lt;script&gt;/);              // escaped
  assert.match(html, /Byline recovery &amp; cleanup/);
  assert.match(html, /clear the Auto tag/);
  assert.match(html, /sized L/);
  assert.match(html, /interactive session/);
  assert.match(html, /Flaky migration card — parked: failed 2x unchanged/);
  assert.match(html, /re-enter the pool, or clear its park/);
  assert.doesNotMatch(html, /<script>/);
});

test('renderAttentionBlock: attemptMemoryParked alone still renders (no crash on missing field elsewhere)', () => {
  const { renderAttentionBlock } = require('./autonomous-email-render.js');
  const html = renderAttentionBlock({
    attemptMemoryParked: [{ name: 'Solo parked card', reason: 'parked: failed 2x unchanged — edit the card or clear the park to retry' }],
  });
  assert.match(html, /1 item stalling the loop/);
  assert.match(html, /Solo parked card/);
});

test('attentionCountOf counts attemptMemoryParked, but actionableAttentionCountOf excludes it (ship-check: routine skip, not an owner decision)', () => {
  const { attentionCountOf, actionableAttentionCountOf } = require('./autonomous-email-render.js');
  const attention = {
    configWarnings: [],
    failedCards: [],
    parkedItems: [],
    attemptMemoryParked: [{ name: 'a' }, { name: 'b' }],
  };
  assert.equal(attentionCountOf(attention), 2);
  assert.equal(actionableAttentionCountOf(attention), 0);
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

// ── One-line summary + demoted context divider (card #409 reformat) ─────────

test('renderSummaryLine: items → "N fixes waiting for your tap", cost, "nothing broken" when clean', () => {
  const { renderSummaryLine } = require('./autonomous-email-render.js');
  const html = renderSummaryLine({ items: [ITEM, ITEM], stats: STATS });
  assert.match(html, /2 fixes waiting for your tap/);
  assert.match(html, /\$2\.13 overnight/);
  assert.match(html, /nothing broken/);
});

test('renderSummaryLine: singular fix, and 0-item morning reads calm', () => {
  const { renderSummaryLine } = require('./autonomous-email-render.js');
  assert.match(renderSummaryLine({ items: [ITEM], stats: STATS }), /1 fix waiting for your tap/);
  assert.match(renderSummaryLine({ items: [], stats: STATS }), /Nothing needs you this morning/);
});

test('renderSummaryLine: failures/attention/stuck-digest flip health to "N things to look at"', () => {
  const { renderSummaryLine } = require('./autonomous-email-render.js');
  assert.match(renderSummaryLine({ items: [], stats: STATS, failedCount: 2 }), /2 things to look at below/);
  assert.match(renderSummaryLine({ items: [], stats: STATS, attention: { failedCards: [{ name: 'x' }], configWarnings: [], parkedItems: [] } }), /1 thing to look at below/);
  assert.doesNotMatch(renderSummaryLine({ items: [], stats: STATS, failedCount: 2 }), /nothing broken/);
});

test('renderSummaryLine: run-skipped headline suppresses the health word', () => {
  const { renderSummaryLine } = require('./autonomous-email-render.js');
  const html = renderSummaryLine({ items: [], stats: STATS, runSkipped: 'auth: login expired' });
  assert.match(html, /The overnight run did not finish/);
  assert.doesNotMatch(html, /nothing broken/);
});

test('digestStuckCount: counts each stuck signal, 0 when clean or absent', () => {
  const { digestStuckCount } = require('./autonomous-email-render.js');
  assert.equal(digestStuckCount(null), 0);
  assert.equal(digestStuckCount({ commits: { reviewDelta: -5 }, stuck: {} }), 0);
  assert.equal(digestStuckCount({ commits: { reviewDelta: -152 }, stuck: { worktrees: ['a'] } }), 2);
});

test('renderEmail: summary line leads, and ALL informational context sits below the divider', () => {
  const qs = summarizeQueue(ZERO_PLAN_QUEUE);
  const html = renderEmail({ items: [ITEM], stats: STATS, queueSummary: qs, awaitingTotal: 1, lastRunNote: 'last run activity 2026-07-24 08:00 UTC' });
  const summaryIdx = html.indexOf('1 fix waiting for your tap');
  const itemIdx = html.indexOf(ITEM.name);
  const dividerIdx = html.indexOf('For your records');
  const usageIdx = html.indexOf('Tonight');
  const footerIdx = html.indexOf('last run activity');
  // summary → item → divider → usage → footer, strictly in that order
  assert.ok(summaryIdx > -1 && summaryIdx < itemIdx, 'summary leads the item');
  assert.ok(itemIdx < dividerIdx, 'approval item sits above the divider');
  assert.ok(dividerIdx < usageIdx, 'usage/cost sits below the divider');
  assert.ok(usageIdx < footerIdx, 'footer is last');
});

// ── UI evidence gate (S2-T6) ────────────────────────────────────────────────

const uiItem = (extra = {}) => ({
  name: 'Fix the score badge wrap',
  summary: 'adjusted the badge width',
  branch: 'auto/score-badge-wrap-ab12',
  usd: 1.2,
  checks: ['tsc: PASS', 'next lint: PASS', 'next build: PASS'],
  approveUrl: 'https://broadwayscorecard.com/approve?x=1',
  rejectUrl: 'https://broadwayscorecard.com/reject?x=1',
  ui: true,
  ...extra,
});

test('a UI item with NO screenshots gets no approve link and says why', () => {
  const html = renderItem(uiItem());
  assert.ok(!html.includes('https://broadwayscorecard.com/approve?x=1'), 'approve link must be withheld');
  assert.ok(!/>Approve</.test(html), 'approve button must be absent');
  assert.ok(html.includes('could not take pictures of it'));
  assert.ok(html.includes('tap Reject'), 'gives an action the owner can actually take from the phone');
  assert.ok(html.includes('npm run preview-branch auto/score-badge-wrap-ab12'), 'gives a copy-pasteable command, not "open the branch"');
  assert.ok(html.includes('https://broadwayscorecard.com/reject?x=1'), 'reject stays available');
});

test('a UI item WITH screenshots keeps its approve link and lists them', () => {
  const html = renderItem(uiItem({ screenshots: ['data/audit/autonomous-ui/x/home-390.png', 'data/audit/autonomous-ui/x/home-1280.png'] }));
  assert.ok(html.includes('https://broadwayscorecard.com/approve?x=1'));
  assert.ok(html.includes('home-390.png') && html.includes('home-1280.png'));
  assert.ok(!html.includes('could not take pictures of it'));
});

test('a non-UI item is unaffected by the gate', () => {
  const html = renderItem(uiItem({ ui: false }));
  assert.ok(html.includes('https://broadwayscorecard.com/approve?x=1'));
  assert.ok(!html.includes('could not take pictures of it'));
});

// ── Acceptance recheck section (S3-T4) + report ordering (S4-T2/T3) ─────────

const RECHECK = {
  counts: { pass: 2, fail: 1, unverifiable: 1, skipped: 0 },
  lines: [
    'Fix the score badge: still works',
    'Byline recovery: its own check does not pass any more',
    'Email copy tweak: no way to check this automatically',
    'Venue sweep: still works',
  ],
};

test('recheck block states the counts and labels itself as watching only', () => {
  const html = renderRecheckBlock(RECHECK);
  assert.ok(html.includes('2 still work'));
  assert.ok(html.includes('1 no longer pass their own check'));
  assert.ok(html.includes("1 can't be checked automatically"));
  assert.ok(html.includes('still on trial'), 'a shadow signal must say it is a shadow signal');
  assert.ok(html.includes('You do not need to do anything'), 'and must say what the owner should do about it');
  assert.ok(html.includes('its own check does not pass any more'));
});

test('recheck block renders nothing when there is nothing to report', () => {
  assert.equal(renderRecheckBlock(null), '');
  assert.equal(renderRecheckBlock({ counts: {}, lines: [] }), '');
});

test('recheck block caps the visible lines and counts the rest', () => {
  const html = renderRecheckBlock({ counts: { pass: 8 }, lines: Array.from({ length: 8 }, (_, i) => `Card ${i}: still works`) });
  assert.ok(html.includes('Card 4: still works'));
  assert.ok(!html.includes('Card 5: still works'));
  assert.ok(html.includes('+3 more'));
});

test('email order: the tap items come BEFORE the divider, recheck and usage after', () => {
  const html = renderEmail({
    items: [{ name: 'Fix A', summary: 's', branch: 'auto/a', usd: 1, checks: [], approveUrl: 'https://x/a', rejectUrl: 'https://x/r' }],
    recheck: RECHECK,
    prunedCount: 4,
    stats: STATS,
    awaitingTotal: 1,
  });
  const iAction = html.indexOf('Fix A');
  const iDivider = html.indexOf('For your records');
  const iRecheck = html.indexOf('Finished work re-checked');
  const iUsage = html.indexOf('Monthly pace');
  assert.ok(iAction > 0 && iDivider > iAction, 'the approve item must be above the divider');
  assert.ok(iRecheck > iDivider, 'recheck is context, not action');
  assert.ok(iUsage > iRecheck, 'cost detail sits last');
});

test('the prune count line appears below the divider when a sweep closed tabs', () => {
  const html = renderEmail({ items: [], prunedCount: 3, stats: STATS, awaitingTotal: 0 });
  assert.ok(html.includes('Closed 3 finished tabs'));
  assert.ok(html.indexOf('Closed 3 finished tabs') > html.indexOf('For your records'));
});

test('no prune line when nothing was closed', () => {
  assert.ok(!renderEmail({ items: [], prunedCount: 0, stats: STATS, awaitingTotal: 0 }).includes('finished tab'));
  assert.ok(!renderEmail({ items: [], stats: STATS, awaitingTotal: 0 }).includes('finished tab'));
});

test('the more-awaiting counter names everything past the item cap', () => {
  const html = renderEmail({
    items: [{ name: 'A', branch: 'auto/a', usd: 0, checks: [], approveUrl: 'https://x/a', rejectUrl: 'https://x/r' }],
    moreAwaiting: 4, stats: STATS, awaitingTotal: 5,
  });
  assert.ok(html.includes('+4 more items awaiting approval'));
});

// ── Merged digest (card #364 — owner decision 2026-07-26: one scheduled
// morning email instead of the standalone BSC URGENT/Daily digest) ─────────

test('renderHealthDigestBlock: nothing to render without a snapshot', () => {
  assert.equal(renderHealthDigestBlock(null), '');
});

test('renderHealthDigestBlock: all-clear snapshot renders a calm passed line', () => {
  const html = renderHealthDigestBlock({ subject: 'BSC Daily: All clear (27/27 passed)', errors: [], warns: [], passedCount: 27 });
  assert.match(html, /Site health: all 27 checks passed/);
});

test('renderHealthDigestBlock: escalated URGENT snapshot lists errors and the day count in red', () => {
  const health = {
    subject: 'BSC URGENT (day 6): 2 unresolved errors',
    bannerText: '2 errors, 1 warning',
    consecutiveErrorDays: 6,
    errors: [{ name: 'Data: cookie expiration', message: 'The Stage cookie expired' }, { name: 'Pipeline: stuck work', message: '5 shows stuck' }],
    warns: [{ name: 'SEO: health', message: 'field LCP still red' }],
    autoFixedCount: 1,
  };
  const html = renderHealthDigestBlock(health);
  assert.match(html, /color:#dc2626/);
  assert.match(html, /\(day 6\)/);
  assert.match(html, /Data: cookie expiration/);
  assert.match(html, /The Stage cookie expired/);
  assert.match(html, /1 auto-fixed overnight/);
});

test('renderHealthDigestBlock: (a) each ERROR row carries a signed Fix-this link; warnings never get one', () => {
  const secret = 'test-secret';
  const exp = 1900000000;
  const fixUrl = buildDispatchUrl({
    conditionKey: 'health-check:Data: cookie expiration',
    title: 'BSC Daily: Data: cookie expiration',
    exp, secret, baseUrl: 'https://broadwayscorecard.com',
  });
  const html = renderHealthDigestBlock({
    subject: 'BSC Daily: 1 unresolved error',
    errors: [{ name: 'Data: cookie expiration', message: 'The Stage cookie expired', fixUrl }],
    warns: [{ name: 'SEO: health', message: 'field LCP still red' }],
  });
  assert.match(html, /Fix this →/);
  // href is HTML-escaped like every other card-sourced URL (& → &amp;)
  const escapedUrl = fixUrl.replace(/&/g, '&amp;');
  assert.match(html, new RegExp(`href="${escapedUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`));
  // only ONE Fix-this link renders — the warning row must not get one
  assert.equal((html.match(/Fix this →/g) || []).length, 1);
});

test('renderHealthDigestBlock: an error with no fixUrl renders with no Fix-this link (backward compatible)', () => {
  const html = renderHealthDigestBlock({
    subject: 'BSC Daily: 1 unresolved error',
    errors: [{ name: 'Data: cookie expiration', message: 'expired' }],
    warns: [],
  });
  assert.doesNotMatch(html, /Fix this →/);
});

test('dispatch-link: (b) a tampered signature is rejected', () => {
  const secret = 'test-secret';
  const exp = 1900000000;
  const conditionKey = 'health-check:Data: cookie expiration';
  const title = 'BSC Daily: Data: cookie expiration';
  const url = buildDispatchUrl({ conditionKey, title, exp, secret, baseUrl: 'https://x' });
  const sig = new URL(url).searchParams.get('sig');

  assert.equal(verifyDispatchSignature({ conditionKey, title, exp, secret, sig }), true);
  // tamper the conditionKey after the fact — same class of attack the
  // approve/reject/revert verifier guards against
  assert.equal(verifyDispatchSignature({ conditionKey: 'health-check:something-else', title, exp, secret, sig }), false);
  // tamper the signature itself
  const tampered = sig.slice(0, -1) + (sig.slice(-1) === '0' ? '1' : '0');
  assert.equal(verifyDispatchSignature({ conditionKey, title, exp, secret, sig: tampered }), false);
  // truncated-hex + junk suffix must not silently decode back to the valid sig
  assert.equal(verifyDispatchSignature({ conditionKey, title, exp, secret, sig: `${sig}JUNK` }), false);
  // wrong secret
  assert.equal(verifyDispatchSignature({ conditionKey, title, exp, secret: 'wrong-secret', sig }), false);
});

test('dispatch-link: description travels in the signed message — tampering it is caught too', () => {
  const secret = 'test-secret';
  const exp = 1900000000;
  const conditionKey = 'health-check:Sync: cast coverage';
  const title = 'BSC Daily: Sync: cast coverage';
  const url = buildDispatchUrl({ conditionKey, title, description: '29 empty cast: The Lost Boys', exp, secret, baseUrl: 'https://x' });
  const sig = new URL(url).searchParams.get('sig');
  const description = new URL(url).searchParams.get('description');
  assert.equal(description, '29 empty cast: The Lost Boys');
  assert.equal(verifyDispatchSignature({ conditionKey, title, description, exp, secret, sig }), true);
  // a swapped description must invalidate the signature — the dispatched
  // session's context (what to actually fix) is part of the signed payload,
  // not free-floating query-string text an attacker could rewrite.
  assert.equal(verifyDispatchSignature({ conditionKey, title, description: 'something else entirely', exp, secret, sig }), false);
});

test('dispatch-link: (c) a second click within cooldown is a no-op — selectOpenDispatchCard finds the still-open card', () => {
  // "In progress" or "Not started" means a session is already on it (or
  // about to be) — a repeat tap must be a no-op, not a second dispatch.
  assert.deepEqual(
    selectOpenDispatchCard([{ id: '1', url: 'https://notion.so/1', status: 'In progress', action: null }]),
    { id: '1', url: 'https://notion.so/1', status: 'In progress', action: null }
  );
  assert.deepEqual(
    selectOpenDispatchCard([{ id: '2', url: 'https://notion.so/2', status: 'Not started', action: null }]),
    { id: '2', url: 'https://notion.so/2', status: 'Not started', action: null }
  );
  // resolved cards (Done/Paused, Action cleared) don't block a fresh
  // dispatch — a recurred condition is a NEW incident, same semantics as
  // owner-alert-router's resolveCondition().
  assert.equal(selectOpenDispatchCard([{ id: '3', url: 'x', status: 'Done', action: null }]), null);
  assert.equal(selectOpenDispatchCard([{ id: '4', url: 'x', status: 'Paused', action: null }]), null);
  assert.equal(selectOpenDispatchCard([]), null);
});

test('dispatch-link: a card manually Paused while Action is still set counts as open (poller runs on Action alone)', () => {
  // scripts/notion-action-poll.js's getActionableCards() filters ONLY on
  // `Action is-not-empty` and never reads Status — a card someone paused
  // while Action=Fix is still queued WILL still run on the poller's next
  // tick. Treating it as "resolved" here would let a second tap file a
  // SECOND Fix card for the same condition (ship-check adversarial finding,
  // codex 2026-07-30).
  const paused = { id: '5', url: 'https://notion.so/5', status: 'Paused', action: 'Fix' };
  assert.deepEqual(selectOpenDispatchCard([paused]), paused);
});

test('renderHealthDigestBlock: queued digest-router items render (never silently dropped after drainDigestQueue)', () => {
  const html = renderHealthDigestBlock({
    subject: 'BSC Daily: All clear (27/27 passed)', errors: [], warns: [], passedCount: 27,
    queued: [{ title: 'Credits: ScrapingDog', description: 'balance below 10%', severity: 'warning' }],
    generatedAt: '2026-07-26T06:50:00.000Z',
  });
  assert.match(html, /Credits: ScrapingDog/);
  assert.match(html, /balance below 10%/);
  assert.match(html, /as of 2026-07-26 06:50 UTC/);
});

test('renderHealthDigestBlock: a queued item url renders as a clickable link (regional go-live needs click-through)', () => {
  const html = renderHealthDigestBlock({
    subject: 'BSC Daily: All clear (27/27 passed)', errors: [], warns: [], passedCount: 27,
    queued: [{
      title: 'The Family Album @ La Jolla Playhouse — regional tryout live and scoring',
      description: 'Auto-promoted from an aggregator roundup.',
      severity: 'info',
      url: 'https://broadwayscorecard.com/show/the-family-album-regional-2026',
    }],
  });
  assert.match(html, /href="https:\/\/broadwayscorecard\.com\/show\/the-family-album-regional-2026"/);
  assert.match(html, /The Family Album @ La Jolla Playhouse/);
});

test('renderHealthDigestBlock: a non-http queued url is not rendered as a link (no javascript:/data: in the inbox)', () => {
  for (const bad of ['javascript:alert(1)', 'data:text/html,<script>x</script>', 'ftp://example.com/x', 42]) {
    const html = renderHealthDigestBlock({
      subject: 'BSC Daily: All clear (27/27 passed)', errors: [], warns: [], passedCount: 27,
      queued: [{ title: 'Sketchy', description: 'd', url: bad }],
    });
    assert.match(html, /Sketchy/, `title still renders for url=${String(bad)}`);
    assert.doesNotMatch(html, /<a href=/, `no anchor emitted for url=${String(bad)}`);
  }
});

test('renderHealthDigestBlock: a corrupted queued entry (null/malformed) is skipped, never crashes the render', () => {
  assert.doesNotThrow(() => renderHealthDigestBlock({
    subject: 'BSC Daily: All clear (27/27 passed)', errors: [], warns: [], passedCount: 27,
    queued: [null, { title: 'Real Alert', description: 'still shows' }, undefined],
  }));
  const html = renderHealthDigestBlock({
    subject: 'BSC Daily: All clear (27/27 passed)', errors: [], warns: [], passedCount: 27,
    queued: [null, { title: 'Real Alert', description: 'still shows' }, undefined],
  });
  assert.match(html, /Real Alert/);
});

test('healthIssueCount: sums errors + warns, 0 when absent', () => {
  assert.equal(healthIssueCount(null), 0);
  assert.equal(healthIssueCount({ errors: [{ name: 'a' }], warns: [{ name: 'b' }, { name: 'c' }] }), 3);
});

test('renderEmail: merged digest — site health block appears below the divider, errors bump "N things to look at"', () => {
  const health = {
    subject: 'BSC URGENT (day 3): 1 unresolved error',
    bannerText: '1 error',
    consecutiveErrorDays: 3,
    errors: [{ name: 'Data: cookie expiration', message: 'The Stage cookie expired' }],
    warns: [],
  };
  const html = renderEmail({ items: [], stats: STATS, awaitingTotal: 0, health });
  assert.match(html, /Site health: 1 error/);
  assert.ok(html.indexOf('Site health:') > html.indexOf('For your records'), 'health block is below the divider, not above');
  assert.match(html, /1 thing to look at below/);
});

test('renderEmail: no health field renders no site-health block (backward compatible)', () => {
  const html = renderEmail({ items: [], stats: STATS, awaitingTotal: 0 });
  assert.ok(!html.includes('Site health:'));
});

// ── Named digest snapshots (card #497 — daily-digest.yml score-drift +
// opening-digest.yml — and card #511 — reddit-engagement-digest.js — folded
// in the same way #364 folded in site health) ──────────────────────────────

test('renderNamedDigestBlock: nothing to render without a snapshot', () => {
  assert.equal(renderNamedDigestBlock('r/Broadway', null), '');
});

test('renderDailyDigestBlock: renders label, banner text, items, and freshness stamp', () => {
  const html = renderDailyDigestBlock({
    subject: 'Daily Digest: 3 changes on 2026-07-26',
    bannerText: '3 changes',
    generatedAt: '2026-07-26T06:50:00.000Z',
    items: [
      { title: 'Hamilton', detail: 'Score 91 → 95' },
      { title: 'Some New Show', detail: 'New show added (broadway)', url: 'https://broadwayscorecard.com/show/x' },
    ],
    moreCount: 2,
  });
  assert.match(html, /Score drift: 3 changes/);
  assert.match(html, /Hamilton/);
  assert.match(html, /Score 91 → 95/);
  assert.match(html, /<a href="https:\/\/broadwayscorecard\.com\/show\/x"[^>]*>Some New Show<\/a>/);
  assert.match(html, /\+2 more/);
  assert.match(html, /as of 2026-07-26 06:50 UTC/);
});

test('renderDailyDigestBlock: html-escapes item fields', () => {
  const html = renderDailyDigestBlock({
    bannerText: 'x', items: [{ title: '<script>alert(1)</script>', detail: 'a & b' }],
  });
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /a &amp; b/);
});

test('renderDailyDigestBlock: a corrupted item (null/malformed) is skipped, never crashes the render (ship-check finding)', () => {
  assert.doesNotThrow(() => renderDailyDigestBlock({
    bannerText: '2 changes', items: [null, { title: 'Real Show', detail: 'Score 80 → 82' }, undefined],
  }));
  const html = renderDailyDigestBlock({
    bannerText: '2 changes', items: [null, { title: 'Real Show', detail: 'Score 80 → 82' }, undefined],
  });
  assert.match(html, /Real Show/);
});

test('renderDailyDigestBlock: a non-http item url is not rendered as a link (no javascript:/data: in the inbox)', () => {
  for (const bad of ['javascript:alert(1)', 'data:text/html,<script>x</script>', 'ftp://example.com/x', 42]) {
    const html = renderDailyDigestBlock({
      bannerText: '1 change', items: [{ title: 'Sketchy', detail: 'd', url: bad }],
    });
    assert.match(html, /Sketchy/, `title still renders for url=${String(bad)}`);
    assert.doesNotMatch(html, /<a href=/, `no anchor emitted for url=${String(bad)}`);
  }
});

test('renderOpeningDigestBlock: nothing to render without a snapshot; label differs from daily digest', () => {
  assert.equal(renderOpeningDigestBlock(null), '');
  const html = renderOpeningDigestBlock({ bannerText: '2 needs help', items: [] });
  assert.match(html, /Opening radar: 2 needs help/);
});

test('renderEmail: both named digests render below the divider, alongside site health', () => {
  const dailyDigest = { bannerText: '3 changes', items: [{ title: 'Hamilton', detail: 'Score 91 → 95' }] };
  const openingDigest = { bannerText: '1 needs help', items: [{ title: 'Some Show', detail: 'Needs help: only 1 T1' }] };
  const html = renderEmail({ items: [], stats: STATS, awaitingTotal: 0, dailyDigest, openingDigest });
  assert.match(html, /Score drift: 3 changes/);
  assert.match(html, /Opening radar: 1 needs help/);
  assert.ok(html.indexOf('Score drift:') > html.indexOf('For your records'), 'daily digest is below the divider');
});

test('renderEmail: no dailyDigest/openingDigest fields render nothing (backward compatible)', () => {
  const html = renderEmail({ items: [], stats: STATS, awaitingTotal: 0 });
  assert.ok(!html.includes('Score drift:'));
  assert.ok(!html.includes('Opening radar:'));
});

test('renderRedditDigestBlock: renders label, banner text, items, and freshness stamp', () => {
  const html = renderRedditDigestBlock({
    subject: 'r/Broadway — 2 threads for you',
    bannerText: '2 threads',
    generatedAt: '2026-07-26T06:00:00.000Z',
    items: [
      { title: 'Best seats for Hamilton?', detail: 'The mezzanine center front averages...', url: 'https://reddit.com/r/Broadway/abc' },
      { title: 'Worth seeing Oh Mary?', detail: 'Critics loved it, 91/100 average' },
    ],
    moreCount: 1,
  });
  assert.match(html, /r\/Broadway: 2 threads/);
  assert.match(html, /Worth seeing Oh Mary\?/);
  assert.match(html, /Critics loved it, 91\/100 average/);
  assert.match(html, /<a href="https:\/\/reddit\.com\/r\/Broadway\/abc"[^>]*>Best seats for Hamilton\?<\/a>/);
  assert.match(html, /\+1 more/);
  assert.match(html, /as of 2026-07-26 06:00 UTC/);
});

test('renderRedditDigestBlock: html-escapes item fields', () => {
  const html = renderRedditDigestBlock({
    bannerText: 'x', items: [{ title: '<script>alert(1)</script>', detail: 'a & b' }],
  });
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /a &amp; b/);
});

test('renderRedditDigestBlock: a corrupted item (null/malformed) is skipped, never crashes the render', () => {
  assert.doesNotThrow(() => renderRedditDigestBlock({
    bannerText: '2 threads', items: [null, { title: 'Real Thread', detail: 'Draft reply text' }, undefined],
  }));
  const html = renderRedditDigestBlock({
    bannerText: '2 threads', items: [null, { title: 'Real Thread', detail: 'Draft reply text' }, undefined],
  });
  assert.match(html, /Real Thread/);
});

test('renderEmail: redditDigest renders below the divider, alongside site health', () => {
  const health = { bannerText: '0 errors, 0 warnings', errors: [], warns: [] };
  const redditDigest = { bannerText: '1 thread', items: [{ title: 'Some Thread', detail: 'Draft reply' }] };
  const html = renderEmail({ items: [], stats: STATS, awaitingTotal: 0, health, redditDigest });
  assert.match(html, /r\/Broadway: 1 thread/);
  assert.ok(html.indexOf('r/Broadway:') > html.indexOf('For your records'), 'reddit digest is below the divider');
});

test('renderEmail: no redditDigest field renders nothing (backward compatible)', () => {
  const html = renderEmail({ items: [], stats: STATS, awaitingTotal: 0 });
  assert.ok(!html.includes('r/Broadway:'));
});

// ── attachHealthFixUrls (card #634 regression guard) ────────────────────────
// The Fix-this buttons were wired into autonomous-email.js only. When the
// autonomous loop was paused (task #599) that sender stopped running, so the
// buttons reached ZERO delivered emails while the owner's actual daily send
// (send-morning-digest.js) printed "Fix needed: …" rows with nothing to tap.
// These lock the shared helper both senders now call.

test('attachHealthFixUrls: every error row gets a verifiable signed URL', () => {
  const health = {
    errors: [{ name: 'Sync: cast coverage', message: 'stale 3d' }, { name: 'SEO: health', message: '' }],
    warns: [{ name: 'a warning' }],
  };
  const exp = 1893456000;
  const n = attachHealthFixUrls({ health, exp, secret: 's3cret', baseUrl: 'https://broadwayscorecard.com' });
  assert.equal(n, 2);
  for (const e of health.errors) {
    assert.ok(e.fixUrl, `${e.name} got a fixUrl`);
    const u = new URL(e.fixUrl);
    assert.equal(u.searchParams.get('action'), 'dispatch');
    // conditionKey convention must match health-check.js's routeAlert so a tap
    // dedups onto the already-open card instead of filing a second one.
    assert.equal(u.searchParams.get('conditionKey'), `health-check:${e.name}`);
    assert.ok(verifyDispatchSignature({
      conditionKey: u.searchParams.get('conditionKey'),
      title: u.searchParams.get('title'),
      description: u.searchParams.get('description') || '',
      exp, secret: 's3cret', sig: u.searchParams.get('sig'),
    }), `${e.name} signature verifies`);
  }
  assert.ok(!health.warns[0].fixUrl, 'warnings get no button — errors are the actionable rows');
});

test('attachHealthFixUrls: no secret attaches nothing and does not throw (digest still sends)', () => {
  const health = { errors: [{ name: 'X', message: 'y' }], warns: [] };
  assert.equal(attachHealthFixUrls({ health, exp: 1, secret: '', baseUrl: 'https://x.com' }), 0);
  assert.equal(attachHealthFixUrls({ health, exp: 1, secret: 'k', baseUrl: '' }), 0);
  assert.ok(!health.errors[0].fixUrl);
});

test('attachHealthFixUrls: missing/!malformed health is a no-op, never a crash', () => {
  assert.equal(attachHealthFixUrls({ health: null, exp: 1, secret: 'k', baseUrl: 'https://x.com' }), 0);
  assert.equal(attachHealthFixUrls({ health: {}, exp: 1, secret: 'k', baseUrl: 'https://x.com' }), 0);
  const health = { errors: [null, { message: 'no name' }, { name: 'ok' }] };
  assert.equal(attachHealthFixUrls({ health, exp: 1, secret: 'k', baseUrl: 'https://x.com' }), 1);
});

test('attachHealthFixUrls: rendered through renderHealthDigestBlock, an error row shows a Fix this button', () => {
  const health = { bannerText: '1 error', errors: [{ name: 'Sync: cast coverage', message: 'stale' }], warns: [] };
  attachHealthFixUrls({ health, exp: 1893456000, secret: 'k', baseUrl: 'https://broadwayscorecard.com' });
  const html = renderHealthDigestBlock(health);
  assert.match(html, /Fix this/);
  assert.match(html, /api\/autonomous-action\?action=dispatch/);
});
