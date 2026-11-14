// BRO-4604: the daily UX walkthrough must catch header overflow at tablet
// widths (BRO-4575 clipped Sign in and the hamburger at 640-1100px and shipped
// unnoticed because the walkthrough only rendered 390 and 1440 and measured
// document scrollWidth, which a position:fixed header never widens).
//
// The fixture header takes the real search wrapper class from
// src/components/HeaderSearch.tsx, so reverting `lg:block` to `sm:block`
// there changes what this test renders.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { chromium } from 'playwright';
import {
  captureTabletHeader, headerOverflowFindings, TABLET_VIEWPORT,
} from './lib/header-overflow-probe.mjs';

const SRC = readFileSync(new URL('../src/components/HeaderSearch.tsx', import.meta.url), 'utf8');
const WALKTHROUGH = readFileSync(new URL('./ux-walkthrough.mjs', import.meta.url), 'utf8');

// Same fallback as scripts/check-header-overflow.mjs.
const PREINSTALLED = process.env.PW_CHROMIUM_EXECUTABLE || '/opt/pw-browsers/chromium';
async function launch() {
  try { return await chromium.launch(); } catch (e) {
    if (!/Executable doesn't exist/.test(String(e?.message))) throw e;
    // The plain unit-test batch (unit-test-collection.js) has no Playwright
    // browser; skip there rather than fail. Browser jobs and cloud have one.
    if (!existsSync(PREINSTALLED)) return null;
    return chromium.launch({ executablePath: PREINSTALLED });
  }
}

const searchClass = SRC.match(/\{\/\* Desktop search input \*\/\}\s*<div className="([^"]+)"/)?.[1];

function fixtureHtml(desktopSearchClass) {
  return `<!doctype html><meta name="viewport" content="width=device-width">
<style>
*{box-sizing:border-box} body{margin:0}
.hidden{display:none} .block{display:block} .flex{display:flex}
@media (min-width:640px){.sm\\:block{display:block}.sm\\:flex{display:flex}}
@media (min-width:1024px){.lg\\:block{display:block}.lg\\:hidden{display:none}}
header{position:fixed;top:0;left:0;right:0;height:64px}
nav{display:flex;align-items:center;gap:8px;flex-wrap:nowrap}
nav a,nav button,nav input{flex:none;display:block;height:40px}
.logo{width:180px}.link{width:100px}.search input{width:280px}.signin{width:90px}.burger{width:44px}
</style>
<header class="fixed top-0"><nav>
  <a class="logo" href="/">Broadway Scorecard</a>
  <a class="link" href="/a">Shows</a><a class="link" href="/b">Browse</a><a class="link" href="/c">Tonys</a>
  <div class="${desktopSearchClass}"><input class="search" type="text" placeholder="Search"></div>
  <button class="signin" aria-label="Sign in">Sign in</button>
  <button class="burger lg:hidden" aria-label="Open menu">Menu</button>
</nav></header>`;
}

async function findingsFor(browser, desktopSearchClass, width = TABLET_VIEWPORT.width) {
  const context = await browser.newContext({ viewport: { width, height: TABLET_VIEWPORT.height } });
  try {
    const page = await context.newPage();
    await page.setContent(fixtureHtml(desktopSearchClass));
    return await headerOverflowFindings(page, 'tablet', 'home');
  } finally {
    await context.close();
  }
}

test('fixture tracks the real HeaderSearch desktop wrapper class', () => {
  assert.ok(searchClass, 'could not find the "Desktop search input" wrapper in HeaderSearch.tsx');
  assert.match(searchClass, /\blg:block\b/, 'HeaderSearch must stay hidden below lg (BRO-4575)');
});

test('walkthrough renders a 768px tablet viewport and runs the header probe', () => {
  assert.equal(TABLET_VIEWPORT.width, 768);
  assert.match(WALKTHROUGH, /import \{[^}]*captureTabletHeader[^}]*\} from '\.\/lib\/header-overflow-probe\.mjs'/);
  assert.match(WALKTHROUGH, /await captureTabletHeader\(/);
});

test('header overflow at 768px is reported when lg:block is reverted to sm:block, and not otherwise', async (t) => {
  const browser = await launch();
  if (!browser) return t.skip('no Chromium available');
  try {
    const fixed = await findingsFor(browser, searchClass);
    assert.deepEqual(fixed, [], `real class must not overflow: ${JSON.stringify(fixed)}`);

    const reverted = await findingsFor(browser, searchClass.replace('lg:block', 'sm:block'));
    assert.equal(reverted.length, 1, 'reverted class must produce one header overflow finding');
    assert.match(reverted[0].summary, /Header overflow on home \(tablet\)/);
    assert.equal(reverted[0].severity, 'high');

    // The old document-level probe could not see this: the fixed header does not widen the page.
    const context = await browser.newContext({ viewport: { width: 768, height: 1024 } });
    let docOverflow;
    try {
      const page = await context.newPage();
      await page.setContent(fixtureHtml(searchClass.replace('lg:block', 'sm:block')));
      docOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    } finally {
      await context.close();
    }
    assert.ok(docOverflow <= 1, `fixed header should not widen the document (got ${docOverflow}px)`);
  } finally {
    await browser.close();
  }
});

test('a page without the header nav is logged, not filed', async (t) => {
  const browser = await launch();
  if (!browser) return t.skip('no Chromium available');
  const errs = [];
  const orig = console.error; console.error = (m) => errs.push(m);
  try {
    const page = await browser.newPage({ viewport: { width: 768, height: 1024 } });
    await page.setContent('<h1>Maintenance</h1>');
    assert.deepEqual(await headerOverflowFindings(page, 'tablet', 'home'), []);
    assert.ok(errs.some((m) => /header nav not found/.test(m)));
  } finally {
    console.error = orig;
    await browser.close();
  }
});

test('captureTabletHeader degrades to no findings when the page cannot load', async (t) => {
  const browser = await launch();
  if (!browser) return t.skip('no Chromium available');
  const errs = [];
  const orig = console.error; console.error = (m) => errs.push(m);
  try {
    const { findings } = await captureTabletHeader({ browser, baseUrl: 'http://127.0.0.1:1' });
    assert.deepEqual(findings, []);
    assert.ok(errs.some((m) => /header probe \(tablet\) failed/.test(m)));
  } finally {
    console.error = orig;
    await browser.close();
  }
});
