// TESTS-VS-DERIVED-DATA-EXEMPT: shows.json reads are stubbed; billing expectations use the checked-in Playbill HTML fixture.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const fs = require('node:fs');
const path = require('node:path');
const scraper = require('../../scripts/lib/scraper');
const { scrapePlaybillCast } = require('../../scripts/scrape-cast-changes');
const { enrichCastBillingFromSnapshot } = require('../../scripts/lib/playbill-cast-billing');
const { namedCast } = require('../../scripts/lib/reddit-opening-post');
const html = fs.readFileSync(new URL('../fixtures/playbill-cast/lost-boys.html', import.meta.url), 'utf8');
const sourceUrl = 'https://playbill.com/production/the-lost-boys-broadway-palace-theatre-2026';
const firstFour = ['LJ Benet', 'Shoshana Bean', 'Ali Louis Bourzgui', 'Benjamin Pajak'];
const makeShow = (overrides = {}) => ({ id: 'the-lost-boys-2026', status: 'open', category: 'broadway', ...overrides });

function stubSource(t, urls, response = { content: html }) {
  const read = fs.readFileSync;
  const registry = path.resolve('data/playbill-urls.json');
  t.mock.method(fs, 'readFileSync', function(file, ...args) {
    if (path.resolve(String(file)) === registry) return JSON.stringify({ shows: urls });
    return read.call(this, file, ...args);
  });
  return t.mock.method(scraper, 'fetchPage', async () => response);
}

test('existing Playbill fetch persists billing with a new baseline and no events', async (t) => {
  const show = makeShow();
  const fetch = stubSource(t, { [show.id]: sourceUrl });
  const existing = { shows: {} };
  assert.deepEqual(await scrapePlaybillCast([show], existing), {});
  assert.equal(fetch.mock.callCount(), 1, 'billing must reuse the cast fetch');
  assert.deepEqual(fetch.mock.calls[0].arguments, [sourceUrl, { renderJs: false }]);
  const saved = JSON.parse(JSON.stringify(existing));
  assert.equal(saved.shows[show.id].currentCast.length, 21);
  assert.deepEqual(saved.shows[show.id].castBilling.names.slice(0, 4), firstFour);
  assert.equal(enrichCastBillingFromSnapshot(show, saved.shows[show.id].castBilling, sourceUrl), true);
  assert.deepEqual(namedCast(show), firstFour);
});

test('an unchanged baseline still collects billing without replacing manual show billing', async (t) => {
  const show = makeShow({ castBilling: ['Verified performer'] });
  const fetch = stubSource(t, { [show.id]: sourceUrl });
  const existing = { shows: {} };
  await scrapePlaybillCast([show], existing);
  delete existing.shows[show.id].castBilling;
  const baseline = structuredClone(existing.shows[show.id].currentCast);
  assert.deepEqual(await scrapePlaybillCast([show], existing), {});
  assert.deepEqual(existing.shows[show.id].currentCast, baseline);
  assert.equal(fetch.mock.callCount(), 2, 'one fetch per show per run');
  assert.deepEqual(existing.shows[show.id].castBilling.names.slice(0, 4), firstFour);
  assert.equal(enrichCastBillingFromSnapshot(show, existing.shows[show.id].castBilling, sourceUrl), false);
  assert.deepEqual(show.castBilling, ['Verified performer']);
});

test('preview billing is collected, while closed shows, wrong URLs and other markets stay untouched', async (t) => {
  const preview = makeShow({ status: 'previews' });
  const closed = makeShow({ id: 'closed-production', status: 'closed' });
  const wrong = makeShow({ id: 'other-production' });
  const london = makeShow({ id: 'london-production', category: 'west-end' });
  const missing = makeShow({ id: 'unmapped-production' });
  const fetch = stubSource(t, { [preview.id]: sourceUrl, [closed.id]: sourceUrl,
    [wrong.id]: sourceUrl + '-other', [london.id]: sourceUrl });
  const existing = { shows: {} };
  await scrapePlaybillCast([preview, closed, wrong, london, missing], existing);
  assert.equal(fetch.mock.callCount(), 3);
  assert.deepEqual(existing.shows[preview.id].castBilling.names.slice(0, 4), firstFour);
  for (const show of [closed, wrong, london, missing]) {
    assert.equal(existing.shows[show.id]?.castBilling, undefined);
  }
});

test('blocked and empty responses preserve previously collected billing', async (t) => {
  const show = makeShow();
  const fetch = stubSource(t, { [show.id]: sourceUrl });
  const existing = { shows: {} };
  await scrapePlaybillCast([show], existing);
  const before = structuredClone(existing);
  for (const content of ['', '<title>Just a moment...</title>', '<html>' + 'blocked '.repeat(100) + '</html>']) {
    fetch.mock.mockImplementation(async () => ({ content }));
    assert.deepEqual(await scrapePlaybillCast([show], existing), {});
    assert.deepEqual(existing, before);
  }
});

// Run the actual main/write path in isolation. Stub only filesystem I/O and the
// network, so zero-event early returns and dry-run behavior remain production code.
function runMain({ dryRun = false, existingBilling = false } = {}) {
  const output = execFileSync(process.execPath, ['-e', String.raw`
    const assert = require('node:assert/strict');
    const fs = require('node:fs');
    const path = require('node:path');
    process.argv = [process.execPath, 'scripts/scrape-cast-changes.js', '--source=playbill-cast'];
    if (process.env.BILLING_TEST_DRY_RUN === '1') process.argv.push('--dry-run');
    const { main } = require('./scripts/scrape-cast-changes');
    const scraper = require('./scripts/lib/scraper');
    const { extractPlaybillCastBilling } = require('./scripts/lib/playbill-cast-billing');
    const html = fs.readFileSync('tests/fixtures/playbill-cast/lost-boys.html', 'utf8');
    const sourceUrl = 'https://playbill.com/production/the-lost-boys-broadway-palace-theatre-2026';
    const id = 'the-lost-boys-2026';
    const existing = { shows: { [id]: {
      currentCast: extractPlaybillCastBilling(html).map(name => ({ name, role: 'Unknown' })),
      upcoming: [], history: [],
    } } };
    if (process.env.BILLING_TEST_EXISTING === '1') {
      existing.shows[id].castBilling = { names: extractPlaybillCastBilling(html), sourceUrl };
    }
    const files = new Map([
      [path.resolve('data/cast-changes.json'), existing],
      [path.resolve('data/shows.json'), { shows: [{ id, status: 'open', category: 'broadway' }] }],
      [path.resolve('data/playbill-urls.json'), { shows: { [id]: sourceUrl } }],
    ]);
    const read = fs.readFileSync;
    fs.readFileSync = (file, ...args) => files.has(path.resolve(String(file)))
      ? JSON.stringify(files.get(path.resolve(String(file)))) : read(file, ...args);
    const exists = fs.existsSync;
    fs.existsSync = file => files.has(path.resolve(String(file))) || exists(file);
    const writes = [];
    fs.writeFileSync = (file, value) => writes.push({ file: path.resolve(String(file)), value: JSON.parse(value) });
    fs.mkdirSync = () => {};
    fs.copyFileSync = () => {};
    fs.readdirSync = () => [];
    let fetches = 0;
    scraper.fetchPage = async () => { fetches++; return { content: html }; };
    main().then(() => {
      assert.equal(fetches, 1);
      console.log('SAVED_BILLING:' + JSON.stringify(writes.filter(w => w.file === path.resolve('data/cast-changes.json'))));
    }).catch(e => { console.error(e); process.exitCode = 1; });
  `], {
    cwd: path.resolve(new URL('../../', import.meta.url).pathname),
    env: { ...process.env, BILLING_TEST_DRY_RUN: dryRun ? '1' : '0', BILLING_TEST_EXISTING: existingBilling ? '1' : '0' },
    encoding: 'utf8', timeout: 30000,
  });
  return JSON.parse(output.split('\n').find(line => line.startsWith('SAVED_BILLING:')).slice('SAVED_BILLING:'.length));
}

test('main saves billing-only updates even when no cast events changed', () => {
  const writes = runMain();
  assert.equal(writes.length, 1);
  const saved = writes[0].value.shows['the-lost-boys-2026'];
  assert.deepEqual(saved.upcoming, []);
  assert.deepEqual(saved.castBilling.names.slice(0, 4), firstFour);
});

test('main does not write billing in dry-run mode or when the snapshot is unchanged', () => {
  assert.deepEqual(runMain({ dryRun: true }), []);
  assert.deepEqual(runMain({ existingBilling: true }), []);
});
