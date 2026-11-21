// BRO-5168: which daily health rows may be filed START-NOW (shared by
// digest-autofix.js and owner-alert-router.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { startNowHealthRowReason, startNowLine, selectUnroutedVisitorRows } = require('./start-now-filing.js');

test('startNowHealthRowReason: a visitor-facing row may file START-NOW', () => {
  assert.equal(startNowHealthRowReason({ name: 'Images: missing posters', message: '3 shows' }), null);
});

test('startNowHealthRowReason: internal rows, owner-money/Mac rows and live acknowledgements may not', () => {
  assert.equal(startNowHealthRowReason({ name: 'Autofix: throughput' }), 'internal');
  for (const name of ['Credits: ScrapingBee', 'Secrets: rotation', 'Cookies: BWW', 'Revenue: affiliate health']) {
    assert.equal(startNowHealthRowReason({ name }), 'owner-or-mac', name);
  }
  const msg = 'low credits (acknowledged: upgrade later [expires 2026-11-01])';
  assert.equal(startNowHealthRowReason({ name: 'Images: missing posters', message: msg }, '2026-10-12'), 'acknowledged');
  assert.equal(startNowHealthRowReason({ name: 'Images: missing posters', message: msg }, '2026-11-02'), null, 'expired acknowledgement');
});

test('startNowLine: starts with the START-NOW: token cloud-worker-pick reads', () => {
  assert.match(startNowLine('the Mac drain'), /^START-NOW: .*the Mac drain/);
});

test('selectUnroutedVisitorRows: failing visitor rows with no playbook route only', () => {
  const playbook = {
    'Quality: corpus drift': { humanAction: 'fix it' },
    'Freshness: shows.json': { workflow: 'rebuild.yml' },
    'Data: fallback only': { humanFallback: 'look' },
  };
  const getPlaybookEntry = (name) => playbook[name] || null;
  const rows = [
    { name: 'Data: T1/T2 silent review gaps', status: 'error' },
    { name: 'Data quality: stale announced shows', status: 'warn' },
    { name: 'Data: fallback only', status: 'warn' },
    { name: 'Quality: corpus drift', status: 'error' },
    { name: 'Freshness: shows.json', status: 'warn' },
    { name: 'Stuck work: paused P0/P1 cards', status: 'warn' },
    { name: 'Credits: ScrapingBee', status: 'error' },
    { name: 'Data: passing row', status: 'pass' },
    null,
  ];
  assert.deepEqual(selectUnroutedVisitorRows(rows, { getPlaybookEntry }).map((r) => r.name), [
    'Data: T1/T2 silent review gaps',
    'Data quality: stale announced shows',
    'Data: fallback only',
  ]);
  assert.deepEqual(selectUnroutedVisitorRows(undefined, { getPlaybookEntry }), []);
});
