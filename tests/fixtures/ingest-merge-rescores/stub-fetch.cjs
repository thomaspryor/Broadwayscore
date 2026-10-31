// Run the real ingestion pipeline offline with a page supplied by the test.
const fs = require('fs');
require('../../../scripts/lib/scraper.js').fetchPage = async () => ({
  content: fs.readFileSync(process.env.INGEST_MERGE_PAGE, 'utf8'),
});
