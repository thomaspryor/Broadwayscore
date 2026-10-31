import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const shadow = require('../../scripts/lib/opening-night-lane-shadow');
const caps = require('../../scripts/lib/scrapingdog-caps');
const telemetry = require('../../scripts/lib/provider-telemetry');
const NIGHT = '2026-10-29';
const NOW = Date.parse(`${NIGHT}T23:00:00Z`);

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shadow-spend-'));
  const keys = ['SCRAPER_SPEND_LEDGER_PATH', 'SCRAPER_SPEND_PURPOSE', 'SCRAPER_SPEND_SHOW_ID',
    'SD_PRESS_NIGHT_CAP_MODE', 'SD_PRESS_NIGHT_CAP_DISABLED', 'SD_PRESS_NIGHT_CAP_USD', 'BD_TELEMETRY_DISABLED'];
  const previous = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  t.after(() => {
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(dir, { recursive: true, force: true });
    caps._resetForTests();
  });
  for (const k of keys) delete process.env[k];
  process.env.SCRAPER_SPEND_LEDGER_PATH = path.join(dir, 'spend.jsonl');
  t.mock.method(console, 'log', () => {});
  return dir;
}

function options(dir, show, discover, now = NOW) {
  return {
    show, night: show.openingDate, openingDate: show.openingDate, ledgerDir: path.join(dir, show.id),
    adapters: [{ name: 'roundup', kind: 'aggregator', phase: 'main', discover }],
    fetchText: async () => '', fetchReview: async () => ({}), scoreReview: async () => 80,
    publishPorts: shadow.createShadowPublishPorts({ onRows: () => {} }),
    now: () => now, wait: async () => {}, maxPasses: 1, dryRun: true,
  };
}

test('shadow discovery records per-show press-night spend in all three markets and restores the dispatch scope', async t => {
  const dir = setup(t);
  process.env.SCRAPER_SPEND_PURPOSE = 'dispatch-purpose';
  process.env.SCRAPER_SPEND_SHOW_ID = 'dispatch-show';
  for (const category of ['broadway', 'west-end', 'off-west-end']) {
    const show = { id: `shadow-${category}`, title: 'Shadow', category, openingDate: NIGHT };
    const result = await shadow.runShadowNight(options(dir, show, async () => {
      await Promise.resolve();
      assert.equal(process.env.SCRAPER_SPEND_PURPOSE, `press-night:${show.id}:${NIGHT}`);
      assert.equal(process.env.SD_PRESS_NIGHT_CAP_MODE, 'warn');
      telemetry.recordSdCall({ host: 'serp.scrapingdog', credits: 5, success: true });
      return [];
    }));
    assert.deepEqual(result.errors, []);
    assert.equal(process.env.SCRAPER_SPEND_PURPOSE, 'dispatch-purpose');
    assert.equal(process.env.SD_PRESS_NIGHT_CAP_MODE, undefined);
    assert.equal(telemetry.currentSpendShowId(), 'dispatch-show');
  }
  const rows = fs.readFileSync(process.env.SCRAPER_SPEND_LEDGER_PATH, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(rows.length, 3);
  for (const row of rows) assert.equal(row.purpose, `press-night:${row.showId}:${NIGHT}`);
});

test('shadow discovery still runs over the cap, warns, and records the next call', async t => {
  const dir = setup(t);
  const show = { id: 'shadow-over-cap', title: 'Shadow', category: 'broadway', openingDate: NIGHT };
  const purpose = `press-night:${show.id}:${NIGHT}`;
  fs.writeFileSync(process.env.SCRAPER_SPEND_LEDGER_PATH, `${JSON.stringify({ purpose, provider: 'brightdata', credits: 1400 })}\n`);
  const warnings = [];
  t.mock.method(console, 'warn', message => warnings.push(message));
  caps._resetForTests();
  let discovered = false;
  await shadow.runShadowNight(options(dir, show, async () => {
    const status = caps.pressNightCapStatus();
    assert.equal(status.warnOnly, true);
    assert.equal(status.exceeded, false);
    assert.ok(status.spentUsd > status.capUsd);
    discovered = true;
    telemetry.recordSdCall({ host: 'serp.scrapingdog', credits: 5, success: true });
    return [];
  }));
  assert.equal(discovered, true);
  assert.match(warnings.join('\n'), /continuing fetches \(warn-only\)/);
  const rows = fs.readFileSync(process.env.SCRAPER_SPEND_LEDGER_PATH, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(rows.length, 2);
  assert.equal(rows[1].purpose, purpose);
  assert.equal(rows[1].showId, show.id);
});

test('shadow restores spend state after rejection and clears an inherited tag outside the opening window', async t => {
  const dir = setup(t);
  const show = { id: 'shadow-cleanup', title: 'Shadow', category: 'broadway', openingDate: NIGHT };
  const inherited = 'press-night:another-show:2026-10-29';
  process.env.SCRAPER_SPEND_PURPOSE = inherited;
  process.env.SD_PRESS_NIGHT_CAP_MODE = 'warn';
  const invalid = options(dir, show, async () => []);
  delete invalid.fetchText;
  await assert.rejects(shadow.runShadowNight(invalid), /fetchText is required/);
  assert.equal(process.env.SCRAPER_SPEND_PURPOSE, inherited);
  assert.equal(process.env.SD_PRESS_NIGHT_CAP_MODE, 'warn');
  assert.equal(telemetry.currentSpendShowId(), null);
  let discovered = false;
  await shadow.runShadowNight(options(dir, show, async () => {
    discovered = true;
    assert.equal(process.env.SCRAPER_SPEND_PURPOSE, '');
    assert.equal(process.env.SD_PRESS_NIGHT_CAP_MODE, undefined);
    assert.equal(telemetry.currentSpendShowId(), show.id);
    return [];
  }, Date.parse('2026-12-01T23:00:00Z')));
  assert.equal(discovered, true);
  assert.equal(process.env.SCRAPER_SPEND_PURPOSE, inherited);
  assert.equal(process.env.SD_PRESS_NIGHT_CAP_MODE, 'warn');
});
