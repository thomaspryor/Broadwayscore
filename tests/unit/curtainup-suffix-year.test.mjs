// BRO-4548: CurtainUp's only year signal is a two-digit filename suffix.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { curtainupSuffixYear, isUrlYearOutsideWindow } = require('../../scripts/lib/content-filters.js');
const { urlYearOf } = require('../../scripts/lib/url-discovery.js');
const NOW = new Date('2026-11-07T12:00:00Z');

test('reads the two-digit suffix only on curtainup.com, after a letter', () => {
  assert.equal(curtainupSuffixYear('https://www.curtainup.com/visitwtf14.html', NOW), 2014);
  assert.equal(curtainupSuffixYear('http://www.curtainup.com/frozenbway18', NOW), 2018);
  assert.equal(curtainupSuffixYear('https://www.curtainup.com/archive/x/hamlet99.html', NOW), 1999);
  assert.equal(curtainupSuffixYear('https://www.curtainup.com/1776.html', NOW), null); // title number
  assert.equal(curtainupSuffixYear('https://www.curtainup.com/play1984.html', NOW), null); // title year: the two digits follow a digit
  assert.equal(curtainupSuffixYear('https://www.curtainup.com/review90.html', NOW), null); // before CurtainUp existed
  assert.equal(curtainupSuffixYear('https://example.com/visitwtf14.html', NOW), null);
  assert.equal(curtainupSuffixYear('not a url', NOW), null);
});

test('isUrlYearOutsideWindow and urlYearOf reject the Williamstown 2014 page for a 2024 production', () => {
  const url = 'https://www.curtainup.com/visitwtf14.html';
  assert.equal(isUrlYearOutsideWindow(url, 2024, null), true);
  assert.equal(isUrlYearOutsideWindow(url, 2014, 2014), false);
  assert.equal(urlYearOf(url), 2014);
  // a /YYYY/ segment still wins, and other hosts are untouched
  assert.equal(isUrlYearOutsideWindow('https://www.curtainup.com/2024/visitwtf14.html', 2024, null), false);
  assert.equal(urlYearOf('https://example.com/visitwtf14.html'), null);
});

test('a title that ends in a number is never read as a year (review P1)', () => {
  assert.equal(curtainupSuffixYear('https://www.curtainup.com/catch22.html', NOW), null);
  assert.equal(curtainupSuffixYear('https://www.curtainup.com/apollo13.html', NOW), null);
  assert.equal(curtainupSuffixYear('https://www.curtainup.com/photograph51.html', NOW), null); // 1951 < 1996 floor
  assert.equal(curtainupSuffixYear('https://www.curtainup.com/ocean11.html', NOW), null); // static numbered title (2011 would be in range)
  assert.equal(isUrlYearOutsideWindow('https://www.curtainup.com/catch22.html', 2026, null), false);
  assert.equal(curtainupSuffixYear('https://www.curtainup.com/bronxtalebway16.html', NOW), 2016);
});
