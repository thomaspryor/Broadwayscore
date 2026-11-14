// Profitability Scorecard link previews (BRO-6149): every /biz page names its own
// 1200x630 card that exists on disk, and the card files have the true size.
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { bizOgImage, seasonOgImage } from '../../src/lib/biz-og';

const ROOT = path.resolve(__dirname, '..', '..');
const png = (url: string) => path.join(ROOT, 'public', url.replace(/^https?:\/\/[^/]+/, ''));

test('every topic and home card is a real 1200x630 PNG', () => {
  for (const slug of ['home', 'musicals-since-reopening', 'reviews-and-money', 'fastest-recoups', 'biggest-flops', 'tony-winners', 'stunt-casting'] as const) {
    const img = bizOgImage(slug, 'x');
    assert.ok(existsSync(png(img.url)), `${img.url} missing: run node scripts/generate-biz-og-images.js`);
    const b = readFileSync(png(img.url));
    assert.deepStrictEqual([b.readUInt32BE(16), b.readUInt32BE(20)], [1200, 630], slug);
    assert.ok(b.length < 300 * 1024, `${slug} over WhatsApp's ~300 KB preview limit`);
  }
});

test('a season without its own card falls back to the generic season card, never a 404', () => {
  assert.match(seasonOgImage('1850-1851').url, /\/og\/biz\/season\.png$/);
  assert.ok(existsSync(png(seasonOgImage('1850-1851').url)));
  assert.match(seasonOgImage('2024-2025').url, /season-2024-2025\.png$/);
});

test('every biz page wires its card and a share button', () => {
  const dir = path.join(ROOT, 'src/app/biz');
  const pages = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  for (const p of pages) {
    const f = p === 'season' ? path.join(dir, p, '[season]', 'page.tsx') : path.join(dir, p, 'page.tsx');
    const src = readFileSync(f, 'utf8');
    assert.match(src, /bizOgImage|seasonOgImage/, `${p} still uses the generic site card`);
    assert.match(src, /ShareButton|TopicPageShell|BizHeader/, `${p} has no share button`);
  }
});
