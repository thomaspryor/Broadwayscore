#!/usr/bin/env node
// Read-only backfill report. Live corrections use approved compare-and-set plans.
const fs = require('fs');
const path = require('path');
const { createSourceVerifier } = require('./lib/commercial-source-verify');
const { buildShowKeyIndex, resolveCommercialSlug } = require('./lib/commercial-slug-key');

async function main() {
  const flags = Object.fromEntries(process.argv.slice(2).map(arg => {
    const index = arg.indexOf('=');
    return [arg.slice(2, index < 0 ? undefined : index), index < 0 ? true : arg.slice(index + 1)];
  }));
  const maxFetches = Number(flags['max-fetches'] ?? 20);
  if (!Number.isInteger(maxFetches) || maxFetches < 0) throw Error('max-fetches must be a nonnegative integer');
  const commercial = JSON.parse(fs.readFileSync(flags['commercial-file'] || path.join(__dirname, '../data/commercial.json'), 'utf8'));
  const shows = JSON.parse(fs.readFileSync(flags['shows-file'] || path.join(__dirname, '../data/shows.json'), 'utf8')).shows;
  const index = buildShowKeyIndex(shows);
  const verify = createSourceVerifier({ maxFetches });
  for (const [slug, entry] of Object.entries(commercial.shows || {})) {
    const fields = ['capitalization', 'weeklyRunningCost'].filter(field => entry[field] != null && entry.isEstimate?.[field] !== true && /GPT|Gemini|Deep Research/i.test(entry[field === 'capitalization' ? 'capitalizationSource' : 'weeklyRunningCostSource'] || ''));
    if (!fields.length) continue;
    const { show } = resolveCommercialSlug(slug, entry, index);
    const evidence = await verify(entry, show);
    console.log(JSON.stringify({ slug, fields: Object.fromEntries(fields.map(field => [field, {
      figure: entry[field], found: evidence[field]?.found === true,
      quote: evidence[field]?.quote || null, url: evidence[field]?.source.url || null,
      proposedIsEstimate: evidence[field]?.found !== true,
    }])) }));
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
