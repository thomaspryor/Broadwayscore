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

/**
 * The REAL Playbill DOM shape, as served on playbill.com (verified against the
 * live Rhinoceros Verdict article, 2026-08-24):
 *   - NO <meta property="article:published_time"> at all, and
 *   - the NewsArticle (with datePublished) nested inside a schema.org @graph.
 *
 * playbillArticle() above is the older, more generous synthetic shape - it
 * emits BOTH a meta tag and a top-level NewsArticle, so it passed isBotShell()
 * no matter how the JSON-LD was walked. That is exactly why the missing
 * @graph descent went unnoticed until a real article was rejected as
 * reason='bot-shell'. Keep BOTH shapes: the generous one guards the simple
 * path, this one guards the path production actually takes.
 */
function playbillGraphArticle({ headline, date, venue, reviewLinks = [] }) {
  const links = reviewLinks
    .map(u => `<p><a href="${u}">Read the review</a></p>`)
    .join('\n');
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8">
<title>${headline} | Playbill</title>
</head><body>
<script type="application/ld+json">
{ "@context":"https://schema.org","@graph":[
  { "@type":"NewsArticle","headline":"${headline}",
    "dateCreated":"${date}","datePublished":"${date}",
    "description":"The production is running at ${venue}." }
] }
</script>
<h1>${headline}</h1>
<article>
<p>The production is running at ${venue}.</p>
${links}
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
  // ACCEPT (PV, real shape): @graph-nested NewsArticle, NO published_time
  // meta, and Playbill's interrogative house-style headline. Regression
  // fixture for the Rhinoceros at A.R.T. miss (2026-08-24) - this article was
  // rejected as 'bot-shell' because the date lived inside @graph.
  'pv-rhinoceros-graph.html': playbillGraphArticle({
    headline: 'Reviews: What Did Critics Think of Rhinoceros Starring Paul Giamatti and John Turturro?',
    date: '2026-08-24T09:57:00-04:00',
    venue: 'the American Repertory Theater in Cambridge, Massachusetts',
    reviewLinks: [
      'https://www.bostonglobe.com/2026/08/24/arts/rhinoceros-review/',
      'https://nystagereview.com/2026/08/24/rhinoceros/',
      'https://www.boston.com/culture/theater/2026/08/24/rhinoceros/',
    ],
  }),
  // REJECT (PV): a freeform interrogative headline no lead-in list covers.
  // Slug and body carry the SAME question, so the title-delta symmetry check
  // returns 'match' - only isUnparsedQuestionTitle stops it becoming a show.
  'pv-unparsed-question.html': playbillGraphArticle({
    headline: "Were Reviewers 'Diggin' On' the TLC Musical CrazySexyCool at Arena Stage?",
    date: '2026-08-19T10:00:00-04:00',
    venue: 'Arena Stage in Washington, D.C.',
    reviewLinks: [
      'https://www.washingtonpost.com/theater-dance/2026/08/19/crazysexycool/',
      'https://dctheaterarts.org/2026/08/19/crazysexycool/',
      'https://www.broadwayworld.com/washington-dc/crazysexycool',
    ],
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
