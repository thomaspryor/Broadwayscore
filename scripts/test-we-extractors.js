#!/usr/bin/env node
/**
 * Step 0: Verify existing star extractors work on real WE review pages.
 * Fetches one page per outlet and runs extractScore(). Reports pass/fail.
 */

const { fetchPage } = require('./lib/scraper');
const { extractScore } = require('./lib/score-extractors');

const TESTS = [
  { outlet: 'telegraph', url: 'https://www.telegraph.co.uk/theatre/what-to-see/the-producers-garrick-theatre-review/', expectedStars: '4/5' },
  { outlet: 'timeout-london', url: 'https://www.timeout.com/london/theatre/mj-the-musical-review', expectedStars: '3/5' },
  { outlet: 'standard', url: 'https://www.standard.co.uk/culture/theatre/the-producers-garrick-theatre-review-mel-brooks-b1247818.html', expectedStars: '5/5' },
  { outlet: 'independent', url: 'https://www.independent.co.uk/arts-entertainment/theatre-dance/reviews/the-producers-musical-menier-chocolate-factory-mel-brooks-b2661942.html', expectedStars: '4/5' },
  { outlet: 'whatsonstage', url: 'https://www.whatsonstage.com/news/mj-the-musical-west-end-review-an-exhilarating-jukebox-musical/', expectedStars: '4/5' },
  { outlet: 'thestage', url: 'https://www.thestage.co.uk/reviews/reviews/the-producers-review-garrick-theatre-london-mel-brooks-patrick-marber-andy-nyman', expectedStars: '4/5' },
  { outlet: 'artsdesk', url: 'https://theartsdesk.com/theatre/producers-garrick-theatre-review-ve-haf-vays-making-you-laugh', expectedStars: '4/5' },
  { outlet: 'daily-mail', url: 'https://www.dailymail.co.uk/tvshowbiz/reviews/article-14576489/The-Producers-review-Garrick-Theatre-London.html', expectedStars: '4/5' },
  { outlet: 'broadwayworld', url: 'https://www.broadwayworld.com/westend/article/Review-THE-PRODUCERS-Garrick-Theatre-20250915', expectedStars: '5/5' },
];

async function main() {
  let pass = 0, fail = 0;

  for (const test of TESTS) {
    process.stdout.write(`${test.outlet}: fetching... `);
    try {
      const r = await fetchPage(test.url, { timeout: 20000, retries: 1 });
      const html = typeof r === 'string' ? r : (r?.content || '');

      if (!html || html.length < 200) {
        console.log(`FAIL — empty response (${html.length} bytes)`);
        fail++;
        continue;
      }

      const result = extractScore(html, '', test.outlet);

      if (result && result.originalScore) {
        const match = String(result.originalScore).match(/^(\d+(?:\.\d+)?)\s*\/\s*(\d+)/);
        const extracted = match ? `${match[1]}/${match[2]}` : result.originalScore;
        const expectedMatch = test.expectedStars.match(/^(\d+(?:\.\d+)?)\s*\/\s*(\d+)/);
        const expected = expectedMatch ? `${expectedMatch[1]}/${expectedMatch[2]}` : test.expectedStars;

        if (extracted === expected) {
          console.log(`PASS ✓ — ${result.originalScore} [${result.source}]`);
          pass++;
        } else {
          console.log(`WRONG — got ${result.originalScore} [${result.source}], expected ${test.expectedStars}`);
          fail++;
        }
      } else {
        // Check if the HTML even has star-related content
        const hasStarImg = /\dstars?\.png/i.test(html);
        const hasJsonLd = /ratingValue/i.test(html);
        const hasSvgStar = /star.*active|star.*filled|star.*svg/i.test(html);
        console.log(`FAIL — no score extracted (hasStarImg=${hasStarImg}, hasJsonLd=${hasJsonLd}, hasSvgStar=${hasSvgStar})`);
        fail++;
      }
    } catch (err) {
      console.log(`FAIL — ${(err.message || '').substring(0, 60)}`);
      fail++;
    }

    await new Promise(r => setTimeout(r, 2000));
  }

  console.log(`\n=== Results: ${pass} PASS, ${fail} FAIL ===`);
}

main().catch(err => { console.error(err); process.exit(1); });
