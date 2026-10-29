import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createReviewBudget, callWithTimeout } = require('./llm-call-budget.js');

let t = 0;
const now = () => t;
const b = createReviewBudget({ now, callTimeoutMs: 60000, reviewBudgetMs: 150000 });
assert.equal(b.callTimeout(), 60000);
assert.equal(b.canRetry(), true);
t = 120000;
assert.equal(b.callTimeout(), 30000, 'call timeout clamped to remaining budget');
assert.equal(await b.sleepOrGiveUp(40000), false, 'backoff past budget gives up');
t = 150000;
assert.equal(b.canRetry(), false);
assert.equal(b.callTimeout(), 1000);

// defaults: no budget, 300s call timeout (bulk crons unchanged)
const d = createReviewBudget({ now });
assert.equal(d.canRetry(), true);
assert.equal(d.callTimeout(), 300000);
assert.equal(d.remainingMs(), Infinity);

// hung call rejects with LLM_CALL_TIMEOUT well before the hang ends
const start = Date.now();
await assert.rejects(
  callWithTimeout(() => new Promise(() => {}), 50, 'Gemini'),
  e => e.code === 'LLM_CALL_TIMEOUT' && /Gemini timed out/.test(e.message),
);
assert.ok(Date.now() - start < 1000);
assert.equal(await callWithTimeout(async () => 'ok', 50), 'ok');
console.log('llm-call-budget: all tests passed');
