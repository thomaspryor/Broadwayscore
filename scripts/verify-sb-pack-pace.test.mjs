// BRO-8280 RECHECK-AFTER 2026-12-02: after non-Broadway targeted polls stopped (BRO-8294),
// ScrapingBee must use <= cap/30 credits a day on average, or the 250k pack runs dry before renewal.
// Asserts LIVE data (provider-spend-daily.jsonl): red means the claim is disproven, not a code bug.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const FROM = '2026-11-26';
const text = fs.readFileSync(new URL('../data/audit/provider-spend-daily.jsonl', import.meta.url), 'utf8').trim();
const all = (text ? text.split('\n') : []).map((l) => JSON.parse(l))
  .filter((r) => r.day >= FROM && Number.isFinite(r.providers?.scrapingbee?.dayCredits) && Number.isFinite(r.providers?.scrapingbee?.cap));
// Only the newest pack cycle: a renewal resets the counter and understates that day's credits.
const renewal = all.at(-1)?.providers.scrapingbee.renewalDate;
const rows = all.filter((r) => r.providers.scrapingbee.renewalDate === renewal);
test('ScrapingBee daily credits average stays inside the pack', { skip: rows.length < 5 && 'fewer than 5 days since landing' }, () => {
  const cap = rows.at(-1).providers.scrapingbee.cap;
  const avg = rows.reduce((a, r) => a + r.providers.scrapingbee.dayCredits, 0) / rows.length;
  assert.ok(avg <= cap / 30, `avg ${Math.round(avg)}/day exceeds ${Math.round(cap / 30)}/day (pack ${cap})`);
});
