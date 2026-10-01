/**
 * Static social-preview images in public/og must stay under WhatsApp's ~300 KB
 * link-preview limit (BRO-4395). beat-the-critics.png was 344 KB, so its
 * previews were silently dropped. Reads the real files, no logic copied.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const OG_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'public', 'og');
const LIMIT = 300 * 1024;

const images = readdirSync(OG_DIR).filter(f => /\.(png|jpe?g|webp)$/i.test(f));

test('public/og has preview images to check', () => {
  assert.ok(images.length >= 5, `expected the OG image set, found ${images.length}`);
});

for (const f of images) {
  test(`public/og/${f} is under 300 KB`, () => {
    const size = statSync(join(OG_DIR, f)).size;
    assert.ok(size < LIMIT, `${f} is ${size} B; WhatsApp drops previews over ~300 KB`);
  });
}
