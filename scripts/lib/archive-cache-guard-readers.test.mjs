// timebomb-audit-exempt: the rejected-page ledger tests inject `now`, and the
//   ENOENT test only checks a vanished file; no fixture depends on the real
//   clock against a filesystem mtime.
//
// BRO-3621 / BRO-3608: the aggregator-archive identity guard reaches every
// reader that extracts or counts content from data/aggregator-archive/, and
// Playbill Verdict's batch path (Step 3) identity-checks a page BEFORE it is
// archived or confirms a show.
//
// Behavior is proven against the real helpers (require()d, CLAUDE.md §15).
// The scripts themselves reach these reads only after live fetches or over
// the private archive, so their wiring is proven the same way
// tests/unit/gather-reviews-archive-guard.test.mjs does: source inspection.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const {
  readCachedArchiveIfValid,
  makeArchiveShowChecker,
  makeArchiveCountGuard,
  checkArchivePageIdentity,
  createRejectedPageLedger,
} = require('./archive-cache-guard.js');

const page = (title, h1 = '') => `<html><head><title>${title}</title></head><body><h1>${h1}</h1>feedbacks</body></html>`;
const SHOWS = [
  { id: 'little-bear-ridge-road-regional-2024', slug: 'little-bear-ridge-road-regional', title: 'Little Bear Ridge Road', category: 'regional', openingDate: '2024-10-01' },
  { id: 'little-bear-ridge-road-2025', title: 'Little Bear Ridge Road', category: 'broadway', openingDate: '2025-11-20' },
  { id: 'hay-fever-2026', title: 'Hay Fever', category: 'west-end', openingDate: '2026-02-01' },
  { id: 'richard-ii-2026', title: 'Richard II', category: 'west-end', openingDate: '2026-03-01' },
];

// ---------------------------------------------------------------------------
// checkArchivePageIdentity: the pair Playbill Verdict Step 3 now runs
// ---------------------------------------------------------------------------

test('ACCEPTANCE (BRO-3608): a wrong-show page is rejected before the page validator (and its LLM) runs', async () => {
  let validatorCalls = 0;
  const r = await checkArchivePageIdentity(
    page('Hay Fever Reviews | Playbill', 'Hay Fever'),
    SHOWS[3],
    [],
    { validatePage: async () => { validatorCalls++; return { valid: true }; } },
  );
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.equal(validatorCalls, 0);
});

test('ACCEPTANCE (BRO-3608): the Broadway transfer page is rejected for its regional sibling', async () => {
  const siblings = { 'little-bear-ridge-road-regional-2024': ['broadway'] };
  const r = await checkArchivePageIdentity(
    page('Little Bear Ridge Road Broadway Reviews'),
    SHOWS[0],
    siblings['little-bear-ridge-road-regional-2024'],
    { validatePage: async () => ({ valid: true }) },
  );
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'cross-market-sibling');
});

test('checkArchivePageIdentity also enforces validatePageMatchesShow (year / production)', async () => {
  const seen = [];
  const r = await checkArchivePageIdentity(
    page('Little Bear Ridge Road Reviews'),
    SHOWS[1],
    [],
    { validatePage: async (html, title, opts) => { seen.push({ title, opts }); return { valid: false, reason: 'year mismatch' }; } },
  );
  assert.deepEqual(r, { ok: false, reason: 'year mismatch' });
  assert.deepEqual(seen, [{ title: 'Little Bear Ridge Road', opts: { openingYear: 2025, category: 'broadway' } }]);
});

test('checkArchivePageIdentity accepts the right page once both checks pass', async () => {
  let calls = 0;
  const r = await checkArchivePageIdentity(
    page('Richard II Reviews | Playbill', 'Critics review Richard II'),
    SHOWS[3],
    [],
    { validatePage: async () => { calls++; return { valid: true }; } },
  );
  assert.deepEqual(r, { ok: true });
  assert.equal(calls, 1);
});

// ---------------------------------------------------------------------------
// Rejected-page ledger: a rejected page costs one fetch per window, not per run
// ---------------------------------------------------------------------------

test('createRejectedPageLedger remembers a rejection per url + show, expires it, and survives a corrupt file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pv-ledger-'));
  const file = path.join(dir, 'ledger.json');
  let t = Date.parse('2026-10-01T00:00:00Z');
  const now = () => t;

  const a = createRejectedPageLedger(file, { now });
  assert.equal(a.recentRejection('https://p/x', 'richard-ii-2026'), null);
  a.record('https://p/x', 'richard-ii-2026', 'page-title-mismatch');
  a.save();

  const b = createRejectedPageLedger(file, { now });
  assert.equal(b.recentRejection('https://p/x', 'richard-ii-2026').reason, 'page-title-mismatch');
  // Same url matched to a DIFFERENT show is a new question, not a remembered no.
  assert.equal(b.recentRejection('https://p/x', 'hay-fever-2026'), null);
  // Rejecting it for a second show keeps the first rejection too.
  b.record('https://p/x', 'hay-fever-2026', 'wrong-market');
  assert.equal(b.recentRejection('https://p/x', 'richard-ii-2026').reason, 'page-title-mismatch');
  assert.equal(b.recentRejection('https://p/x', 'hay-fever-2026').reason, 'wrong-market');
  b.save();

  t += 15 * 24 * 60 * 60 * 1000;
  const c = createRejectedPageLedger(file, { now });
  assert.equal(c.recentRejection('https://p/x', 'richard-ii-2026'), null, 'expires after 14 days');
  c.save();
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), {}, 'expired rows are pruned on save');

  fs.writeFileSync(file, '{not json');
  assert.equal(createRejectedPageLedger(file, { now }).recentRejection('https://p/x', 'richard-ii-2026'), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Directory and count readers (BRO-3621)
// ---------------------------------------------------------------------------

test('makeArchiveShowChecker flags another show\'s page and resolves slug-named files', () => {
  const check = makeArchiveShowChecker(SHOWS);
  assert.ok(check(page('Hay Fever Reviews'), 'richard-ii-2026'), 'Hay Fever page under Richard II');
  assert.equal(check(page('Richard II Reviews'), 'richard-ii-2026'), null);
  // An older slug-named file is checked against its show, not waved through.
  assert.ok(check(page('Little Bear Ridge Road Broadway Reviews'), 'little-bear-ridge-road-regional'));
  assert.equal(check(page('Anything'), 'not-a-show'), null);
});

test('makeArchiveCountGuard returns an explicit wrong-show result and loads shows once', () => {
  let loads = 0;
  const guard = makeArchiveCountGuard(() => { loads++; return SHOWS; });
  const r = guard(page('Hay Fever Reviews'), 'richard-ii-2026');
  assert.equal(r.error, 'wrong-show');
  assert.equal(r.hasArchive, false);
  assert.equal(r.reviewCount, null);
  assert.equal(guard(page('Richard II Reviews'), 'richard-ii-2026'), null);
  assert.equal(loads, 1);
});

test('readCachedArchiveIfValid treats a file another reader already purged as "no cache"', () => {
  const missing = path.join(os.tmpdir(), `gone-${process.pid}-${Date.now()}.html`);
  assert.equal(readCachedArchiveIfValid(missing, 14, SHOWS[3], []), null);
});

// ---------------------------------------------------------------------------
// Wiring: every content/count reader of the archive calls the guard
// ---------------------------------------------------------------------------

const SCRIPTS = fileURLToPath(new URL('../', import.meta.url));
const src = (f) => fs.readFileSync(path.join(SCRIPTS, f), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1')).join('\n');

const DIR_READERS = {
  're-extract-aggregator-reviews.js': 3,
  'merge-aggregator-excerpts.js': 2,
  'merge-dtli-excerpts.js': 1,
  'extract-full-reviews.js': 1,
};
for (const [file, sites] of Object.entries(DIR_READERS)) {
  test(`${file}: every archive read is followed by the show-identity guard (${sites})`, () => {
    const s = src(file);
    assert.match(s, /makeArchiveShowChecker\(/);
    const reads = [...s.matchAll(/const (\w+) = fs\.readFileSync\(path\.join\((?:dtliDir|bwwDir|ssDir|BWW_DIR|SS_DIR), file\)|const (content) = fs\.readFileSync\(filePath/g)];
    assert.equal(reads.length, sites, 'archive read count changed; re-check the guard');
    const guards = s.match(/archiveShowChecker\(\w+, showId\)/g) || [];
    assert.equal(guards.length, sites);
  });
}

test('extract-show-score-reviews.js guards its archive read', () => {
  const s = src('extract-show-score-reviews.js');
  const read = s.indexOf("const html = fs.readFileSync(archiveFile, 'utf8')");
  const guard = s.indexOf('archiveShowChecker(html, showId)');
  assert.ok(read > 0 && guard > read, 'guard follows the archive read');
  assert.ok(guard < s.indexOf('extractShowData(html, showId', read), 'guard runs before extraction');
});

test('count readers use the shared wrong-show count guard', () => {
  for (const f of ['build-aggregator-truth.js', 'audit-aggregator-coverage.js']) {
    assert.match(src(f), /makeArchiveCountGuard\(/, f);
  }
  const cov = src('audit-aggregator-coverage.js');
  assert.equal((cov.match(/wrongShowArchive\(html, showId\)/g) || []).length, 3, 'PV, NYC Theatre, BWW /reviews/');
  assert.match(cov, /-wrong-show`/);
});

test('ACCEPTANCE (BRO-3608): Playbill Verdict Step 3 archives only AFTER the identity check passes', () => {
  const s = src('scrape-playbill-verdict.js');
  const step3 = s.slice(s.indexOf('for (const article of matchedArticles)'));
  const identity = step3.indexOf('checkArchivePageIdentity(html, matchedShow');
  const write = step3.indexOf('fs.writeFileSync(archivePath, html)');
  const confirm = step3.indexOf('fallbackTracker.confirmMatch(article.showId)');
  assert.ok(identity > 0, 'Step 3 runs checkArchivePageIdentity');
  assert.ok(write > identity, 'archive write comes after the identity check');
  assert.ok(confirm > identity, 'show is confirmed only after the identity check');
  assert.equal(step3.slice(0, identity).includes('fs.writeFileSync(archivePath'), false, 'no write before validation');
  assert.match(step3, /rejectedLedger\.recentRejection\(article\.url, article\.showId\)/);
});
