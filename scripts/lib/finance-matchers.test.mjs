// Unit test for the real finance matchers (CLAUDE.md Rule 15 — require the
// production module, don't reimplement). Fixtures are minimal synthetic
// receipts that mirror the real vendor formats; NO real billing PII is committed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const M = require('./finance-matchers.js');

const config = M.loadVendorConfig();

// --- Fixtures (shape matches scripts/ingest-finances.js normalized receipt) ---
const fx = {
  anthropic: {
    gmailMessageId: 'aaa1', date: '2026-06-27T08:27:57Z',
    from: 'invoice+statements@mail.anthropic.com',
    subject: 'Your receipt from Anthropic, PBC #2034-6542-7006',
    body: 'Receipt from Anthropic, PBC $504.70 Paid June 27, 2026 Recharge credits Qty 1 $490.00 Subtotal $490.00 Total excluding tax $490.00 Sales Tax - Colorado (3%) $14.70 Total $504.70 Amount paid $504.70',
  },
  bdRecharge: {
    gmailMessageId: 'bbb1', date: '2026-07-01T06:52:59Z',
    from: 'noreply@brightdata.com',
    subject: 'Your Bright Data account hl_9b2d5c61 was recharged',
    body: 'This notification is to inform you that your account balance just reached $12.97 and was recharged for $50, per your auto-recharge settings.',
  },
  bdMonthly: {
    gmailMessageId: 'bbb2', date: '2026-07-03T13:13:05Z',
    from: 'noreply@brightdata.com',
    subject: 'Bright Data monthly bill - June 2026 (paid)',
    body: 'Your June 2026 tax invoice for Bright Data is now available. Total $312.40',
  },
  googleCloud: {
    gmailMessageId: 'ggg1', date: '2026-07-01T21:15:03Z',
    from: 'payments-noreply@google.com',
    subject: "Google: We've received your payment for 6158-9060-6605",
    body: 'Google Cloud Platform & APIs Payment received Your payment amount of US$192.97 to Google was received on 1 Jul 2026.',
  },
  googlePlay: {
    gmailMessageId: 'ggg2', date: '2026-04-19T22:07:34Z',
    from: 'googleplay-noreply@google.com',
    subject: 'Your Google Play Order Receipt from 19 Apr 2026',
    body: 'Google Play Thank you for your payment You bought a book on Google Play. $9.99',
  },
  googleAmbiguous: {
    gmailMessageId: 'ggg3', date: '2026-06-01T00:00:00Z',
    from: 'payments-noreply@google.com',
    subject: "Google: We've received your payment for 0000",
    body: 'Nest Aware subscription payment received US$8.00',
  },
  openrouter: {
    gmailMessageId: 'ooo1', date: '2026-02-22T20:36:17Z',
    from: 'receipts@openrouter.ai',
    subject: 'Your OpenRouter, Inc receipt [#1618-6690]',
    body: 'Receipt from OpenRouter, Inc [#1618-6690] Amount paid $34.46 Date paid Feb 22, 2026',
  },
  xPremium: {
    gmailMessageId: 'xxx1', date: '2026-06-08T22:46:06Z',
    from: 'invoice+statements+acct_1Ika5JA3KZ32dPo1@stripe.com',
    subject: 'Your receipt from X #2936-6638-0841',
    body: 'Receipt from X $8.00 Paid June 8, 2026 X Premium (per Period) Qty 1 $8.00 Total $8.00 Amount paid $8.00',
  },
  xDeveloper: {
    gmailMessageId: 'xxx2', date: '2026-04-13T02:36:25Z',
    from: 'invoice+statements+acct_1S46seBJoSOSGwEl@stripe.com',
    subject: 'Your receipt from X Developer Platform #2539-7100',
    body: 'Receipt from X Developer Platform $25.00 Paid April 13, 2026 Credits Qty 1 $25.00 Total $25.00 Amount paid $25.00',
  },
  scrapingdog: {
    gmailMessageId: 'sss1', date: '2026-06-22T00:00:00Z',
    from: 'invoice+statements+acct_1GXTgWLsPRCYo9Br@stripe.com',
    subject: 'Your receipt from OPENDATA LABS PRIVATE LIMITED #2117-6371',
    body: 'Receipt from OPENDATA LABS PRIVATE LIMITED $90.00 Scrapingdog (per 1) Qty 1 $90.00 Total $90.00 Amount paid $90.00',
  },
};

test('Anthropic receipt → booked at the CHARGED total, not the subtotal', () => {
  const { row, disposition } = M.toLedgerRow(fx.anthropic, config);
  assert.equal(disposition, 'booked');
  assert.equal(row.vendorKey, 'anthropic');
  assert.equal(row.category, 'llm');
  assert.equal(row.amount, 504.70); // NOT 490.00
  assert.equal(row.amountUsd, 504.70);
  assert.equal(row.businessPct, 100);
  assert.equal(row.id, 'gmail-aaa1');
});

test('Bright Data: recharge is booked, monthly summary is ignored (no double-count)', () => {
  const recharge = M.toLedgerRow(fx.bdRecharge, config);
  assert.equal(recharge.disposition, 'booked');
  assert.equal(recharge.row.vendorKey, 'brightdata');
  assert.equal(recharge.row.amount, 50);

  const monthly = M.toLedgerRow(fx.bdMonthly, config);
  assert.equal(monthly.disposition, 'ignore');
  assert.equal(monthly.row, null);
});

test('Google Cloud (Gemini) → booked; personal Google Play → rejected; ambiguous google → not booked', () => {
  const cloud = M.toLedgerRow(fx.googleCloud, config);
  assert.equal(cloud.disposition, 'booked');
  assert.equal(cloud.row.vendorKey, 'google-cloud');
  assert.equal(cloud.row.amountUsd, 192.97);

  const play = M.classifyReceipt(fx.googlePlay, config);
  assert.equal(play.disposition, 'personal');

  // Same billing sender as Cloud but no "Google Cloud Platform" body → must NOT book.
  const ambiguous = M.classifyReceipt(fx.googleAmbiguous, config);
  assert.equal(ambiguous.disposition, 'needs-review');
});

test('OpenRouter → booked $34.46', () => {
  const { row, disposition } = M.toLedgerRow(fx.openrouter, config);
  assert.equal(disposition, 'booked');
  assert.equal(row.vendorKey, 'openrouter');
  assert.equal(row.amount, 34.46);
  assert.equal(row.raw.receiptNo, '1618-6690');
});

test('Stripe-fronted vendors resolve by acct_ id: X Premium vs X Developer vs Scrapingdog', () => {
  const prem = M.classifyReceipt(fx.xPremium, config);
  assert.equal(prem.vendorKey, 'x-premium');
  assert.equal(prem.businessPct, 100);

  const dev = M.classifyReceipt(fx.xDeveloper, config);
  assert.equal(dev.vendorKey, 'x-developer');

  const dog = M.toLedgerRow(fx.scrapingdog, config);
  assert.equal(dog.row.vendorKey, 'scrapingdog');
  assert.equal(dog.row.amount, 90);
});

test('FX normalizes non-USD to USD', () => {
  assert.equal(M.toUsd(10, 'GBP', { USD: 1, GBP: 1.27 }), 12.7);
  assert.equal(M.toUsd(100, 'USD'), 100);
  assert.throws(() => M.toUsd(5, 'JPY', { USD: 1 }), /No FX rate/);
});

test('dedupHash is stable across differing Gmail ids (survives MCP→API switch)', () => {
  const a = M.toLedgerRow({ ...fx.anthropic, gmailMessageId: 'mcp-form' }, config).row;
  const b = M.toLedgerRow({ ...fx.anthropic, gmailMessageId: 'api-form' }, config).row;
  assert.notEqual(a.id, b.id);        // different message-id source
  assert.equal(a.dedupHash, b.dedupHash); // same charge → same fallback key
});

test('unknown vendor → needs-review, never auto-booked', () => {
  const r = M.classifyReceipt({
    from: 'billing@somenewtool.com', subject: 'Your receipt', body: 'Total $12.00',
  }, config);
  assert.equal(r.disposition, 'needs-review');
});
