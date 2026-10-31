import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { extractPlaybillCastBilling, enrichCastBilling } = require('../../scripts/lib/playbill-cast-billing');
const { namedCast } = require('../../scripts/lib/reddit-opening-post');
const cheerio = require('cheerio');
const html = readFileSync(new URL('../fixtures/playbill-cast/lost-boys.html', import.meta.url), 'utf8');
const sourceUrl = 'https://playbill.com/production/the-lost-boys-broadway-palace-theatre-2026';
const firstFour = ['LJ Benet', 'Shoshana Bean', 'Ali Louis Bourzgui', 'Benjamin Pajak'];

test('saved Lost Boys HTML preserves billing order, not surname order', () => {
  const names = extractPlaybillCastBilling(html);
  assert.deepEqual(names.slice(0, 4), firstFour);
  assert.equal(names.length, 21);
  assert.equal(names.at(-1), 'Pierce Wheeler');
  assert.ok(!names.includes('David Hornsby'), 'production credits are excluded');
});

test('only the current tab counts, even with opening-night and unrelated person links first', () => {
  const $ = cheerio.load(html);
  const original = $('[data-nav-title]').filter((_, e) => /Opening Night/.test($(e).attr('data-nav-title'))).first();
  original.find('.bsp-list-promo-title a').first().text('Former performer');
  $('body').prepend(original);
  $('body').prepend('<a href="/person/unrelated">Unrelated person</a>');
  assert.deepEqual(extractPlaybillCastBilling($.html()).slice(0, 4), firstFour);
});

test('deduplicates names and decodes entities and whitespace from visible text', () => {
  const $ = cheerio.load(html);
  const current = $('[data-nav-title]').first();
  const title = current.find('.bsp-list-promo-title').first();
  title.find('a').html('  Ren&eacute;e\n &amp; Andr&eacute;  ');
  current.append(title.clone());
  const names = extractPlaybillCastBilling($.html());
  assert.equal(names[0], 'Renée & André');
  assert.equal(names.length, 21);
});

test('missing, empty, blocked and opening-night-only HTML cannot invent billing', () => {
  const $ = cheerio.load(html);
  $('[data-nav-title]').filter((_, e) => /Current/.test($(e).attr('data-nav-title'))).remove();
  for (const input of [undefined, null, '', '<title>Just a moment...</title>', $.html()]) {
    assert.deepEqual(extractPlaybillCastBilling(input), []);
    const show = { status: 'open', castBilling: ['Verified performer'] };
    assert.equal(enrichCastBilling(show, input, sourceUrl, { force: true }), false);
    assert.deepEqual(show.castBilling, ['Verified performer']);
  }
});

test('minified production HTML keeps the same order', () => {
  assert.deepEqual(extractPlaybillCastBilling(html.replace(/>\s+</g, '><')), extractPlaybillCastBilling(html));
});

test('billing can enrich an existing large cast without changing that cast', () => {
  const cast = extractPlaybillCastBilling(html).map(name => ({ name })).reverse();
  const show = { status: 'open', cast };
  assert.deepEqual(namedCast(show), []);
  assert.equal(enrichCastBilling(show, html, sourceUrl), true);
  assert.deepEqual(namedCast(show), firstFour);
  assert.equal(show.cast, cast);
  assert.equal(enrichCastBilling(show, html, sourceUrl), false, 'idempotent');
  assert.equal(enrichCastBilling(show, html, sourceUrl, { force: true }), false, 'unchanged even with force');
});

test('previews and billing-only records work; historical shows stay untouched', () => {
  const preview = { status: 'previews' };
  assert.equal(enrichCastBilling(preview, html, sourceUrl), true);
  assert.deepEqual(namedCast(preview), firstFour);
  for (const status of ['closed', 'announced', undefined]) {
    const show = { status };
    assert.equal(enrichCastBilling(show, html, sourceUrl), false);
    assert.equal(show.castBilling, undefined);
  }
});

test('missing and mismatched source identity cannot write another production\'s billing', () => {
  for (const url of [undefined, '', sourceUrl + '-other']) {
    const show = { status: 'open' };
    assert.equal(enrichCastBilling(show, html, url), false);
    assert.equal(show.castBilling, undefined);
  }
  const $ = cheerio.load(html);
  $('link[rel="canonical"]').remove();
  assert.equal(enrichCastBilling({ status: 'open' }, $.html(), sourceUrl), false);
});

test('preserves existing billing unless forced, and never clears it on a bad source', () => {
  const show = { status: 'open', castBilling: ['Previously verified performer'] };
  assert.equal(enrichCastBilling(show, html, sourceUrl), false);
  assert.deepEqual(show.castBilling, ['Previously verified performer']);
  assert.equal(enrichCastBilling(show, '<title>Blocked</title>', sourceUrl, { force: true }), false);
  assert.equal(enrichCastBilling(show, html, sourceUrl + '-other', { force: true }), false);
  assert.deepEqual(show.castBilling, ['Previously verified performer']);
  assert.equal(enrichCastBilling(show, html, sourceUrl, { force: true }), true);
  assert.deepEqual(show.castBilling.slice(0, 4), firstFour);
});
