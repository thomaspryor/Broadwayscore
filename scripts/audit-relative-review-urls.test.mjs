import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { classifyRelativeUrl } = require('./lib/relative-review-url.js');
const { scan, main } = require('./audit-relative-review-urls.js');

test('classifier: absolute and empty urls are fine', () => {
  assert.equal(classifyRelativeUrl('https://www.nytimes.com/x', 'nytimes').category, 'ok');
  assert.equal(classifyRelativeUrl('', 'nytimes').category, 'ok');
  assert.equal(classifyRelativeUrl(undefined, 'nytimes').category, 'ok');
});

test('classifier: BroadwayWorld relatives get the host, other outlets do not', () => {
  assert.deepEqual(classifyRelativeUrl('/chicago/article/BWW-Review-X', 'broadwayworld'), { category: 'bww-relative', fixedUrl: 'https://www.broadwayworld.com/chicago/article/BWW-Review-X' });
  assert.equal(classifyRelativeUrl('/article/Review-Y', 'broadwayworld').fixedUrl, 'https://www.broadwayworld.com/article/Review-Y');
  assert.equal(classifyRelativeUrl('/article/Review-Y', 'nypost').category, 'other');
});

test('classifier: typos and schemeless hosts repair, profile and saved-page paths do not', () => {
  assert.equal(classifyRelativeUrl('hhttp://abcnews.go.com/a', 'ap').fixedUrl, 'http://abcnews.go.com/a');
  assert.equal(classifyRelativeUrl('ttps://nystagereview.com/a', 'nysr').fixedUrl, 'https://nystagereview.com/a');
  assert.equal(classifyRelativeUrl(' https://www.nytimes.com/a', 'nytimes').fixedUrl, 'https://www.nytimes.com/a');
  assert.equal(classifyRelativeUrl('www.vulture.com/2023/04/x.html', 'vulture').fixedUrl, 'https://www.vulture.com/2023/04/x.html');
  assert.equal(classifyRelativeUrl('variety.com/2023/legit/x', 'variety').category, 'schemeless');
  assert.equal(classifyRelativeUrl('/people/Ben-Brantley', 'nytimes').category, 'people');
  assert.equal(classifyRelativeUrl('../reviews/thurgood/nypostreview.html', 'nypost').category, 'dotdot');
  assert.equal(classifyRelativeUrl("There's enough energy in the first act", 'nypost').category, 'other');
});

test('audit scan: counts categories on a fixture tree and --strict fails on any', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rel-url-'));
  fs.mkdirSync(path.join(root, 'show-a'));
  fs.writeFileSync(path.join(root, 'show-a', 'ok.json'), JSON.stringify({ url: 'https://a.com/x', outletId: 'a' }));
  fs.writeFileSync(path.join(root, 'show-a', 'bww.json'), JSON.stringify({ url: '/article/Z', outletId: 'broadwayworld' }));
  const rows = scan(root);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].fixedUrl, 'https://www.broadwayworld.com/article/Z');
  const log = console.log; console.log = () => {};
  try { assert.equal(main([`--root=${root}`, '--strict']), 1); } finally { console.log = log; }
  fs.rmSync(path.join(root, 'show-a', 'bww.json'));
  console.log = () => {};
  try { assert.equal(main([`--root=${root}`, '--strict']), 0); } finally { console.log = log; }
});
