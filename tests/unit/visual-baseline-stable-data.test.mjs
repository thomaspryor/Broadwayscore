// BRO-7649: a visual-regression baseline must not render live, mutable show
// data. main Test Suite went red 7h+ on 2026-11-17 when Hamilton's LLM Critics'
// Take was regenerated (and 43 -> 45 reviews) with no code change, because
// tests/e2e/visual-regression.spec.ts screenshots production on every push.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const { findUnfrozenLiveScreenshots, visitsLiveRoute } = require(path.join(ROOT, 'scripts/lib/visual-baseline-live-data.js'));

const E2E_DIR = path.join(ROOT, 'tests/e2e');
const specs = fs.readdirSync(E2E_DIR).filter((f) => f.endsWith('.spec.ts'));

test('every live-route screenshot in tests/e2e freezes its data first', () => {
  const screenshotSpecs = specs.filter((f) => fs.readFileSync(path.join(E2E_DIR, f), 'utf8').includes('toHaveScreenshot'));
  assert.ok(screenshotSpecs.includes('visual-regression.spec.ts'), 'visual-regression.spec.ts should be scanned');
  const offenders = [];
  for (const f of screenshotSpecs) {
    for (const name of findUnfrozenLiveScreenshots(fs.readFileSync(path.join(E2E_DIR, f), 'utf8'))) {
      offenders.push(`${f}: "${name}"`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    'These screenshot live production data without freezeLiveShowData() (tests/e2e/helpers/freeze-live-data.ts):\n' +
      offenders.join('\n'),
  );
});

test('visual-regression.spec.ts is classified as live (guards the guard)', () => {
  const src = fs.readFileSync(path.join(E2E_DIR, 'visual-regression.spec.ts'), 'utf8');
  assert.equal(visitsLiveRoute(src), true);
});

test('the hero test requires the Critics\' Take to be pinned', () => {
  const src = fs.readFileSync(path.join(E2E_DIR, 'visual-regression.spec.ts'), 'utf8');
  assert.match(src, /freezeLiveShowData\(page, HERO, \{ requireCriticsTake: true \}\)/);
});

test('helper pins Critics\' Take, digits and the breakdown bar', () => {
  const helper = fs.readFileSync(path.join(E2E_DIR, 'helpers/freeze-live-data.ts'), 'utf8');
  assert.match(helper, /critics' take/);
  assert.match(helper, /replace\(\/\\d\/g, '8'\)/);
  assert.match(helper, /reviews\?:/);
});

test('flags an unfrozen live screenshot, passes frozen and mock ones', () => {
  const live = `const SHOW_URL = '/show/x';
test('hero', async ({ page }) => { await page.goto(SHOW_URL); await expect(h).toHaveScreenshot('a.png'); });`;
  assert.deepEqual(findUnfrozenLiveScreenshots(live), ['hero']);

  const frozen = `const SHOW_URL = '/show/x';
test('hero', async ({ page }) => { await freezeLiveShowData(page, H); await expect(h).toHaveScreenshot('a.png'); });`;
  assert.deepEqual(findUnfrozenLiveScreenshots(frozen), []);

  const frozenAfter = `const SHOW_URL = '/show/x';
test('hero', async ({ page }) => { await expect(h).toHaveScreenshot('a.png'); await freezeLiveShowData(page, H); });`;
  assert.deepEqual(findUnfrozenLiveScreenshots(frozenAfter), ['hero']);

  const hook = `const SHOW_URL = '/show/x';
test.beforeEach(async ({ page }) => { await freezeLiveShowData(page, H); });
test('hero', async ({ page }) => { await expect(h).toHaveScreenshot('a.png'); });`;
  assert.deepEqual(findUnfrozenLiveScreenshots(hook), []);

  const mock = `const FIXTURE_URL = '/test/ugc-fixture';
test('grid', async ({ page }) => { await page.goto(FIXTURE_URL); await expect(h).toHaveScreenshot('a.png'); });`;
  assert.deepEqual(findUnfrozenLiveScreenshots(mock), []);

  const mockQuery = `const MOCK_URL = '/my-shows?mock=1';
test('grid', async ({ page }) => { await page.goto(\`\${MOCK_URL}&tab=x\`); await expect(h).toHaveScreenshot('a.png'); });`;
  assert.deepEqual(findUnfrozenLiveScreenshots(mockQuery), []);
});

test('reviewer-found bypasses are closed (comments, strings, names, unseen navigation)', () => {
  const commented = `const SHOW_URL = '/show/x';
test('hero', async ({ page }) => { // await freezeLiveShowData(page, H);
  await expect(h).toHaveScreenshot('a.png'); });`;
  assert.deepEqual(findUnfrozenLiveScreenshots(commented), ['hero']);

  const braceInString = `const SHOW_URL = '/show/x';
test('a', async ({ page }) => { const s = '}'; await freezeLiveShowData(page, H); });
test('b', async ({ page }) => { await expect(h).toHaveScreenshot('b.png'); });`;
  assert.deepEqual(findUnfrozenLiveScreenshots(braceInString), ['b']);

  const apostrophe = `const SHOW_URL = '/show/x';
test("Critics' Take", async ({ page }) => { await expect(h).toHaveScreenshot('a.png'); });`;
  assert.deepEqual(findUnfrozenLiveScreenshots(apostrophe), ["Critics' Take"]);

  const unseenNav = `test('hero', async ({ page }) => { await gotoShow(page, 'hamilton'); await expect(h).toHaveScreenshot('a.png'); });`;
  assert.deepEqual(findUnfrozenLiveScreenshots(unseenNav), ['hero']);

  const pathConst = `const SHOW_PATH = '/show/x';
test('hero', async ({ page }) => { await page.goto(BASE + SHOW_PATH); await expect(h).toHaveScreenshot('a.png'); });`;
  assert.deepEqual(findUnfrozenLiveScreenshots(pathConst), ['hero']);

  const fnForm = `const SHOW_URL = '/show/x';
test('hero', async function ({ page }) { await expect(h).toHaveScreenshot('a.png'); });
test('later', async ({ page }) => { await freezeLiveShowData(page, H); });`;
  assert.deepEqual(findUnfrozenLiveScreenshots(fnForm), ['hero']);

  const mockHelper = `test('grid', async ({ page }) => { await goToMock(page, 'diary'); await expect(h).toHaveScreenshot('a.png'); });`;
  assert.deepEqual(findUnfrozenLiveScreenshots(mockHelper), []);
});
