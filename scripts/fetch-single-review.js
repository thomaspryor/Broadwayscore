const { fetchPage } = require('./lib/scraper');
const cheerio = require('cheerio');
const url = process.argv[2];
if (!url) { console.error('Usage: node fetch-single-review.js <url>'); process.exit(1); }
(async () => {
  const result = await fetchPage(url);
  const html = result && (result.html || result.content);
  if (html) {
    const doc = cheerio.load(html);
    doc('script, style').remove();
    let ps = [];
    doc('p').each((i, el) => { ps.push(doc(el).text().trim()); });
    const text = ps.filter(p => p.length > 30).join('\n\n');
    console.log('LENGTH:', text.length);
    console.log('---');
    console.log(text.substring(0, 5000));
  } else {
    console.log('FETCH FAILED');
  }
  setTimeout(() => process.exit(0), 500);
})();
