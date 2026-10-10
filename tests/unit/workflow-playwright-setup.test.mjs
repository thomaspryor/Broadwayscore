// BRO-4326 / BRO-4401: fetch-all-image-formats.yml ran the image fetcher for
// months with no Playwright browser installed. Every Playwright attempt
// logged "browserType.launch: Executable doesn't exist" and fell through to
// Bright Data / Scrapingdog (53 wasted launches + paid fallbacks per run),
// and the job stayed green because the fallbacks succeeded. This pins the
// workflows whose main step is a public-site scraper (Playwright-first in
// scripts/lib/scraper.js's tier order) to the shared setup-playwright action.
//
// Scope is deliberately explicit: dozens of workflows run scripts that merely
// require() lib/scraper.js without ever hitting a public site (rebuilds,
// audits), so "every workflow that imports the scraper" would need dozens of
// exemptions and rot. The runtime half of this fix — a ::warning:: annotation
// from scraper.js the first time a run hits the missing-browser error under
// GITHUB_ACTIONS — covers every workflow this list does not name.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..', '..');

// script → why it is Playwright-first (a public site is its primary source)
const PLAYWRIGHT_FIRST_SCRIPTS = {
  'scripts/fetch-show-images-auto.js': 'todaytix.com / ibdb.com / playbill.com pages (BRO-4326)',
  'scripts/validate-show-venue.js': 'playbill.com production pages (BRO-2560)',
};

function workflowsRunning(script) {
  const dir = resolve(ROOT, '.github', 'workflows');
  return readdirSync(dir)
    .filter((f) => f.endsWith('.yml'))
    .filter((f) => new RegExp(`node\\s+(?:\\./)?${script.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(readFileSync(resolve(dir, f), 'utf8')));
}

describe('workflows whose main step is a Playwright-first scraper install a browser (BRO-4326)', () => {
  for (const [script, why] of Object.entries(PLAYWRIGHT_FIRST_SCRIPTS)) {
    test(`${script} (${why})`, () => {
      assert.ok(existsSync(resolve(ROOT, script)), `${script} must exist — update PLAYWRIGHT_FIRST_SCRIPTS if it moved`);
      const workflows = workflowsRunning(script);
      assert.ok(workflows.length > 0, `no workflow runs ${script}; update PLAYWRIGHT_FIRST_SCRIPTS if it was retired`);
      for (const wf of workflows) {
        const raw = readFileSync(resolve(ROOT, '.github', 'workflows', wf), 'utf8');
        assert.ok(
          raw.includes('./.github/actions/setup-playwright'),
          `.github/workflows/${wf} runs ${script} but never uses ./.github/actions/setup-playwright — ` +
            'every Playwright tier will fail with "Executable doesn\'t exist" and fall through to paid providers. ' +
            'Add "- name: Setup Playwright\\n  uses: ./.github/actions/setup-playwright" after "npm ci".',
        );
      }
    });
  }
});

describe('the shared action itself still installs a browser', () => {
  test('.github/actions/setup-playwright/action.yml runs npx playwright install', () => {
    const raw = readFileSync(resolve(ROOT, '.github', 'actions', 'setup-playwright', 'action.yml'), 'utf8');
    assert.match(raw, /npx playwright install/);
  });
});
