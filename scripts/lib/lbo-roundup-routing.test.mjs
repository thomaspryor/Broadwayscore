import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { matchLboRoundup, resolveLboRoundupProduction, readLboRoundupArchive } = require('./lbo-roundup-match');
const { checkArchiveCategory } = require('./archive-cache-guard');

const palladium = {
  id: 'jcs-palladium', title: 'Jesus Christ Superstar', category: 'west-end', status: 'closed',
  venue: 'London Palladium', previewsStartDate: '2026-06-20', openingDate: '2026-07-07', closingDate: '2026-09-05',
};
const drury = {
  ...palladium, id: 'jcs-drury', status: 'open', venue: 'Theatre Royal Drury Lane',
  previewsStartDate: '2026-10-16', openingDate: '2026-10-16', closingDate: '2027-01-09',
};
const grace = {
  id: 'grace-pervades-west-end-2026', title: 'Grace Pervades', category: 'west-end',
  venue: 'Theatre Royal Haymarket', openingDate: '2026-04-30', closingDate: '2026-07-11',
};
const page = (date) => `<html><head><title>Review Round Up: Jesus Christ Superstar - London Box Office</title>
  ${date ? `<meta property="article:published_time" content="${date}T09:00:00Z">` : ''}
  </head><body><article>Jesus Christ Superstar at the London Palladium.</article></body></html>`;

test('the known LBO transposition matches without accepting other misspellings', () => {
  assert.equal(matchLboRoundup('', 'GRACE PREVADES', [grace], { year: 2026 })?.show.id, grace.id);
  assert.equal(matchLboRoundup('', 'Grace Provides', [grace], { year: 2026 }), null);
});

test('the known LBO page-title typo passes the shared archive guard', () => {
  const html = '<title>Review Round Up: GRACE PREVADES - London Box Office</title>';
  assert.equal(checkArchiveCategory(html, grace).ok, true);
  assert.equal(checkArchiveCategory(html.replace('PREVADES', 'PROVIDES'), grace).ok, false);
  assert.equal(checkArchiveCategory(html.replace('London Box Office', 'Another Source'), grace).ok, false);
  assert.equal(checkArchiveCategory(html, { ...grace, title: 'Grace Provides' }).ok, false);
  assert.equal(checkArchiveCategory(html.replace('GRACE PREVADES', 'GRACE PREVADES (Broadway)'), { ...grace, category: 'regional' }, ['broadway']).ok, false);
});

test('July roundup routes to the Palladium even if Drury declares it as a prior run', () => {
  for (const later of [drury, { ...drury, priorRuns: [palladium] }]) {
    const r = resolveLboRoundupProduction({ html: page('2026-07-08'), show: later, shows: [palladium, later] });
    assert.equal(r.show.id, palladium.id);
    assert.equal(r.rerouted, true);
    assert.equal(r.prod.corroborated, true);
  }
});

test('an October roundup routes to Drury; an in-run Palladium roundup stays there', () => {
  assert.equal(resolveLboRoundupProduction({ html: page('2026-10-17'), show: palladium, shows: [palladium, drury] }).show.id, drury.id);
  assert.equal(resolveLboRoundupProduction({ html: page('2026-07-08'), show: palladium, shows: [palladium, drury] }).rerouted, false);
});

test('missing, unrelated and out-of-run dates cannot reroute into another production', () => {
  for (const date of [null, '2012-07-08']) {
    assert.equal(resolveLboRoundupProduction({ html: page(date), show: drury, shows: [palladium, drury] }).rerouted, false);
  }
  const related = page(null).replace('</head>', `<script type="application/ld+json">{"@graph":[
    {"@type":"NewsArticle","datePublished":"2026-07-08"},
    {"@type":"NewsArticle","datePublished":"2026-10-17"}]}</script></head>`);
  assert.equal(resolveLboRoundupProduction({ html: related, show: drury, shows: [palladium, drury] }).rerouted, false);
  assert.equal(resolveLboRoundupProduction({ html: page('2026-07-08'), show: drury, shows: [drury, { ...palladium, title: 'Another Musical' }] }).rerouted, false);
  const r = resolveLboRoundupProduction({ html: page('2012-07-08'), show: drury, shows: [palladium, drury] });
  assert.equal(r.prod.outOfRun, true);
});

test('a routed sibling cache is reused, while another URL or an expired cache is ignored', (t) => {
  const archiveDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lbo-routing-'));
  t.after(() => fs.rmSync(archiveDir, { recursive: true, force: true }));
  const url = 'https://www.londonboxoffice.co.uk/news/post/palladium-roundup';
  const args = { archiveDir, url, show: drury, shows: [palladium, drury] };
  fs.writeFileSync(path.join(archiveDir, `${drury.id}.html`), '<link rel="canonical" href="https://example.com/another-page">' + page('2026-10-17'));
  assert.equal(readLboRoundupArchive(args), null);
  const file = path.join(archiveDir, `${palladium.id}.html`);
  fs.writeFileSync(file, `<!-- Source: ${url} -->` + page('2026-07-08'));
  assert.equal(readLboRoundupArchive(args).show.id, palladium.id);
  const past = new Date(Date.now() - 15 * 86400000);
  fs.utimesSync(file, past, past);
  assert.equal(readLboRoundupArchive(args), null);
});
