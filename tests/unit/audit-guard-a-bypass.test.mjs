// BRO-2158: every scraper/collector that touches review-texts must either use
// createOrMergeReviewFile() (Guard A) or carry a GUARD-A-DISPOSITION note, and
// "dead" dispositions must stay true (no live caller).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const MIGRATED = ['scrape-nysr-reviews', 'scrape-wp-theater-blogs'];
const LIVE_ENRICHMENT = ['fetch-guardian-reviews', 'collect-review-texts'];
const DEAD = [
  'scrape-broadway-and-me', 'scrape-priority-reviews', 'scrape-reviews', 'fetch-bww-roundups',
  'fetch-review-texts', 'fetch-from-wayback', 'fetch-nysr-scores', 'collect-good-outlets',
  'collect-showscore-reviews', 'collect-review-texts-v2',
];

test('migrated scrapers route through createOrMergeReviewFile', () => {
  for (const f of MIGRATED) assert.match(read(`scripts/${f}.js`), /createOrMergeReviewFile/, f);
});

test('dispositioned files carry a GUARD-A-DISPOSITION note', () => {
  for (const f of [...LIVE_ENRICHMENT, ...DEAD]) {
    assert.match(read(`scripts/${f}.js`), /GUARD-A-DISPOSITION \(BRO-2158\)/, f);
  }
});

test('dead-code dispositions: no workflow or script invokes them', () => {
  const files = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(path.join(ROOT, d), { withFileTypes: true })) {
      const rel = `${d}/${e.name}`;
      if (e.isDirectory()) { if (e.name !== 'node_modules') walk(rel); }
      else if (/\.(ya?ml|js|mjs|ts|sh)$/.test(e.name)) files.push(rel);
    }
  };
  walk('.github/workflows'); walk('scripts');
  const pkg = read('package.json');
  for (const f of DEAD) {
    const self = `scripts/${f}.js`;
    // match `node scripts/<f>.js` / `./<f>.js` style invocations, not prose mentions
    const re = new RegExp(`(node|tsx|require\\(['"\`.\\/]*|spawn\\w*\\([^)]*)[ '"\`/]*(scripts/)?${f}\\.js`);
    const callers = files.filter((p) => p !== self && !/\.test\.mjs$/.test(p) && !/audit-/.test(p) && re.test(read(p)));
    assert.deepEqual(callers, [], `${f} is revived (called by ${callers}); migrate to createOrMergeReviewFile`);
    assert.ok(!pkg.includes(`${f}.js`), `${f} in package.json`);
  }
});

test('no undispositioned scraper/collector writes review-texts without the shared writer', () => {
  const known = new Set([...MIGRATED, ...LIVE_ENRICHMENT, ...DEAD]);
  const offenders = fs.readdirSync(path.join(ROOT, 'scripts'))
    .filter((n) => /^(scrape|fetch|collect|gather)-.*\.js$/.test(n))
    .filter((n) => {
      const s = read(`scripts/${n}`);
      return s.includes('review-texts') && !/review-file-writer|createOrMergeReviewFile|resolveWriteTarget/.test(s)
        && /fs\.(writeFileSync|mkdirSync)/.test(s) && !known.has(n.replace(/\.js$/, ''));
    });
  assert.deepEqual(offenders, [], 'new scraper writes review-texts bypassing Guard A: ' + offenders);
});
