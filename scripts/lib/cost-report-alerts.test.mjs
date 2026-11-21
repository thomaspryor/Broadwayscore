import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { evaluateCostReport, parseFailedByWorkflow, KEYS, CARD_KEYS } = require('./cost-report-alerts.js');
const { renderActionHtml } = require('../route-cost-report-alerts.js');

const QUIET = { totalFailed: 0, totalCancelled: 0, bbCost: '0.00', bbSessions: 0, sbProjected: 1000, sbCap: 1000000, sbStatus: 'ok', sbCreditsTotal: 1761, apiDegraded: '' };

test('the Oct 19-26 report: failures and the Browserbase spike each get a card', () => {
  const { lines, resolvableKeys } = evaluateCostReport({
    ...QUIET, totalFailed: 15, totalCancelled: 52, bbCost: '122.20', bbSessions: 1222,
    failedByWorkflow: { 'collect-review-texts.yml': 9, 'gather-reviews.yml': 6 },
  });
  const keys = lines.filter((l) => l.card).map((l) => l.conditionKey);
  assert.deepEqual(keys, [KEYS.workflowFailures, KEYS.browserbaseSpike]);
  const wf = lines.find((l) => l.conditionKey === KEYS.workflowFailures);
  assert.match(wf.card.description, /collect-review-texts\.yml: 9\n- gather-reviews\.yml: 6/);
  assert.match(lines[1].text, /\$122\.20 this week \(1222 sessions\)/);
  assert.deepEqual(resolvableKeys.sort(), [KEYS.sbExhausted, KEYS.sbProjectedOverCap].sort());
});

test('a quiet week files nothing and resolves every card condition', () => {
  const { lines, resolvableKeys } = evaluateCostReport(QUIET);
  assert.equal(lines.length, 0);
  assert.deepEqual(resolvableKeys, CARD_KEYS);
});

test('thresholds match the old bash step (>5 failures, >$50 rounded, >$25 amber)', () => {
  assert.equal(evaluateCostReport({ ...QUIET, totalFailed: 5 }).lines.length, 0);
  assert.equal(evaluateCostReport({ ...QUIET, totalFailed: 6 }).lines[0].conditionKey, KEYS.workflowFailures);
  assert.equal(evaluateCostReport({ ...QUIET, bbCost: '50.49' }).lines[0].level, 'amber');
  assert.equal(evaluateCostReport({ ...QUIET, bbCost: '50.50' }).lines[0].conditionKey, KEYS.browserbaseSpike);
  assert.equal(evaluateCostReport({ ...QUIET, bbCost: '25.00' }).lines.length, 0);
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
  const { lines } = evaluateCostReport({ ...QUIET, totalFailed: 15, bbCost: '122.20', bbSessions: 1222, apiDegraded: '<x>' });
  const html = renderActionHtml(lines, { [KEYS.workflowFailures]: 'BRO-1' });
  assert.match(html, /A worker session is on it: <a href="https:\/\/linear\.app\/broadway-scorecard\/issue\/BRO-1">BRO-1<\/a>/);
  assert.match(html, /Browserbase \$122\.20[^<]*Could not file a worker card/);
  assert.match(html, /&lt;x&gt;/);
  assert.doesNotMatch(html, /—|check logs|investigate spike/);
  assert.match(renderActionHtml(lines, {}, { dryRun: true }), /dry run: no card filed/);
});

const { routeLines } = require('../route-cost-report-alerts.js');

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
    ...QUIET, totalFailed: 15, bbCost: '122.20', bbSessions: 1222, sbProjected: 2000000, sbStatus: 'exhausted',
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
    assert.match(c.description, /RECHECK-AFTER/);
  }
});

test('routeLines: a clean week resolves every card key and files nothing', async () => {
  const router = fakeRouter({});
  const { failed } = await routeLines({ ...evaluateCostReport(QUIET), router, log: () => {} });
  assert.equal(failed, false);
  assert.equal(router.calls.length, 0);
  assert.deepEqual(router.resolved, CARD_KEYS);
});
