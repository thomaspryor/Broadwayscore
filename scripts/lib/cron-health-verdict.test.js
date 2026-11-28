'use strict';
const assert = require('assert');
const { cronHealthVerdict } = require('./cron-health-verdict');

const NOW = Date.parse('2026-11-28T11:00:00Z');
const hoursAgo = (iso) => (NOW - Date.parse(iso)) / 3600000;
const formatAge = (h) => `${Math.round(h)}h`;
const cron = { name: 'Collect Review Texts', maxHours: 36 };
const v = (runs, c = cron) => cronHealthVerdict(runs, c, hoursAgo, formatAge);

// 1. The false alarm: newest run in flight, green run 40 min earlier -> pass.
let r = v([
  { createdAt: '2026-11-28T10:30:00Z', conclusion: null },
  { createdAt: '2026-11-28T10:20:00Z', conclusion: 'success' },
]);
assert.strictEqual(r.status, 'pass', JSON.stringify(r));
assert.strictEqual(r.name, 'Cron: Collect Review Texts');

// 2. In flight, nothing green inside the window -> still a baseline warn.
r = v([
  { createdAt: '2026-11-28T10:30:00Z', conclusion: null },
  { createdAt: '2026-11-26T10:00:00Z', conclusion: 'success' }, // 49h ago
]);
assert.strictEqual(r.status, 'warn');
assert.match(r.message, /still running/);

// 3. Stale newest run -> error regardless.
r = v([{ createdAt: '2026-11-26T10:00:00Z', conclusion: 'success' }]);
assert.strictEqual(r.status, 'error');

// 4. Cancelled head with recent success -> pass (unchanged behaviour).
r = v([
  { createdAt: '2026-11-28T10:30:00Z', conclusion: 'cancelled' },
  { createdAt: '2026-11-28T09:00:00Z', conclusion: 'success' },
]);
assert.strictEqual(r.status, 'pass');

// 5. Failed head, no success -> fix-now `Cron failed:` row (unchanged).
r = v([
  { createdAt: '2026-11-28T10:30:00Z', conclusion: 'failure' },
  { createdAt: '2026-11-28T09:00:00Z', conclusion: 'failure' },
]);
assert.strictEqual(r.name, 'Cron failed: Collect Review Texts');

// 6. No runs -> warn.
assert.strictEqual(v([]).status, 'warn');

console.log('cron-health-verdict: 6/6 passed');
