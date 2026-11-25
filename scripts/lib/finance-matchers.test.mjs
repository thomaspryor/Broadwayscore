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

test('reclassifyMonthlyDupes: 2nd+ same-month subscription charge → extra-topup, idempotent', () => {
  const rows = [
    { id: 'a', vendorKey: 'scrapingbee', kind: 'subscription', date: '2026-02-02' },
    { id: 'b', vendorKey: 'scrapingbee', kind: 'subscription', date: '2026-02-09' },
    { id: 'c', vendorKey: 'scrapingbee', kind: 'subscription', date: '2026-02-19' },
    { id: 'd', vendorKey: 'scrapingbee', kind: 'subscription', date: '2026-03-11' }, // new month resets
    { id: 'e', vendorKey: 'resend', kind: 'subscription', date: '2026-02-15' },      // other vendor untouched
    { id: 'f', vendorKey: 'anthropic', kind: 'usage-recharge', date: '2026-02-15' }, // non-subscription untouched
  ];
  assert.equal(M.reclassifyMonthlyDupes(rows), 2);
  assert.deepEqual(rows.map((r) => r.kind), ['subscription', 'extra-topup', 'extra-topup', 'subscription', 'subscription', 'usage-recharge']);
  assert.equal(M.reclassifyMonthlyDupes(rows), 0); // second run: no changes
});

test('applyExternallyPaid: early anthropic recharges + scrapingbee topups excluded, boundary respected', () => {
  const rows = [
    { vendorKey: 'anthropic', kind: 'usage-recharge', date: '2026-04-10' }, // < before → excluded
    { vendorKey: 'anthropic', kind: 'usage-recharge', date: '2026-05-10' }, // ≥ before → kept
    { vendorKey: 'scrapingbee', kind: 'extra-topup', date: '2026-02-09' },  // excluded
    { vendorKey: 'scrapingbee', kind: 'subscription', date: '2026-02-02' }, // base sub kept
  ];
  const res = M.applyExternallyPaid(rows, config);
  assert.equal(res.excluded, 2);
  assert.deepEqual(rows.map((r) => !!r.excluded), [true, false, true, false]);
  assert.equal(rows[0].excludedReason, 'paid-by-family');

  // Config edit retroactively clears flags (self-healing).
  const noRules = { ...config, externallyPaid: { rules: [] } };
  const res2 = M.applyExternallyPaid(rows, noRules);
  assert.equal(res2.cleared, 2);
  assert.ok(rows.every((r) => !r.excluded && !r.excludedReason));
});

test('exact-from rules match Gmail API display-name-wrapped From headers', () => {
  const wrapped = M.classifyReceipt({
    from: 'Anthropic, PBC <invoice+statements@mail.anthropic.com>',
    subject: 'Your receipt from Anthropic, PBC #2599-5034-2766',
    body: 'Amount paid $504.70',
  }, config);
  assert.equal(wrapped.vendorKey, 'anthropic');
  const bare = M.classifyReceipt({
    from: 'invoice+statements@mail.anthropic.com',
    subject: 'Your receipt from Anthropic, PBC #2599-5034-2766',
    body: 'Amount paid $504.70',
  }, config);
  assert.equal(bare.vendorKey, 'anthropic');
  assert.equal(M.extractEmailAddress('ScrapingBee <contact@scrapingbee.com>'), 'contact@scrapingbee.com');
});

test('display-name spoofing cannot book under a real vendor (ship-check findings 2+3)', () => {
  // Quoted display name containing a decoy vendor address — real addr-spec is LAST.
  const spoofExact = M.classifyReceipt({
    from: '"x <invoice+statements@mail.anthropic.com>" <attacker@evil.com>',
    subject: 'Your receipt', body: 'Amount paid $999.00',
  }, config);
  assert.equal(spoofExact.disposition, 'needs-review');
  // fromContains rules must not match display-name text either.
  const spoofContains = M.classifyReceipt({
    from: '"billing openai.com" <attacker@evil.com>',
    subject: 'Your receipt', body: 'Total $999.00',
  }, config);
  assert.equal(spoofContains.disposition, 'needs-review');
  assert.equal(M.extractEmailAddress('"x <a@b.com>" <c@d.com>'), 'c@d.com');
});

test('personalExclude matches wrapped From headers (ship-check finding 1)', () => {
  const r = M.classifyReceipt({
    from: 'Google Play <googleplay-noreply@google.com>',
    subject: 'Your order receipt', body: 'Total $4.99',
  }, config);
  assert.equal(r.disposition, 'personal');
});

test('refund notices book as negative rows with the credited amount, not the original charge', () => {
  const { row, disposition } = M.toLedgerRow({
    gmailMessageId: 'refund-1', date: '2026-03-04T20:49:26Z',
    from: 'Vercel Inc. <invoice+statements@vercel.com>',
    subject: 'Your refund from Vercel Inc. #3166-7470',
    body: 'Refund from Vercel Inc. $875.15 Refunded on March 4, 2026 Total $3,521.71 Amount paid $3,521.71 Build Minutes (Qty. 251557) -$875.15 Credited total -$875.15 Adjusted invoice total $2,646.56',
  }, config);
  assert.equal(disposition, 'booked');
  assert.equal(row.vendorKey, 'vercel');
  assert.equal(row.kind, 'refund');
  assert.equal(row.amountUsd, -875.15);
  assert.equal(row.amountBusiness, -875.15);
});

test('Claude Max subscription books as anthropic-max subscription, not API usage-recharge', () => {
  const { row } = M.toLedgerRow({
    gmailMessageId: 'max-1', date: '2026-06-21T03:08:10Z',
    from: 'Anthropic, PBC <invoice+statements@mail.anthropic.com>',
    subject: 'Your receipt from Anthropic, PBC #2599-5034-2766',
    body: 'Receipt #2599-5034-2766 Jun 20–Jul 20, 2026 Max plan - 20x Qty 1 $200.00 Subtotal $200.00 Total $206.00 Amount paid $206.00',
  }, config);
  assert.equal(row.vendorKey, 'anthropic-max');
  assert.equal(row.kind, 'subscription');
  assert.equal(row.amountUsd, 206);
  // API recharge (no "Max plan") still books under anthropic and stays exclusion-eligible.
  const api = M.classifyReceipt({
    from: 'Anthropic, PBC <invoice+statements@mail.anthropic.com>',
    subject: 'Your receipt from Anthropic, PBC #2720-4839-9430',
    body: 'Usage credits Qty 1 $490.00 Total $504.70 Amount paid $504.70',
  }, config);
  assert.equal(api.vendorKey, 'anthropic');
  // Max subs are a shared subscription (BRO-8273): booked at 50%, never excluded.
  // API recharges follow the pre-May family-paid rule.
  const maxRow = { vendorKey: 'anthropic-max', kind: 'subscription', date: '2026-06-21' };
  const apiRow = { vendorKey: 'anthropic', kind: 'usage-recharge', date: '2026-03-21' };
  const apiRowMay = { vendorKey: 'anthropic', kind: 'usage-recharge', date: '2026-05-21' };
  M.applyExternallyPaid([maxRow, apiRow, apiRowMay], config);
  assert.ok(!maxRow.excluded);
  assert.equal(row.businessPct, 50);
  assert.ok(apiRow.excluded);
  assert.ok(!apiRowMay.excluded);
});

test('Vercel Jan–Mar 2026 excluded (family-paid), including the Feb bill and Mar refund; Apr+ kept', () => {
  const rows = [
    { vendorKey: 'vercel', kind: 'usage', date: '2026-02-21' },   // the $3.5K bill
    { vendorKey: 'vercel', kind: 'refund', date: '2026-03-04' },  // its refund
    { vendorKey: 'vercel', kind: 'usage', date: '2026-04-22' },   // April onward = business
  ];
  M.applyExternallyPaid(rows, config);
  assert.deepEqual(rows.map((r) => !!r.excluded), [true, true, false]);
});

// ---- BRO-8273: OpenAI top-ups, card last-4, shared Claude Max, new vendors ----
const openaiFunded = {
  gmailMessageId: 'oai1', date: '2026-03-02T10:00:00Z',
  from: 'OpenAI <noreply@tm.openai.com>',
  subject: 'Your OpenAI API account has been funded',
  body: 'Your OpenAI API account has been funded. We charged $25.00 to your credit card ending in 4242. Credit balance $30.00',
};

test('OpenAI "account has been funded" email books as llm usage-recharge at the charged amount, with cardLast4', () => {
  const { row, disposition } = M.toLedgerRow(openaiFunded, config);
  assert.equal(disposition, 'booked');
  assert.equal(row.vendorKey, 'openai-api');
  assert.equal(row.category, 'llm');
  assert.equal(row.kind, 'usage-recharge');
  assert.equal(row.amount, 25); // NOT the $30 balance
  assert.equal(row.cardLast4, '4242');
  const alt = M.classifyReceipt({ ...openaiFunded, from: 'billing@tm1.openai.com' }, config);
  assert.equal(alt.vendorKey, 'openai-api');
});

test('extractCardLast4: "ending in" and Stripe-style "- NNNN", null otherwise', () => {
  assert.equal(M.extractCardLast4('charged to your credit card ending in 1234.'), '1234');
  assert.equal(M.extractCardLast4('Payment method Visa - 5678 Amount paid $10.00'), '5678');
  assert.equal(M.extractCardLast4('Total $12.00 on 2026-01-02'), null);
  assert.equal(M.extractCardLast4(''), null);
  assert.equal(M.extractCardLast4(undefined), null);
});

test('anthropic-max is booked at 50% (shared), not excluded as personal', () => {
  const rcpt = {
    gmailMessageId: 'max1', date: '2026-08-05T00:00:00Z',
    from: 'Anthropic, PBC <invoice+statements@mail.anthropic.com>',
    subject: 'Your receipt from Anthropic, PBC #1111-2222',
    body: 'Receipt Max plan $200.00 Total $200.00 Amount paid $200.00',
  };
  const { row } = M.toLedgerRow(rcpt, config);
  assert.equal(row.vendorKey, 'anthropic-max');
  assert.equal(row.businessPct, 50);
  assert.equal(row.amountBusiness, 100);
  const ext = M.applyExternallyPaid([row], config);
  assert.equal(ext.excluded, 0);
  assert.notEqual(row.excluded, true);
});

test('new vendors from the review queue book: Supabase payment mail, ElevenLabs, Wondercraft, Manaflow', () => {
  const cases = [
    [{ from: 'invoice+statements@supabase.com', subject: 'Payment received for Supabase Pte. Ltd. invoice (#ABC-1)', body: 'Total $25.00 Amount paid $25.00' }, 'supabase', 25],
    [{ from: 'invoice+statements+acct_1M07hSLmdOdiMXBs@stripe.com', subject: 'Your receipt from Eleven Labs Inc. #1234-5678-9012', body: 'Total $22.00 Amount paid $22.00' }, 'elevenlabs', 22],
    [{ from: 'invoice+statements@wondercraft.ai', subject: 'Your receipt from Wondercraft, Inc #1234-5678', body: 'Total $19.00 Amount paid $19.00' }, 'wondercraft', 19],
    [{ from: 'invoice+statements+acct_1PQa3RGhInAdn3Jb@stripe.com', subject: 'Your receipt from Manaflow, Inc. #1234-5678', body: 'Total $20.00 Amount paid $20.00' }, 'manaflow-cmux', 20],
  ];
  for (const [r, key, amt] of cases) {
    const out = M.toLedgerRow({ gmailMessageId: key, date: '2026-10-01T00:00:00Z', ...r }, config);
    assert.equal(out.disposition, 'booked', key);
    assert.equal(out.row.vendorKey, key);
    assert.equal(out.row.amount, amt);
  }
  // issued-invoice, Cloudflare and Buffer notices do not book
  const notBooked = [
    { from: 'invoice+statements@supabase.com', subject: 'New invoice from Supabase Pte. Ltd. (#ABC-1)', body: 'Total $25.00' },
    { from: 'noreply@notify.cloudflare.com', subject: 'Your invoice is available', body: '' },
    { from: 'hello@youraccount.buffer.com', subject: "We'll be renewing your subscription soon", body: '$6.00' },
  ];
  for (const r of notBooked) assert.equal(M.classifyReceipt(r, config).disposition, 'ignore', r.subject);
});

test('every vendor category in the config is a declared category (class guard)', () => {
  const declared = new Set(config.categories);
  const bad = config.expenseVendors.filter((v) => v.kind !== 'ignore' && !declared.has(v.category)).map((v) => v.key);
  assert.deepEqual(bad, []);
});

// ---- BRO-8273 ship-check findings ----
test('extractCardLast4 ignores years and phone-like digits', () => {
  for (const b of ['Anthropic, PBC – 2026', 'Nov 1 - 2026 Amount', 'Gift card - 5000', 'trial ending in 2026', '1-800-555 - 1234 Date']) {
    assert.equal(M.extractCardLast4(b), null, b);
  }
  assert.equal(M.extractCardLast4('Visa - 4242'), '4242');
  assert.equal(M.extractCardLast4('charged to your credit card ending in 0007'), '0007');
});

test('applyVendorBusinessPct re-applies a changed split to rows booked earlier', () => {
  const rows = [
    { vendorKey: 'anthropic-max', amountUsd: 200, businessPct: 100, amountBusiness: 200 },
    { vendorKey: 'anthropic', amountUsd: 50, businessPct: 100, amountBusiness: 50 },
  ];
  assert.equal(M.applyVendorBusinessPct(rows, config), 1);
  assert.equal(rows[0].businessPct, 50);
  assert.equal(rows[0].amountBusiness, 100);
  assert.equal(M.applyVendorBusinessPct(rows, config), 0); // idempotent
});

test('ignore rules are narrow: real receipts from Supabase/Buffer/Cloudflare reach review, OpenAI notices ignored', () => {
  const nr = (from, subject) => M.classifyReceipt({ from, subject, body: '' }, config).disposition;
  assert.equal(nr('invoice+statements@supabase.com', 'Your receipt from Supabase Inc #1234'), 'needs-review');
  assert.equal(nr('hello@youraccount.buffer.com', 'Your receipt from Buffer #1234'), 'needs-review');
  assert.equal(nr('noreply@notify.cloudflare.com', 'Your payment receipt'), 'needs-review');
  assert.equal(nr('noreply@tm.openai.com', 'Your API usage limit'), 'ignore');
  // funded mail whose subject also says "receipt" still books under openai-api
  assert.equal(M.classifyReceipt({ from: 'noreply@tm.openai.com', subject: 'Receipt: your OpenAI API account has been funded', body: '' }, config).vendorKey, 'openai-api');
});
