// BRO-7270: title for a staged regional/city production. Source headings can be
// CSS-uppercase; validate-data.js errors on shouted titles, so convert at ingest.
const { classifyShowTitle } = require('./title-display-case');

/** @returns {{title:string, manualReview:boolean}} */
function stagedTitle(id, title) {
  const r = classifyShowTitle(id, title);
  return { title: r.title, manualReview: r.action === 'manual-review' };
}
module.exports = { stagedTitle };
