// BRO-6518: ingest-urls lines carry an optional listed critic; a bare "|" stays part of the URL.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { parseIngestLine, formatIngestLine } = require('./ingest-url-line.js');

test('plain URL and URL + outlet parse as before', () => {
  assert.deepEqual(parseIngestLine('https://a.com/r'), { url: 'https://a.com/r', outletOverride: null, listedCritic: null });
  assert.deepEqual(parseIngestLine('https://a.com/r nytimes'), { url: 'https://a.com/r', outletOverride: 'nytimes', listedCritic: null });
});

test('a listed critic is read after " | "', () => {
  assert.deepEqual(parseIngestLine('https://aroundthetownchicago.com/theatre-reviews/1776/ | Alan Bresloff'),
    { url: 'https://aroundthetownchicago.com/theatre-reviews/1776/', outletOverride: null, listedCritic: 'Alan Bresloff' });
  assert.deepEqual(parseIngestLine('https://a.com/r chicago-reader | Kerry Reid and Dan Jakes'),
    { url: 'https://a.com/r', outletOverride: 'chicago-reader', listedCritic: 'Kerry Reid and Dan Jakes' });
});

test('a bare pipe inside a real URL is not a separator', () => {
  const u = 'http://www.variety.com/review/VE1117944840?categoryid=33&cs=1&cmpid=RSS|News|LatestNews';
  assert.deepEqual(parseIngestLine(u), { url: u, outletOverride: null, listedCritic: null });
  assert.equal(parseIngestLine(`${u} | Marilyn Stasio`).url, u);
});

test('format and parse round-trip', () => {
  for (const e of [{ url: 'https://a.com/x' }, { url: 'https://a.com/x', outlet: 'variety' }, { url: 'https://a.com/x', critic: '  Julia  W. Rath ' }, { url: 'https://a.com/x', outlet: 'o', critic: 'Ed Tracy' }]) {
    const p = parseIngestLine(formatIngestLine(e));
    assert.equal(p.url, e.url);
    assert.equal(p.outletOverride, e.outlet || null);
    assert.equal(p.listedCritic, e.critic ? e.critic.replace(/\s+/g, ' ').trim() : null);
  }
});

test('an empty or doubled critic part never becomes an outlet or a piped name', () => {
  assert.deepEqual(parseIngestLine('https://a.com/r | '), { url: 'https://a.com/r', outletOverride: null, listedCritic: null });
  assert.equal(parseIngestLine('https://a.com/r | Jane Doe | extra').listedCritic, 'Jane Doe');
  assert.equal(parseIngestLine(formatIngestLine({ url: 'https://a.com/r', critic: 'Jane | Doe' })).listedCritic, 'Jane Doe');
});
