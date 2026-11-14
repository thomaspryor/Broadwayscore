#!/usr/bin/env node
/**
 * Freezes the staged thin-page rollout (BRO-5992) into data/audit/seo-thin-cohort.json.
 * Reads the candidate report (data/audit/seo-thin-candidates.json, run seo-thin-candidates.js first).
 *   cohortSlugs  candidates whose sha256 bucket < 10 (scripts/lib/seo-indexability.js): noindexed.
 *   controlSlugs same-size sample of the other candidates (next-lowest buckets): left indexable.
 * Refuses to run without GSC + PostHog snapshots (fail-open: no data, no cohort) and
 * refuses to overwrite a frozen cohort unless --force.
 */
require('./lib/cli-help').exitOnHelp(module);
const fs = require('fs');
const path = require('path');
const { cohortBucket, inCohortHash, COHORT_PERCENT } = require('./lib/seo-indexability');

const root = path.join(__dirname, '..');
const OUT = path.join(root, 'data', 'audit', 'seo-thin-cohort.json');
const cand = JSON.parse(fs.readFileSync(path.join(root, 'data', 'audit', 'seo-thin-candidates.json'), 'utf8'));

if (!cand.landingsLoaded || !cand.gscLoaded) { console.error('candidate report lacks landings or GSC data; not freezing'); process.exit(1); }
const frozen = fs.existsSync(OUT) && (JSON.parse(fs.readFileSync(OUT, 'utf8')).cohortSlugs || []).length > 0;
if (frozen && !process.argv.includes('--force')) { console.error('cohort already frozen (data/audit/seo-thin-cohort.json); use --force only to restart the experiment'); process.exit(1); }

const slugs = cand.shows.slugs;
const cohortSlugs = slugs.filter(s => inCohortHash(s)).sort();
const rest = slugs.filter(s => !inCohortHash(s))
  .sort((a, b) => cohortBucket(a, 'seo-thin-control-v1') - cohortBucket(b, 'seo-thin-control-v1') || (a < b ? -1 : 1));
const controlSlugs = rest.slice(0, cohortSlugs.length).sort();

const out = {
  frozen: new Date().toISOString().slice(0, 10),
  recheckAfter: new Date(Date.now() + 21 * 86400000).toISOString().slice(0, 10),
  hashRule: `sha256("seo-thin-cohort-v1:"+slug) first 8 hex as uint32 % 100 < ${COHORT_PERCENT}`,
  controlRule: 'same size as cohort; candidates outside it with the lowest sha256("seo-thin-control-v1:"+slug) bucket',
  basedOn: { candidatesGenerated: cand.generated, candidates: slugs.length },
  baseline: 'every cohort and control page had 0 GSC impressions and 0 search landings over the prior 90 days by construction',
  cohortSlugs,
  controlSlugs,
};
fs.writeFileSync(OUT, JSON.stringify(out, null, 1) + '\n');
console.log(`cohort ${cohortSlugs.length} noindexed, control ${controlSlugs.length}, candidates ${slugs.length}`);
