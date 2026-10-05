// Tests for scripts/audit-fetchpage-cleanup.js (BRO-4623): require()s the
// real auditSource (CLAUDE.md rule 15) so a change to the audit's call-site
// recognition is caught here.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { auditSource } = require('./audit-fetchpage-cleanup.js');
const SCRIPTS_DIR = path.dirname(new URL(import.meta.url).pathname);

const verdict = (src) => auditSource('fixture.js', src).verdict;

test('runMain(main, { teardown: [cleanup] }) is SAFE although cleanup is only passed by reference', () => {
  const src = `
    const { fetchPage, cleanup } = require('./lib/scraper');
    const { runMain } = require('./lib/run-main');
    async function main() { await fetchPage('https://example.com'); }
    if (require.main === module) runMain(main, { teardown: [cleanup] });
  `;
  assert.equal(verdict(src), 'SAFE');
});

test('an aliased or module-form runMain is recognized too', () => {
  const aliased = `
    const { fetchPage, cleanup } = require('./lib/scraper');
    const { runMain: run } = require('./lib/run-main.js');
    async function main() { await fetchPage('u'); }
    run(main, { teardown: [cleanup] });
  `;
  const moduleForm = `
    const { fetchPage, cleanup } = require('./lib/scraper');
    const rm = require('./lib/run-main');
    async function main() { await fetchPage('u'); }
    rm.runMain(main, { teardown: [cleanup] });
  `;
  assert.equal(verdict(aliased), 'SAFE');
  assert.equal(verdict(moduleForm), 'SAFE');
});

test('a runMain from some other module does not count', () => {
  const src = `
    const { fetchPage, cleanup } = require('./lib/scraper');
    const { runMain } = require('./lib/something-else');
    async function main() { await fetchPage('u'); }
    runMain(main, { teardown: [cleanup] });
  `;
  assert.equal(verdict(src), 'UNSAFE_NO_CALL');
});

test('the old shapes keep their verdicts', () => {
  const catchOnly = `
    const { fetchPage } = require('./lib/scraper');
    async function main() { await fetchPage('u'); }
    main().catch((e) => { console.error(e); process.exit(1); });
  `;
  const finallyCleanup = `
    const { fetchPage, cleanup } = require('./lib/scraper');
    async function main() { await fetchPage('u'); }
    main().finally(() => cleanup());
  `;
  assert.equal(verdict(catchOnly), 'UNSAFE_CATCH_ONLY');
  assert.equal(verdict(finallyCleanup), 'SAFE');
});

test('the real BRO-4623 entry points wired to runMain audit SAFE', () => {
  for (const file of [
    'reconcile-recoupment-claims.js',
    'scrape-recoupment-announcements.js',
    'poll-trade-press-rss.js',
  ]) {
    const src = fs.readFileSync(path.join(SCRIPTS_DIR, file), 'utf8');
    const r = auditSource(file, src);
    assert.equal(r.verdict, 'SAFE', `${file}: ${r.verdict}`);
    assert.ok(r.sites.some((s) => /runMain/.test(s.kind)), `${file}: no runMain() call site recognized`);
  }
});
