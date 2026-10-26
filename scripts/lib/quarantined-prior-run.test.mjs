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
