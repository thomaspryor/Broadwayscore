/** BRO-8343: off-West-End SERP hits must name the show and venue on the page. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { discoverOfficialUrl } = require('./official-url-discovery.js');

const show = { id: 'janet-street-porter-off-west-end-2026', title: 'Janet Street Porter', venue: 'The Other Palace', category: 'off-west-end' };
const serp = async () => [{ url: 'https://www.janetstreetporter.com/pix-archive', title: 'Janet Street Porter official' }];
const head = async () => 200;

test('columnist photo archive naming the title but not the venue is refused', async () => {
  const html = '<p>Janet Street Porter pix archive: photos from my columns over the years.</p>';
  assert.equal(await discoverOfficialUrl(show, { serp, head, fetchHtml: async () => html }), null);
});

test('unreachable page content fails closed', async () => {
  assert.equal(await discoverOfficialUrl(show, { serp, head, fetchHtml: async () => null }), null);
});

test('page naming show and venue is accepted', async () => {
  const html = '<p>Janet Street Porter, live at The Other Palace, London. Book now.</p>';
  assert.equal(await discoverOfficialUrl(show, { serp, head, fetchHtml: async () => html }), 'https://www.janetstreetporter.com/pix-archive');
});

test('Broadway shows are not page-checked (fetch never called)', async () => {
  const b = { id: 'x', title: 'Janet Street Porter', venue: 'Y', category: 'broadway' };
  const r = await discoverOfficialUrl(b, { serp, head, fetchHtml: async () => { throw new Error('no'); } });
  assert.equal(r, 'https://www.janetstreetporter.com/pix-archive');
});
