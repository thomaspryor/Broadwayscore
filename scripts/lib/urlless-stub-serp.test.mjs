// BRO-7171 Stage 4: the opening-night poller looks for links to url-less stubs
// and attaches them to the stub, not to a new sibling file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { urllessStubSlots, attachSerpUrlsToStubs } = require('./urlless-stub-serp.js');
const { updateFileUrlWithInvariant } = require('./url-change-invariant.js');
const { isReviewTextFile } = require('./review-text-sidecars.js');

function showDir(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'urlless-'));
  for (const [name, data] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), JSON.stringify(data));
  return dir;
}

const ctx = { inWindow: true, isReviewTextFile };

test('slots: one url-less live file per outlet only; linked, excluded and two-file outlets are skipped', () => {
  const dir = showDir({
    'guardian--arifa-akbar.json': { outletId: 'guardian', criticName: 'Arifa Akbar', url: null, aggregatorStars: 4 },
    'ft--sarah-hemming.json': { outletId: 'ft', criticName: 'Sarah Hemming', url: 'https://www.ft.com/content/x' },
    'times-uk--a.json': { outletId: 'times-uk', criticName: 'A', url: '' },
    'times-uk--b.json': { outletId: 'times-uk', criticName: 'B', url: '' },
    'telegraph--c.json': { outletId: 'telegraph', criticName: 'C', url: '', wrongProduction: true },
  });
  const slots = urllessStubSlots(dir, ctx);
  assert.deepEqual([...slots.keys()], ['guardian']);
  assert.equal(urllessStubSlots(dir, { ...ctx, inWindow: false }).size, 0, 'outside the opening window: nothing');
});

test('attach: the SERP link lands on the stub through the url invariant; no sibling, score kept', () => {
  const dir = showDir({ 'guardian--arifa-akbar.json': { outletId: 'guardian', criticName: 'Arifa Akbar', url: null, aggregatorStars: 4, showId: 'x-2026' } });
  const slots = urllessStubSlots(dir, ctx);
  const url = 'https://www.theguardian.com/stage/2026/nov/08/x-review';
  const other = { outletId: 'ft', url: 'https://www.ft.com/content/y' };
  const out = attachSerpUrlsToStubs([{ outletId: 'guardian', url }, other], slots,
    (fp, u) => updateFileUrlWithInvariant(fp, u, { urlSource: 'opening-night-poller-serp' }, { stampOnNoop: true }));
  assert.equal(out.attached.length, 1);
  assert.deepEqual(out.remaining, [other], 'only the unmatched result goes on to create files');
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'guardian--arifa-akbar.json'), 'utf8'));
  assert.equal(saved.url, url);
  assert.equal(saved.aggregatorStars, 4);
  assert.equal(saved.criticName, 'Arifa Akbar');
  assert.deepEqual(fs.readdirSync(dir), ['guardian--arifa-akbar.json']);
});

test('poller wiring: stub outlets are queued before SERP and attached before SERP results create files', () => {
  const src = fs.readFileSync(new URL('../opening-night-poller.js', import.meta.url), 'utf8');
  const queue = src.indexOf('urllessStubSlots(path.join(REVIEW_TEXTS_DIR, SHOW_ID)');
  const serp = src.indexOf('serpResults = await runSERPBackup(');
  const attach = src.indexOf('attachSerpUrlsToStubs(serpResults, urllessSlots');
  const create = src.indexOf('processDiscoveredReviews(SHOW_ID, serpResults');
  assert.ok(queue > 0 && serp > queue, 'slots are computed before the SERP call');
  assert.ok(attach > serp && create > attach, 'attach runs between SERP and file creation');
  assert.match(src.slice(attach, attach + 300), /updateFileUrlWithInvariant\([\s\S]*stampOnNoop: true/);
});

test('attach: a refused write (another outlet\'s domain) leaves the stub alone and the result unconsumed', () => {
  const dir = showDir({ 'guardian--arifa-akbar.json': { outletId: 'guardian', criticName: 'Arifa Akbar', url: null } });
  const slots = urllessStubSlots(dir, ctx);
  const wrong = { outletId: 'guardian', url: 'https://www.telegraph.co.uk/theatre/what-to-see/x-review/' };
  const out = attachSerpUrlsToStubs([wrong], slots,
    (fp, u) => updateFileUrlWithInvariant(fp, u, {}, { stampOnNoop: true }));
  assert.equal(out.attached.length, 0);
  assert.equal(out.refused.length, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'guardian--arifa-akbar.json'), 'utf8')).url, null);
});
