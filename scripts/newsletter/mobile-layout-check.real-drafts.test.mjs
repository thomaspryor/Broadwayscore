// LIVE-DATA-LANE: generates real drafts from data/shows.json + data/reviews.json (untracked core data) and renders them in Chromium. Runs in check-corpus-drift.yml, not test.yml's blocking batch (BRO-7101).
//
// Why (BRO-7530, ship-check 2026-11-15): the first version of the multi-width
// gate passed one hand-picked week and would have BLOCKED 5 of the last 6 real
// weekly drafts (Broadway overflow at 320px, the Biggest Movers box misjudged as
// a show card, a 300px height cap that long opera titles exceed). A gate that
// false-blocks the Monday draft is a regression too, so the thresholds are
// pinned against real Broadway AND West End issues, not fixtures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { WIDTHS, evaluateLayout, measureLayout } from './mobile-layout-check.mjs';

const require = createRequire(import.meta.url);
const repo = path.resolve(import.meta.dirname, '../..');
const WEEKS = ['2026-10-26', '2026-11-02', '2026-11-09'];

test('real Broadway and West End drafts pass the multi-width gate', async (t) => {
  if (!fs.existsSync(path.join(repo, 'data/shows.json')) || !fs.existsSync(path.join(repo, 'data/reviews.json'))) return t.skip('core data not present');
  let chromium, launchExtras;
  try { ({ chromium } = require('playwright')); ({ launchExtras } = require('../lib/playwright-exe.js')); } catch { return t.skip('playwright not installed'); }
  let browser;
  try { browser = await chromium.launch(launchExtras(chromium)); } catch { return t.skip('no chromium'); }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'newsletter-layout-real-'));
  t.after(async () => { await browser.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const problems = [];
  let measuredCards = 0;
  for (const edition of ['broadway', 'west-end']) {
    for (const week of WEEKS) {
      const out = path.join(dir, `${edition}-${week}`);
      execFileSync(process.execPath, ['scripts/newsletter/generate.mjs', week], {
        cwd: repo, timeout: 90_000, stdio: 'pipe',
        env: { ...process.env, GA4_PROPERTY_ID: '', NEWSLETTER_EDITION: edition, NEWSLETTER_OUT_DIR: out,
          NEWSLETTER_STATE_PATH: path.join(dir, 'state.json'), NEWSLETTER_AI_SUBJECT_DISABLED: '1' },
      });
      const html = path.join(out, `A-${week}.html`);
      for (const w of WIDTHS) {
        const page = await browser.newPage({ viewport: { width: w, height: 900 } });
        await page.goto('file://' + html);
        const m = await page.evaluate(measureLayout);
        measuredCards += m.cards.length;
        problems.push(...evaluateLayout(w, m).map((p) => `${edition} ${week}: ${p}`));
        await page.close();
      }
    }
  }
  assert.ok(measuredCards > 0, 'the gate measured no show cards at all (marker or selector drifted)');
  assert.deepEqual(problems, []);
});
