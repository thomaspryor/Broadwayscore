'use strict';
/**
 * Spend guard for experiment scripts (BRO-7524). Experiments had no enforced cap
 * (openai-leg-shadow spent $41.50 incl. 581 duplicate calls; fact-check sample $14.71).
 *
 *   parseMaxCost(argv, dflt)  -> USD cap from --max-cost=N (alias --max-usd=N). Throws on
 *                                junk, 0, negative, or "unlimited": an experiment always has a cap.
 *   createSpendGuard(maxUsd)  -> { add(usd), spent(), exceeded(), assertRoom() }
 *   createCallMemo()          -> memo(key, fn): identical in-flight/finished calls run once.
 */
const crypto = require('crypto');

function parseMaxCost(argv, dflt) {
  const a = argv.find((x) => x.startsWith('--max-cost=') || x.startsWith('--max-usd='));
  const raw = a ? a.slice(a.indexOf('=') + 1) : undefined;
  if (raw === undefined) {
    if (!(dflt > 0)) throw new Error('--max-cost=USD is required');
    return Number(dflt);
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`--max-cost must be a positive number of USD, got "${raw}"`);
  return n;
}

class BudgetExceeded extends Error {
  constructor(spent, max) { super(`experiment budget exceeded: $${spent.toFixed(2)} >= cap $${max.toFixed(2)}`); this.name = 'BudgetExceeded'; }
}

function createSpendGuard(maxUsd) {
  if (!(maxUsd > 0)) throw new Error('createSpendGuard needs a positive cap');
  let total = 0;
  return {
    add(usd) { if (Number.isFinite(usd) && usd > 0) total += usd; return total; },
    spent: () => total,
    max: maxUsd,
    exceeded: () => total >= maxUsd,
    assertRoom() { if (total >= maxUsd) throw new BudgetExceeded(total, maxUsd); },
  };
}

function callKey(...parts) {
  return crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

function createCallMemo() {
  const cache = new Map();
  const memo = (key, fn) => {
    if (!cache.has(key)) {
      const p = Promise.resolve().then(fn);
      cache.set(key, p);
      p.catch(() => cache.delete(key)); // a failed call may be retried; a success never repeats
    }
    return cache.get(key);
  };
  memo.size = () => cache.size;
  return memo;
}

module.exports = { parseMaxCost, createSpendGuard, createCallMemo, callKey, BudgetExceeded };
