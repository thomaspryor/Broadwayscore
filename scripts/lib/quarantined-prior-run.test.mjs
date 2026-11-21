// BRO-5421: Sea Wall 2026 gap alert counted failed=1 for a 2023 Edinburgh review the
// write guard correctly quarantined (date_implausible). A pre-run quarantine is the
// earlier production's review (expected); a current-run date must stay a real failure.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { quarantinedPriorRunDate } = require('./gap-ingest-policy.js');

const show = { id: 'sea-wall-off-broadway-2026', openingDate: '2026-10-16', previewsStartDate: '2026-10-08' };
const URL = 'https://www.intermissionmagazine.ca/reviews/sea-wall-assembly/';

function out(publishDate, url = URL) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qpr-'));
  const f = path.join(dir, 'x.json');
  fs.writeFileSync(f, JSON.stringify({ url, publishDate }));
  return `❌ Write-guard refused the write — nothing changed on disk (date_implausible)\n   quarantined to: ${f}`;
}

test('2023 review quarantined for a 2026 show is a prior-production refusal', () => {
  assert.equal(quarantinedPriorRunDate(out('2023-09-25'), show), '2023-09-25');
});

test('a date inside the run is not excused', () => {
  assert.equal(quarantinedPriorRunDate(out('2026-10-17'), show), null);
});

test('other failures and missing files are not excused', () => {
  assert.equal(quarantinedPriorRunDate('fetch failed', show), null);
  assert.equal(quarantinedPriorRunDate('(date_implausible)\n quarantined to: /nope/x.json', show), null);
  assert.equal(quarantinedPriorRunDate(out('2023-09-25').replace('date_implausible', 'cross_market_contamination'), show), null);
});

// BRO-7587: Downstate (Broadway 2026) press-night gap check failed on the 2022 Washington Post review its roundup still links.
const { oldProductionRefusalDate } = require('./gap-ingest-policy.js');
const REFUSAL = '⛔ Refusing old-production review: https://www.washingtonpost.com/theater-dance/2022/11/23/downstate-bruce-norris-pedophiles/ (dated 2022-11-25, over a year before downstate-2026 starts)\n\n❌ Write-guard refused the write — nothing changed on disk (oldProductionReview)';
test('the write guard\'s old-production refusal is read as an expected prior-production refusal', () => {
  assert.equal(oldProductionRefusalDate(REFUSAL), '2022-11-25');
  assert.equal(oldProductionRefusalDate('fetch failed'), null);
  assert.equal(oldProductionRefusalDate(''), null);
});
test('the audit routes that refusal to an expected result (wired, not just defined)', () => {
  const src = fs.readFileSync(path.join(path.dirname(new globalThis.URL(import.meta.url).pathname), '..', 'audit-show-review-gap.js'), 'utf8');
  assert.match(src, /oldProductionRefusalDate\([\s\S]{0,300}expectedReason: 'old-production-review'/);
});
test('the writer still prints the refusal line the audit parses (contract pin)', () => {
  const w = fs.readFileSync(path.join(path.dirname(new globalThis.URL(import.meta.url).pathname), 'review-file-writer.js'), 'utf8');
  const m = /console\.warn\(`  ⛔ (Refusing old-production review: [^`]*)`\)/.exec(w);
  assert.ok(m, 'review-file-writer.js no longer prints "Refusing old-production review"; update oldProductionRefusalDate');
  const sample = m[1].replace(/\$\{input\.url \|\| filepath\}/, 'https://x.com/a').replace(/\$\{fields\.publishDate \|\| input\.publishDate\}/, '2022-11-25').replace(/\$\{showId\}/, 'downstate-2026');
  assert.equal(oldProductionRefusalDate(sample), '2022-11-25');
});
