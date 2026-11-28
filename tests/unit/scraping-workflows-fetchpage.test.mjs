// BRO-3606: guards for the two defects found during the BRO-2961 ledger audit.
//  1. A workflow must not call a scraping provider directly (raw axios to
//     ScrapingBee / Bright Data); spend would bypass provider-telemetry.js.
//  2. A workflow `npm run <script>` must name a script that exists in
//     package.json (verify-reviews.yml was a silent no-op for that reason).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const wfDir = path.join(root, '.github', 'workflows');
const workflows = fs.readdirSync(wfDir).filter((f) => /\.ya?ml$/.test(f));
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

test('archive-aggregator-pages.yml goes through fetchPage, not raw provider calls', () => {
  const src = fs.readFileSync(path.join(wfDir, 'archive-aggregator-pages.yml'), 'utf8');
  assert.match(src, /fetchArchivePage|fetchPage/);
  assert.doesNotMatch(src, /app\.scrapingbee\.com|api\.brightdata\.com|require\(['"]axios['"]\)/);
});

test('every `npm run <script>` in a workflow exists in package.json', () => {
  const missing = [];
  for (const f of workflows) {
    const lines = fs.readFileSync(path.join(wfDir, f), 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (/^\s*#/.test(line)) return;
      for (const m of line.matchAll(/npm run (?:-s )?([A-Za-z0-9:_.-]+)/g)) {
        if (!pkg.scripts?.[m[1]]) missing.push(`${f}:${i + 1} npm run ${m[1]}`);
      }
    });
  }
  assert.deepEqual(missing, []);
});
