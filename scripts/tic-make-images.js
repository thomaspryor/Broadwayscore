#!/usr/bin/env node
/**
 * Poster/thumbnail/hero art for staged Chicago shows (BRO-6518).
 *
 *   node scripts/tic-make-images.js --manifest=<manifest.json> [--only=id1,id2]
 *
 * theatreinchicago posters are small (often 300x300), so the art is placed
 * uncropped on a blurred, darkened copy of itself (poster 480x720, thumbnail
 * 300x450, hero 1600x1000), written as webp to public/images/shows/<id>/.
 * Shows with no poster get no images field (the site shows its placeholder).
 */
require('./lib/cli-help').exitOnHelp(module);
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

async function compose(buf, w, h) {
  const bg = await sharp(buf).resize(w, h, { fit: 'cover' }).blur(30).modulate({ brightness: 0.55 }).toBuffer();
  const fg = await sharp(buf).resize(w, h, { fit: 'inside', withoutEnlargement: false }).toBuffer();
  return sharp(bg).composite([{ input: fg, gravity: 'centre' }]).webp({ quality: 82 }).toBuffer();
}

async function main() {
  const arg = (n) => (process.argv.find((a) => a.startsWith(`--${n}=`)) || '').split('=').slice(1).join('=');
  const manifest = JSON.parse(fs.readFileSync(arg('manifest'), 'utf8'));
  const only = arg('only') ? new Set(arg('only').split(',')) : null;
  let made = 0, skipped = 0;
  for (const rec of Object.values(manifest.staged)) {
    const id = rec.show.id;
    if (only && !only.has(id)) continue;
    const dir = path.join(__dirname, '..', 'public', 'images', 'shows', id);
    if (fs.existsSync(path.join(dir, 'poster.webp'))) { skipped++; continue; }
    if (!rec.poster) { skipped++; continue; }
    try {
      const res = await fetch(rec.poster.startsWith('http') ? rec.poster : `https://www.theatreinchicago.com${rec.poster}`, { signal: AbortSignal.timeout(30000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'poster.webp'), await compose(buf, 480, 720));
      fs.writeFileSync(path.join(dir, 'thumbnail.webp'), await compose(buf, 300, 450));
      fs.writeFileSync(path.join(dir, 'hero.webp'), await compose(buf, 1600, 1000));
      rec.show.images = {
        poster: `/images/shows/${id}/poster.webp`,
        thumbnail: `/images/shows/${id}/thumbnail.webp`,
        hero: `/images/shows/${id}/hero.webp`,
      };
      made++;
    } catch (e) {
      console.log(`${id}: poster failed (${e.message})`);
      skipped++;
    }
  }
  fs.writeFileSync(arg('manifest'), JSON.stringify(manifest));
  console.log(`[images] made=${made} skipped=${skipped}`);
}
if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
