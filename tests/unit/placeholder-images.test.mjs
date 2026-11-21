import { test, describe } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const SHOWS_DIR = path.join(__dirname, '../../public/images/shows');

// Real source of truth — do not hardcode a second copy here, it drifts.
const { PLACEHOLDER_FILE_HASHES } = require('../../scripts/lib/show-images.js');

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

  test('fetch-show-images-auto.js imports PLACEHOLDER_FILE_HASHES from the shared lib (not a stale local copy)', () => {
    const scriptPath = path.join(__dirname, '../../scripts/fetch-show-images-auto.js');
    if (!fs.existsSync(scriptPath)) return;
    const content = fs.readFileSync(scriptPath, 'utf8');
    // Anchored on the destructure itself — a regex that only checks the two
    // substrings appear ANYWHERE in the file passes even if the import is
    // dropped, because the call sites (PLACEHOLDER_FILE_HASHES.has(...)) still
    // mention the name. This is the exact ReferenceError this test guards.
    assert.match(
      content,
      /const\s*\{[^}]*\bPLACEHOLDER_FILE_HASHES\b[^}]*\}\s*=\s*require\(['"]\.\/lib\/show-images['"]\)/,
      'fetch-show-images-auto.js must destructure PLACEHOLDER_FILE_HASHES from require("./lib/show-images"), not redefine it locally or leave it unimported'
    );
  });
});
