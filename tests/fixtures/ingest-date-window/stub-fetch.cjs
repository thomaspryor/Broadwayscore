// Preload for tests/unit/ingest-date-window.test.mjs: replace fetchPage with a
// canned review page dated $STUB_PUBLISH_DATE so the real ingest script runs
// offline; $STUB_FETCH_FAIL makes the fetch fail instead.
const scraper = require('../../../scripts/lib/scraper.js');
scraper.fetchPage = async () => {
  if (process.env.STUB_FETCH_FAIL) throw new Error('HTTP 403 stub');
  const date = process.env.STUB_PUBLISH_DATE;
  const meta = date ? `<meta property="article:published_time" content="${date}T10:00:00Z">` : '';
  const body = 'Spamalot rolls into the Buell Theatre this week with a touring company that keeps every Python bit intact. '.repeat(30);
  return { content: `<html><head><title>Review: Spamalot at the Buell</title>${meta}</head><body><article><h1>Review: Spamalot</h1><p>By Jane Critic</p><p>${body}</p></article></body></html>` };
};
