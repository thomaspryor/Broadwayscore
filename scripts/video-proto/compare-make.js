#!/usr/bin/env node
// Compare plan for the automatic video lane (BRO-7418): one New York production against its London run, built from the
// show ids by compare-plan.js (the fixed script and caption template, BRO-6412), then copy-reviewed like every other plan.
// The template is not rewritten here: a review that would change the words blocks the video, because render.js refuses a
// compare plan that is not the template's own output.
// usage: node compare-make.js <newYorkId> <londonId> <outDir> [name]      -> <outDir>/<name>.plan.json (exit 1 = blocked)
require('../lib/llm-usage-install'); // LLM spend meter: before any client is built (BRO-5043)
const fs = require('fs'), path = require('path');
const { buildPlan, assertTemplate } = require('./compare-plan');
const { meta } = require('./showdata');
const { isBroadwayCategory } = require('../lib/venue-classification.js');

const tagFor = t => '#' + t.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/^The /, '').replace(/[^A-Za-z0-9]/g, '');
const yearOf = m => String(m.openingDate || m.previewsStartDate || '').slice(0, 4);

/** Pure: the two sides, London first (the template says "also reviewed in London" about it), from shows.json rows. */
function sidesOf(ny, london) {
  const nyPlace = isBroadwayCategory(ny) ? 'Broadway' : 'Off-Broadway';
  return [{ id: london.id, place: 'London', city: 'London', label: `London ${yearOf(london)}` },
    { id: ny.id, place: nyPlace, city: 'New York', label: `${nyPlace} ${yearOf(ny)}` }];
}
/** Pure: the hashtag line, the same tags voscript.js gives a single-show video. */
function tagsOf(ny, london) {
  return [isBroadwayCategory(ny) ? '#Broadway' : '#OffBroadway', london.category === 'off-west-end' ? '#OffWestEnd' : '#WestEnd', tagFor(ny.title), '#Theater', '#London', '#NYC'].join(' ');
}
function planFor(ny, london, key) { return buildPlan({ key, shows: sidesOf(ny, london), tags: tagsOf(ny, london) }); }

module.exports = { sidesOf, tagsOf, planFor };

if (require.main === module) (async () => {
  const [nyId, lonId, outDir, name = 'compare'] = process.argv.slice(2);
  if (!nyId || !lonId || !outDir) throw new Error('usage: node compare-make.js <newYorkId> <londonId> <outDir> [name]');
  if (!(process.env.OPENAI_API_KEY && process.env.GEMINI_API_KEY)) throw new Error('copy review needs OPENAI_API_KEY and GEMINI_API_KEY');
  const ny = meta(nyId), london = meta(lonId);
  if (!ny || !london) throw new Error(`compare-make: ${!ny ? nyId : lonId} is not in shows.json`);
  // the words are fixed, so a review that only objects to style may pass on a second look (the reviewers are not deterministic): up to 3 tries.
  // A review that would reword the template blocks the video, because render.js refuses a compare plan that is not the template's output.
  let P;
  for (let t = 1; t <= 3; t++) {
    P = planFor(ny, london, `${name}-${nyId}`);
    const made = JSON.stringify([P.prompt, P.caption]);
    console.error(`copy review, try ${t}:`);
    P.review = await require('./copyreview.js').review(P, m => console.error(m));
    if (JSON.stringify([P.prompt, P.caption]) !== made) { P.review = { pass: false, issues: ['the review reworded the fixed compare template'] }; continue; }
    if (P.review.pass) break;
  }
  if (P.review.pass) assertTemplate(P);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, name + '.plan.json'), JSON.stringify(P, null, 1));
  console.log(P.prompt);
  if (!P.review.pass) { console.error('BLOCKED by copy review: ' + P.review.issues.join(' | ')); process.exit(1); }
})().catch(e => { console.error(e.message); process.exit(1); });
