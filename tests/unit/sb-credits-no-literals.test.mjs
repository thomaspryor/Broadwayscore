// BRO-3072: ScrapingBee/Scrapingdog credit costs come from creditsFor() (scripts/lib/provider-credits.js),
// never a numeric literal at a recordSbCall / sbBilledCredits call site (0 = "billed nothing" is allowed).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '../..');
const dirs = ['scripts', 'scripts/lib'];
const files = dirs.flatMap((d) => fs.readdirSync(path.join(root, d)).filter((f) => f.endsWith('.js') && !f.endsWith('.test.js')).map((f) => path.join(d, f)));
const LITERAL_CREDITS = /recordSbCall\(\{[^}\n]*\bcredits:\s*[1-9]\d*\b|sbBilledCredits\(\s*[^,()]+,\s*[1-9]\d*\s*\)/;
const SD_TABLE = /const\s+SD_CREDITS\s*=\s*\{[^}]*:\s*\d/;

test('no numeric credit literals at SB call sites or hand-copied SD tables', () => {
  const offenders = [];
  for (const f of files) {
    if (f === 'scripts/lib/provider-telemetry.js') continue; // defines the helpers
    const lines = fs.readFileSync(path.join(root, f), 'utf8').split('\n');
    lines.forEach((l, i) => { if (!l.trim().startsWith('//') && !l.trim().startsWith('*') && (LITERAL_CREDITS.test(l) || SD_TABLE.test(l))) offenders.push(`${f}:${i + 1}`); });
  }
  assert.deepEqual(offenders, []);
});
