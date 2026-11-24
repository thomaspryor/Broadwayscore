// ESM entry for the URL→content mismatch detector (BRO-7060). The detector is
// CommonJS (scripts/lib/url-content-mismatch.js) so collect-review-texts.js and
// empty-body-retry.js can require() it; this re-exports the same functions.
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const mod = require('./url-content-mismatch.js');

export const {
  checkUrlContentMismatch,
  dedicatedReviewHeadlineWaiver,
  headlineProvesShow,
  loadCatalogTitles,
  UNRELIABLE_TITLE_OUTLETS,
  MIN_HEADLINE_ONLY_TEXT,
} = mod;
export default mod;
