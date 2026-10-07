#!/usr/bin/env node
/**
 * Show Page Catalog — screenshot every curated show URL at desktop + mobile.
 *
 * Reads the slug list from src/app/dev/catalog/page.tsx (the CATALOG const),
 * then drives Playwright against http://localhost:3000 (default; override
 * with CATALOG_BASE_URL=...).
 *
 * Outputs PNGs + manifest.json to ~/Documents/claude-outputs/show-page-catalog/.
 * Bundle the folder as a single upload to Claude Design.
 *
 * Usage:
 *   # Terminal 1
 *   npm run dev
 *
 *   # Terminal 2
 *   node scripts/capture-show-page-catalog.mjs
 *
 *   # Skip a specific viewport: --no-mobile or --no-desktop
 *   # Custom output dir:        --out=/some/path
 *   # Custom base URL:          CATALOG_BASE_URL=https://demo.example
 */

import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { homedir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const CATALOG_SRC = join(REPO_ROOT, 'src/app/dev/catalog/catalog-data.mjs');

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const flagVal = (name) => {
  const m = argv.find((a) => a.startsWith(`${name}=`));
  return m ? m.split('=')[1] : null;
};

const BASE_URL = process.env.CATALOG_BASE_URL || 'http://localhost:3000';
const OUT_DIR = flagVal('--out') || join(homedir(), 'Documents/claude-outputs/show-page-catalog');
const DO_DESKTOP = !flag('--no-desktop');
const DO_MOBILE = !flag('--no-mobile');
const VIEWPORTS = [
  ...(DO_DESKTOP ? [{ name: 'desktop', width: 1440, height: 900 }] : []),
  ...(DO_MOBILE ? [{ name: 'mobile', width: 390, height: 844 }] : []),
];

/** Load catalog entries from the shared .mjs module. */
async function readCatalog() {
  const mod = await import(pathToFileURL(CATALOG_SRC).href);
  const groups = mod.CATALOG;
  if (!Array.isArray(groups)) {
    throw new Error('catalog-data.mjs did not export CATALOG as an array');
  }
  return groups.flatMap((g) => g.entries.map((e) => ({ ...e, group: g.heading })));
}

async function ensureServerUp() {
  const res = await fetch(BASE_URL).catch(() => null);
  if (!res || !res.ok) {
    throw new Error(
      `Dev server not reachable at ${BASE_URL}. Run \`npm run dev\` in another terminal first.`,
    );
  }
}

function fileSafe(s) {
  return s.replace(/[^a-z0-9-]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase();
}

async function capture() {
  const entries = await readCatalog();
  console.log(`Catalog has ${entries.length} entries across viewports: ${VIEWPORTS.map((v) => v.name).join(', ')}`);
  await ensureServerUp();
  await mkdir(OUT_DIR, { recursive: true });

  const browser = await chromium.launch();
  const manifest = {
    capturedAt: new Date().toISOString(),
    baseUrl: BASE_URL,
    viewports: VIEWPORTS,
    entries: [],
  };

  let groupIdx = 0;
  let lastGroup = null;

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.group !== lastGroup) {
      groupIdx += 1;
      lastGroup = entry.group;
    }
    const stem = `${String(groupIdx).padStart(2, '0')}-${String(i + 1).padStart(2, '0')}-${fileSafe(entry.slug)}`;
    const entryRecord = { ...entry, files: {} };

    for (const vp of VIEWPORTS) {
      const ctx = await browser.newContext({
        viewport: { width: vp.width, height: vp.height },
        deviceScaleFactor: 2,
        userAgent: vp.name === 'mobile'
          ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
          : 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      });
      const page = await ctx.newPage();
      const url = `${BASE_URL}/show/${entry.slug}`;
      let status = 'ok';
      try {
        const resp = await page.goto(url, { waitUntil: 'networkidle', timeout: 60_000 });
        if (!resp || !resp.ok()) {
          status = `http-${resp ? resp.status() : 'noresp'}`;
        }
        // Let lazy / hydration finish
        await page.waitForTimeout(800);
        // Auto-expand collapsibles that hide content from screenshot
        await page.evaluate(() => {
          document.querySelectorAll('details:not([open])').forEach((d) => d.setAttribute('open', ''));
        });
        await page.waitForTimeout(300);

        const filename = `${stem}__${vp.name}.png`;
        await page.screenshot({
          path: join(OUT_DIR, filename),
          fullPage: true,
          animations: 'disabled',
        });
        entryRecord.files[vp.name] = filename;
        console.log(`✓ ${stem} [${vp.name}] (${status})`);
      } catch (err) {
        entryRecord.files[vp.name] = null;
        entryRecord.error = String(err);
        console.error(`✗ ${stem} [${vp.name}] ${err.message}`);
      } finally {
        await ctx.close();
      }
      entryRecord.status = status;
    }

    manifest.entries.push(entryRecord);
  }

  // Also capture the catalog index itself
  for (const vp of VIEWPORTS) {
    const ctx = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      deviceScaleFactor: 2,
    });
    const page = await ctx.newPage();
    try {
      await page.goto(`${BASE_URL}/dev/catalog`, { waitUntil: 'networkidle', timeout: 30_000 });
      await page.waitForTimeout(300);
      await page.screenshot({
        path: join(OUT_DIR, `00-catalog-index__${vp.name}.png`),
        fullPage: true,
      });
      console.log(`✓ 00-catalog-index [${vp.name}]`);
    } catch (err) {
      console.error(`✗ catalog-index [${vp.name}] ${err.message}`);
    } finally {
      await ctx.close();
    }
  }

  await browser.close();
  await writeFile(join(OUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2));

  const okCount = manifest.entries.filter((e) => Object.values(e.files).some((f) => f)).length;
  console.log(`\nDone. ${okCount}/${entries.length} entries captured to ${OUT_DIR}`);
  if (okCount < entries.length) {
    process.exitCode = 1;
  }
}

capture().catch((err) => {
  console.error(err);
  process.exit(1);
});
