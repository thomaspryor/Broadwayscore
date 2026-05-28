'use strict';
/**
 * Generates the synthetic aggregator-article fixtures used by
 * scripts/lib/aggregator-candidate-extract.test.mjs.
 *
 * These mirror the real DOM shape we extract from:
 *  - BWW Review-Roundup pages: <title> + <h1> + JSON-LD LiveBlogPosting with a
 *    `headline` and per-critic `liveBlogUpdate[].datePublished`.
 *  - Playbill articles: <title> + <h1> + JSON-LD NewsArticle with
 *    `datePublished` and a <meta property="article:published_time">.
 *  - Bot-shell / block pages: tiny interstitial, or a body with no date.
 *
 * Run: node tests/fixtures/aggregator-candidates/_generate.js
 * Synthetic on purpose — no copyrighted article text. Bodies are padded with
 * filler so accept-cases clear the 5KB bot-shell size floor.
 */

const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const FILLER = (
  'Critics weighed in following the opening, with reactions spanning the ' +
  'full range from rave to pan. The production marks a notable entry in the ' +
  'season and drew a crowd of first-nighters. Below is a roundup of what the ' +
  'reviewers had to say about the staging, the performances, and the design. '
).repeat(12);

function bwwLiveBlog({ headline, dates }) {
  const updates = dates.map((d, i) => `{
      "@type": "BlogPosting",
      "headline": "Critic ${i + 1} - Review placeholder",
      "datePublished": "${d}",
      "articleBody": "."
    }`).join(',\n    ');
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8">
<title>${headline}</title>
</head><body>
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "LiveBlogPosting",
  "headline": "${headline}",
  "liveBlogUpdate": [
    ${updates}
  ]
}
</script>
<h1>${headline}</h1>
<article>
<p>${FILLER}</p>
<p>${FILLER}</p>
</article>
</body></html>`;
}

function playbillArticle({ headline, date, bodyExtra = '' }) {
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8">
<title>${headline} | Playbill</title>
<meta property="article:published_time" content="${date}">
</head><body>
<script type="application/ld+json">
{ "@context":"https://schema.org","@type":"NewsArticle","headline":"${headline}","datePublished":"${date}" }
</script>
<h1>${headline}</h1>
<article>
<p>${bodyExtra}</p>
<p>${FILLER}</p>
<p>${FILLER}</p>
</article>
</body></html>`;
}

const files = {
  // ACCEPT: BWW headline names the venue directly.
  'bww-dad-dont-read-this.html': bwwLiveBlog({
    headline: "Review Roundup: DAD DON'T READ THIS Opens at St. Luke's Theatre",
    dates: ['2026-05-15T19:00:00-04:00', '2026-05-15T22:00:00-04:00'],
  }),
  // TYPO: slug says AUTOPBIOGRAPHY, body has the correct AUTOBIOGRAPHY.
  'bww-celebrity-autopbiography.html': bwwLiveBlog({
    headline: 'Review Roundup: CELEBRITY AUTOBIOGRAPHY Opens on Broadway',
    dates: ['2026-05-18T20:00:00-04:00'],
  }),
  // ACCEPT (PV): leading-type-word venue "Theatre 71".
  'pv-broken-snow.html': playbillArticle({
    headline: 'Broken Snow Opens at Theatre 71',
    date: '2026-05-10T18:30:00-04:00',
  }),
  // ACCEPT (BWW): "at The West End Theatre".
  'bww-bedlam-othello.html': bwwLiveBlog({
    headline: "Review Roundup: BEDLAM'S OTHELLO at The West End Theatre",
    dates: ['2026-05-20T19:30:00-04:00'],
  }),
  // ACCEPT: placeholder headline ("Opens Off-Broadway") → venue from body prose.
  'bww-heated-rivalry.html': bwwLiveBlog({
    headline: 'Review Roundup: HEATED RIVALRY: THE UNAUTHORIZED MUSICAL PARODY Opens Off-Broadway',
    dates: ['2026-05-26T20:00:00-04:00'],
  }).replace('<p>' + FILLER + '</p>\n<p>' + FILLER + '</p>',
    '<p>Heated Rivalry began performances at the 6th Floor Theater on May 20. ' + FILLER + '</p>\n<p>' + FILLER + '</p>'),
  // BOT-SHELL: tiny Cloudflare interstitial (< 5KB).
  'bot-shell-cloudflare.html':
    '<!DOCTYPE html><html><head><title>Just a moment...</title></head>' +
    '<body><div id="cf-wrapper">Checking your browser before accessing.</div></body></html>',
  // BOT-SHELL: big page, has <h1>, but NO date anywhere (tests date signal).
  'bot-shell-no-date.html':
    '<!DOCTYPE html><html><head><title>Access</title></head><body>' +
    '<h1>Some Show at the Booth Theatre</h1><article><p>' + FILLER + '</p><p>' + FILLER + '</p></article></body></html>',
};

for (const [name, html] of Object.entries(files)) {
  fs.writeFileSync(path.join(DIR, name), html);
  console.log(`wrote ${name} (${html.length} bytes)`);
}
