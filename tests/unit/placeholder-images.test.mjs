import { test, describe } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SHOWS_DIR = path.join(__dirname, '../../public/images/shows');

// Known "Coming Soon" placeholder file hashes (MD5)
// Keep in sync with PLACEHOLDER_FILE_HASHES in fetch-show-images-auto.js
const PLACEHOLDER_FILE_HASHES = new Set([
  'b4d7d1bdb443e0a94e69ac8a5abd6f40', // poster.webp (19,118 bytes) — variant 1
  'ac3ea27f64c633474ad93fd826f614e7', // thumbnail.webp (11,664 bytes) — variant 1
  '4aed489bb69c5c49be3315e3f85b342f', // hero.webp (28,998 bytes) — variant 1 (round-rect glow)
  '52968e9f240e2db8d7523ac053d019fb', // hero.webp (28,808 bytes) — variant 2 (oval glow)
  'da0408f33ffaff9c63baf108b53b1128', // hero.webp (25,372 bytes) — variant 3 (1440x580 landscape)
  '9d1b34a4045d176b1856ab38a852d47b', // thumbnail.webp (32,372 bytes) — variant 2 (square format)
]);

describe('placeholder image detection', () => {
  test('no show images on disk match known placeholder hashes', () => {
    if (!fs.existsSync(SHOWS_DIR)) {
      // Skip if images directory doesn't exist (e.g. CI without assets)
      return;
    }

    const violations = [];
    const showDirs = fs.readdirSync(SHOWS_DIR).filter(d =>
      fs.statSync(path.join(SHOWS_DIR, d)).isDirectory()
    );

    for (const dir of showDirs) {
      const dirPath = path.join(SHOWS_DIR, dir);
      const files = fs.readdirSync(dirPath).filter(f => /\.(webp|jpg|png)$/i.test(f));
      for (const file of files) {
        const filePath = path.join(dirPath, file);
        const buf = fs.readFileSync(filePath);
        const hash = crypto.createHash('md5').update(buf).digest('hex');
        if (PLACEHOLDER_FILE_HASHES.has(hash)) {
          violations.push(`${dir}/${file} (hash: ${hash})`);
        }
      }
    }

    assert.strictEqual(
      violations.length,
      0,
      `Found ${violations.length} placeholder image(s) on disk:\n  ${violations.join('\n  ')}\n\nThese should be removed or replaced with real art.`
    );
  });

  test('PLACEHOLDER_FILE_HASHES stays in sync with fetch-show-images-auto.js', () => {
    const scriptPath = path.join(__dirname, '../../scripts/fetch-show-images-auto.js');
    if (!fs.existsSync(scriptPath)) return;

    const content = fs.readFileSync(scriptPath, 'utf8');
    // Extract hashes from the script
    const match = content.match(/PLACEHOLDER_FILE_HASHES\s*=\s*new Set\(\[([\s\S]*?)\]\)/);
    assert.ok(match, 'Could not find PLACEHOLDER_FILE_HASHES in fetch-show-images-auto.js');

    const scriptHashes = new Set(
      [...match[1].matchAll(/'([a-f0-9]{32})'/g)].map(m => m[1])
    );

    // Check both directions
    for (const h of PLACEHOLDER_FILE_HASHES) {
      assert.ok(scriptHashes.has(h), `Test has hash ${h} not found in script`);
    }
    for (const h of scriptHashes) {
      assert.ok(PLACEHOLDER_FILE_HASHES.has(h), `Script has hash ${h} not found in test — update the test!`);
    }
  });
});
