#!/usr/bin/env node
/**
 * Regenerate PNGs for specific posts (both 1:1 and 4:5 sizes).
 * Usage: node regen-posts.js top5-running post03-top-plays post05-disagree
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const OUTPUT_DIR = path.join(__dirname, '../../public/og/social');
const names = process.argv.slice(2);

if (!names.length) {
  console.error('Usage: node regen-posts.js <name> [name2] ...');
  process.exit(1);
}

async function main() {
  const browser = await chromium.launch();

  for (const name of names) {
    const htmlPath = path.join(OUTPUT_DIR, `${name}.html`);
    if (!fs.existsSync(htmlPath)) {
      console.log(`Skip ${name}: no HTML at ${htmlPath}`);
      continue;
    }
    const baseHtml = fs.readFileSync(htmlPath, 'utf8');

    // 1:1 (2160x2160)
    {
      const pngPath = path.join(OUTPUT_DIR, `${name}.png`);
      const page = await browser.newPage();
      await page.setViewportSize({ width: 2160, height: 2160 });
      await page.setContent(baseHtml, { waitUntil: 'networkidle' });
      await page.screenshot({ path: pngPath, type: 'png' });
      await page.close();
      console.log(`Done: ${name}.png`);
    }

    // 4:5 (2160x2700) — same transforms as generate-all-posts.js
    {
      let html = baseHtml;
      html = html.replace('height: 2160px;', 'height: 2700px;');
      html = html.replace('padding: 96px 100px 80px;', 'padding: 120px 100px 100px;');
      html = html.replace(/gap: 32px;/, 'gap: 44px;');

      const pngPath = path.join(OUTPUT_DIR, `${name}-4x5.png`);
      const page = await browser.newPage();
      await page.setViewportSize({ width: 2160, height: 2700 });
      await page.setContent(html, { waitUntil: 'networkidle' });
      await page.screenshot({ path: pngPath, type: 'png' });
      await page.close();
      console.log(`Done: ${name}-4x5.png`);
    }
  }

  await browser.close();
  console.log('\nAll done.');
}

main().catch(console.error);
