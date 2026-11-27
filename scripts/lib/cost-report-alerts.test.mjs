import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { evaluateCostReport, parseFailedByWorkflow, KEYS, CARD_KEYS } = require('./cost-report-alerts.js');
const { renderActionHtml } = require('../route-cost-report-alerts.js');

const QUIET = { totalFailed: 0, totalCancelled: 0, bbCost: '0.00', bbCostSource: 'billed', bbSessions: 0, sbProjected: 1000, sbCap: 1000000, sbStatus: 'ok', sbCreditsTotal: 1761, apiDegraded: '' };

test('the Oct 19-26 report: failures and the Browserbase spike each get a card', () => {
  const { lines, resolvableKeys } = evaluateCostReport({
    ...QUIET, totalFailed: 15, totalCancelled: 52, bbCost: '122.20', bbCostSource: 'billed', bbSessions: 1222,
    failedByWorkflow: { 'collect-review-texts.yml': 9, 'gather-reviews.yml': 6 },
  });
  const keys = lines.filter((l) => l.card).map((l) => l.conditionKey);
  assert.deepEqual(keys, [KEYS.workflowFailures, KEYS.browserbaseSpike]);
  const wf = lines.find((l) => l.conditionKey === KEYS.workflowFailures);
  assert.match(wf.card.description, /collect-review-texts\.yml: 9\n- gather-reviews\.yml: 6/);
  assert.match(lines[1].text, /\$122\.20 this week \(billed; 1222 sessions\)/);
  assert.deepEqual(resolvableKeys.sort(), [KEYS.sbExhausted, KEYS.sbProjectedOverCap].sort());
});

test('a quiet week files nothing and resolves every card condition', () => {
  const { lines, resolvableKeys } = evaluateCostReport(QUIET);
  assert.equal(lines.length, 0);
  assert.deepEqual(resolvableKeys, CARD_KEYS);
});

test('failure threshold matches the old bash step (>5 failures)', () => {
  assert.equal(evaluateCostReport({ ...QUIET, totalFailed: 5 }).lines.length, 0);
  assert.equal(evaluateCostReport({ ...QUIET, totalFailed: 6 }).lines[0].conditionKey, KEYS.workflowFailures);
});

// BRO-8268: Browserbase is priced on billed browser-hours, not $0.10/session.
test('Browserbase billed thresholds: >$20 red, >$15 amber, normal week quiet', () => {
  const billed = (bbCost, bbSessions = 970) => evaluateCostReport({ ...QUIET, bbCost, bbSessions, bbCostSource: 'billed' }).lines;
  assert.equal(billed('6.72').length, 0, 'the real week to 2026-11-24 is quiet');
  assert.equal(billed('13.99').length, 0, 'busiest normal week, early Nov');
  assert.equal(billed('15.00').length, 0);
  assert.equal(billed('15.01')[0].level, 'amber');
  assert.equal(billed('20.00')[0].level, 'amber');
  assert.equal(billed('20.01')[0].conditionKey, KEYS.browserbaseSpike);
});

test('Browserbase session-count spike files a card whatever the pricing basis', () => {
  for (const bbCostSource of ['billed', 'estimate', undefined]) {
    const l = evaluateCostReport({ ...QUIET, bbCost: '5.00', bbSessions: 2501, bbCostSource }).lines;
    assert.equal(l[0].conditionKey, KEYS.browserbaseSpike, String(bbCostSource));
  }
  assert.equal(evaluateCostReport({ ...QUIET, bbCost: '5.00', bbSessions: 2500, bbCostSource: 'billed' }).lines.length, 0);
});

test('the phantom: a $0.10/session estimate never files a card (BRO-6867 was filed this way)', () => {
  for (const bbCostSource of ['estimate', undefined, '']) {
    const l = evaluateCostReport({ ...QUIET, bbCost: '97.10', bbSessions: 971, bbCostSource }).lines;
    assert.equal(l.length, 1);
    assert.equal(l[0].level, 'amber');
    assert.equal(l[0].card, null);
    assert.match(l[0].text, /estimate at \$0\.10\/session: billed rows missing.*data-health-check/);
  }
});

test('ScrapingBee over-cap and exhausted are separate cards; high credits stays amber', () => {
  const { lines } = evaluateCostReport({ ...QUIET, sbProjected: 1500000, sbStatus: 'Plan EXHAUSTED', sbCreditsTotal: 60000 });
  assert.deepEqual(lines.map((l) => l.conditionKey), [KEYS.sbProjectedOverCap, KEYS.sbExhausted, null]);
  assert.match(lines[0].text, /50% over the 1000000 cap/);
  assert.equal(lines[2].level, 'amber');
});

test('non-numeric projection never fires (old bash numeric guard)', () => {
  assert.equal(evaluateCostReport({ ...QUIET, sbProjected: '?' }).lines.length, 0);
});

test('an estimate week never resolves the Browserbase spike card (billed data missing is not a fix)', () => {
  for (const bbCostSource of ['estimate', undefined]) {
    const { resolvableKeys } = evaluateCostReport({ ...QUIET, bbCost: '0.00', bbSessions: 900, bbCostSource });
    assert.ok(!resolvableKeys.includes(KEYS.browserbaseSpike), String(bbCostSource));
    assert.ok(resolvableKeys.includes(KEYS.workflowFailures), 'other cards still resolve');
  }
  assert.ok(evaluateCostReport({ ...QUIET, bbCost: '6.72', bbSessions: 971 }).resolvableKeys.includes(KEYS.browserbaseSpike));
});

test('degraded provider data resolves nothing (a missing number is not a fix)', () => {
  const { lines, resolvableKeys } = evaluateCostReport({ ...QUIET, apiDegraded: 'Browserbase (HTTP 500)' });
  assert.equal(lines[0].level, 'amber');
  assert.deepEqual(resolvableKeys, []);
});

test('unreadable run history keeps the failures card open (no false clear)', () => {
  const { lines, resolvableKeys } = evaluateCostReport({ ...QUIET, runsQueryFailed: 'gather-reviews.yml' });
  assert.equal(lines[0].level, 'amber');
  assert.ok(!resolvableKeys.includes(KEYS.workflowFailures));
  assert.ok(resolvableKeys.includes(KEYS.browserbaseSpike));
});

test('parseFailedByWorkflow skips bad pairs and zeros', () => {
  assert.deepEqual(parseFailedByWorkflow('a.yml:3,b.yml:0,junk,c.yml:x,d.yml:2'), { 'a.yml': 3, 'd.yml': 2 });
  assert.deepEqual(parseFailedByWorkflow(''), {});
});

test('email list names the card, or says filing failed; no em dashes; text escaped', () => {
  const { lines } = evaluateCostReport({ ...QUIET, totalFailed: 15, bbCost: '122.20', bbCostSource: 'billed', bbSessions: 1222, apiDegraded: '<x>' });
  const html = renderActionHtml(lines, { [KEYS.workflowFailures]: 'BRO-1' }, { states: { [KEYS.workflowFailures]: 'started' } });
  assert.match(html, /A worker session is on it: <a href="https:\/\/linear\.app\/broadway-scorecard\/issue\/BRO-1">BRO-1<\/a>/);
  assert.match(html, /Browserbase \$122\.20[^<]*Could not file a worker card/);
  assert.match(html, /&lt;x&gt;/);
  assert.doesNotMatch(html, /—|check logs|investigate spike/);
  assert.match(renderActionHtml(lines, {}, { dryRun: true }), /dry run: no card filed/);
});

// BRO-6866 class guard: "on it" only for a claimed (started) card. Fails with the fix reverted.
test('email says queued, not "on it", for a card nobody has claimed', () => {
  const { lines } = evaluateCostReport({ ...QUIET, totalFailed: 15 });
  const key = KEYS.workflowFailures;
  const unknown = renderActionHtml(lines, { [key]: 'BRO-1' }, { states: {} });
  assert.doesNotMatch(unknown, /worker session is on it|Queued/);
  assert.match(unknown, /status unavailable/);
  for (const states of [{ [key]: 'unstarted' }, { [key]: 'backlog' }]) {
    const html = renderActionHtml(lines, { [key]: 'BRO-1' }, { states });
    assert.doesNotMatch(html, /worker session is on it/);
    assert.match(html, /Queued, no worker session has taken it yet: <a href=/);
  }
  assert.match(renderActionHtml(lines, { [key]: 'BRO-1' }, { states: { [key]: 'started' } }), /worker session is on it/);
});

test('fetchCardStates maps state types and fails soft', async () => {
  const states = await fetchCardStates({ a: 'BRO-1', b: 'BRO-2', c: 'BRO-3' }, async (id) => {
    if (id === 'BRO-2') throw new Error('linear down');
    return id === 'BRO-1' ? { state: { type: 'started' } } : null;
  });
  assert.deepEqual(states, { a: 'started' });
});

const { routeLines, fetchCardStates } = require('../route-cost-report-alerts.js');

function fakeRouter(results) {
  const calls = [];
  const resolved = [];
  return {
    calls, resolved,
    routeAlert: async (opts) => { calls.push(opts); const r = results[opts.conditionKey]; if (r instanceof Error) throw r; return r; },
    resolveCondition: (key) => { resolved.push(key); return true; },
  };
}

test('routeLines: auto and silent results with a card name it; no-card, dispatchOk:false and throws fail', async () => {
  const { lines, resolvableKeys } = evaluateCostReport({
    ...QUIET, totalFailed: 15, bbCost: '122.20', bbCostSource: 'billed', bbSessions: 1222, sbProjected: 2000000, sbStatus: 'exhausted',
  });
  const router = fakeRouter({
    [KEYS.workflowFailures]: { action: 'auto', dispatchOk: true, linearIdentifier: 'BRO-1' },
    [KEYS.browserbaseSpike]: { action: 'silent', linearIdentifier: 'BRO-2' },
    [KEYS.sbProjectedOverCap]: { action: 'auto', dispatchOk: false, linearIdentifier: null },
    [KEYS.sbExhausted]: new Error('linear down'),
  });
  const { cards, failed } = await routeLines({ lines, resolvableKeys, router, runContext: { runId: '9', runUrl: 'u' }, log: () => {} });
  assert.deepEqual(cards, { [KEYS.workflowFailures]: 'BRO-1', [KEYS.browserbaseSpike]: 'BRO-2' });
  assert.equal(failed, true);
  assert.equal(router.calls.length, 4);
  for (const c of router.calls) {
    assert.equal(c.disposition, 'auto');
    assert.equal(c.cooldownHours, 24);
    assert.deepEqual(c.dispatchAtFiling, { runId: '9', runUrl: 'u' });
    assert.match(c.description, /Keep the card open until that check passes/);
  }
});

test('routeLines: a clean week resolves every card key and files nothing', async () => {
  const router = fakeRouter({});
  const { failed } = await routeLines({ ...evaluateCostReport(QUIET), router, log: () => {} });
  assert.equal(failed, false);
  assert.equal(router.calls.length, 0);
  assert.deepEqual(router.resolved, CARD_KEYS);
});
