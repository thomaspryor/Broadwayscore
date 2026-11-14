// Tailwind only generates classes it finds in the files listed under
// `content`. Helpers in src/config and src/lib return class names as strings
// (score-buckets getScoreBgColor, audience grades, commercial and gold-list
// badges); while those folders were unscanned, 18 of them were missing from
// the production CSS and rendered colourless (BRO-5519 review).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const config = fs.readFileSync(path.join(root, 'tailwind.config.ts'), 'utf8');

test('tailwind content scans the folders whose helpers return class names', () => {
  for (const dir of ['./src/config/', './src/lib/', './src/components/', './src/app/']) {
    assert.ok(config.includes(`'${dir}**/*.`), `tailwind.config.ts content does not scan ${dir}`);
  }
});

test('every class literal returned by src/config score-buckets lives in a scanned folder', () => {
  const src = fs.readFileSync(path.join(root, 'src/config/score-buckets.ts'), 'utf8');
  const classes = src.match(/'(?:text|bg)-[a-z]+-\d{3}(?:\/\d+)?'/g) || [];
  assert.ok(classes.length >= 8, `expected score-bucket colour classes, found ${classes.length}`);
});
