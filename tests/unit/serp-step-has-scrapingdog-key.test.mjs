// BRO-6867: every workflow step whose script reaches the shared SERP chain with
// the ScrapingBee key must also have the Scrapingdog key, or every search
// skips Scrapingdog (5 credits) for ScrapingBee (25). Logic lives in
// scripts/lib/serp-step-key-guard.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const { findAllSerpKeyGaps, findSerpKeyGaps } = require(path.join(ROOT, 'scripts/lib/serp-step-key-guard.js'));

test('every SERP-reaching workflow step with the ScrapingBee key also has the Scrapingdog key', () => {
  const gaps = findAllSerpKeyGaps(ROOT);
  assert.deepEqual(gaps, [], `Add SCRAPINGDOG_API_KEY: \${{ secrets.SCRAPINGDOG_API_KEY }} to:\n${gaps.join('\n')}`);
});

const wf = (env, run) => `on: push\njobs:\n  j:\n    runs-on: ubuntu-latest\n    steps:\n      - name: s\n        env:\n${env.map((k) => `          ${k}: x`).join('\n')}\n        run: ${run}\n`;

test('flags SB-only steps for each SERP entry point, not SB+SD steps or non-SERP scripts', () => {
  // discoverOfficialUrl (via official-url-discovery), discoverCorrectUrl (Stagedoor), node and tsx forms
  for (const s of ['node scripts/ob-discovery-ticket-links.js', 'node scripts/scrape-stagedoor-critics.js', 'npx tsx scripts/ob-discovery-ticket-links.js']) {
    assert.equal(findSerpKeyGaps(wf(['SCRAPINGBEE_API_KEY'], s), 't.yml', ROOT).length, 1, s);
    assert.equal(findSerpKeyGaps(wf(['SCRAPINGBEE_API_KEY', 'SCRAPINGDOG_API_KEY'], s), 't.yml', ROOT).length, 0, s);
  }
  assert.equal(findSerpKeyGaps(wf(['SCRAPINGBEE_API_KEY'], 'node scripts/check-sb-breaker.js'), 't.yml', ROOT).length, 0);
});

test('page fetches count: fetchPage steps and npm run steps are flagged without the Scrapingdog key', () => {
  // create-tour-entries.js reaches fetchPage; verify-reviews runs through `npm run reviews:verify`
  for (const s of ['node scripts/create-tour-entries.js --write', 'npm run reviews:verify > out.txt 2>&1']) {
    assert.equal(findSerpKeyGaps(wf(['SCRAPINGBEE_API_KEY'], s), 't.yml', ROOT).length, 1, s);
    assert.equal(findSerpKeyGaps(wf(['SCRAPINGBEE_API_KEY', 'SCRAPINGDOG_API_KEY'], s), 't.yml', ROOT).length, 0, s);
  }
});

test('a script with its own plain-https fetchPage is not flagged', () => {
  // fetch-review-texts.js defines a local fetchPage and never requires scraper.js
  assert.equal(findSerpKeyGaps(wf(['SCRAPINGBEE_API_KEY'], 'node scripts/fetch-review-texts.js'), 't.yml', ROOT).length, 0);
});

test('fetchPage passed on as a callback still counts', () => {
  // audit-critic-coverage.js hands scraper's fetchPage to discoverAuthorPages
  assert.equal(findSerpKeyGaps(wf(['SCRAPINGBEE_API_KEY'], 'node scripts/audit-critic-coverage.js'), 't.yml', ROOT).length, 1);
});

test('BRO-6867 review: path.join requires, star-slash-star strings and nested npm scripts are followed', () => {
  const { reachesSerpChain, stripComments, expandNpmRun } = require(path.join(ROOT, 'scripts/lib/serp-step-key-guard.js'));
  // author-pages modules load scraper.js via require(path.join(__dirname, '../scraper.js'))
  assert.equal(reachesSerpChain(path.join(ROOT, 'scripts/lib/author-pages/nyt.js'), new Map()), true);
  assert.equal(reachesSerpChain(path.join(ROOT, 'scripts/discover-author-page-slugs.js'), new Map()), true);
  // an Accept header of */* must not swallow the code after it
  const code = stripComments("h={Accept:'*/*'};\nrequire('./lib/scraper'); fetchPage(u) // x");
  assert.match(code, /fetchPage\(u\)/);
  assert.doesNotMatch(code, /\/\/ x/);
  // npm test expands through package.json to the scripts it runs
  assert.match(expandNpmRun('npm test', ROOT), /node scripts\//);
});
