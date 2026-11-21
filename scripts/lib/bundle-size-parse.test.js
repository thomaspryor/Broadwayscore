'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseBuildOutput } = require('./bundle-size-parse.js');

const SAMPLE = [
  'Route (app)                                 Size  First Load JS  Revalidate  Expire',
  '┌ ○ /                                     9.47 kB         172 kB',
  '├ ○ /my-shows                            15.1 kB         177 kB',
  '├ ● /show/[slug]                            168 B         289 kB          1d      1y',
  '├   ├ /show/hamilton-2015',
  '├ ƒ /api/thing                            260 B          104 kB',
  '├ ● /show/[slug]/opengraph-image            257 B          104 kB',
  '├ ƒ /reviews/feed.xml                       260 B          104 kB',
  '└ ○ /west-end                            6.97 kB         169 kB',
  '+ First Load JS shared by all              104 kB',
  '  ├ chunks/0937d497-daa99a23a4431317.js   54.2 kB',
].join('\n');

test('parses ┌ rows, byte-sized own code, and ISR columns', () => {
  const { pages, sharedJS } = parseBuildOutput(SAMPLE);
  assert.equal(pages['/'], 172);
  assert.equal(pages['/show/[slug]'], 289);
  assert.equal(pages['/my-shows'], 177);
  assert.equal(pages['/west-end'], 169);
  assert.equal('/api/thing' in pages, false, 'route handlers are not pages');
  assert.equal(sharedJS, 104);
  // Prerendered child paths and chunk rows are not routes.
  assert.equal(Object.keys(pages).some((k) => k.startsWith('chunks/') || k === '/show/hamilton-2015'), false);
});

test('MB first-load sizes convert to kB', () => {
  const { pages } = parseBuildOutput('├ ○ /huge   2 kB   1.5 MB');
  assert.equal(pages['/huge'], 1536);
});
