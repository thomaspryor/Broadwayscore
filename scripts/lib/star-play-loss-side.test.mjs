// BRO-6178: the loss side of the star-play default weekly cost
// (estimateWeeklyNut's playStar figure in recoupment-model.js). The
// ground-truth backtest cannot see it: a show that never recouped scores error
// 0 anywhere below 100%, so a lower default that lifts every losing star play
// still reads "no group worse". At 450K the model put Misery
// (2015, recouped: false) at 97%; at 550K no loss-labelled star play reaches
// 90% (Misery reads 57). This fails if a later cut, or a data change, pushes
// one there.
// Runs the live model on the real records (§15); skips when the private core
// data is absent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const NEEDED = ['shows.json', 'commercial.json', 'grosses.json', 'grosses-history.json'];
const missing = NEEDED.filter((f) => !fs.existsSync(path.join(REPO, 'data', f)));
const skip = missing.length ? `private core data absent: ${missing.join(', ')}` : false;

const LOSS_LABEL = /^(Flop|Fizzle|Did Not Recoup)$/;
const NEAR_MISS_PCT = 90;
// BRO-6350: a two-part National Theatre import has a doubled company and no
// published capitalization, so a comparables estimate (single-play figures)
// understates its cost and reads ~105% against a sourced "did not recoup".
// That is a missing-cost gap on one record, not the star-play default weekly
// cost this guard protects. Add a slug only with that same reason.
const TWO_PART_NO_CAP = new Set(['angels-in-america']);

test(`no loss-labelled star play with a model run reads ${NEAR_MISS_PCT}% or more`, { skip }, () => {
  const { liveModelRun } = require('./model-drift');
  const { makeGrossesLookup } = require('./grosses-lookup');
  const { makeCapEstimator } = require('./cap-comparables');
  const load = (f) => JSON.parse(fs.readFileSync(path.join(REPO, 'data', f), 'utf8'));
  const raw = load('shows.json');
  const shows = Array.isArray(raw) ? raw : raw.shows;
  const bySlug = new Map(shows.map((s) => [s.slug || s.id, s]));
  const L = makeGrossesLookup(load('grosses.json'), load('grosses-history.json'));
  const commercial = load('commercial.json').shows;
  // As merge-model-recoupment.js runs it: a record with no capitalization
  // runs on a comparables estimate (Misery has none).
  const opts = { capComparables: true, capEstimator: makeCapEstimator(shows, commercial) };
  let checked = 0;
  const over = [];
  for (const [slug, c] of Object.entries(commercial)) {
    if (c.modelCategory !== 'playStar' || c.recouped === true) continue;
    // A label the model set itself (designationBasis 'model-estimate') is not
    // evidence against it: count only recouped:false or an outside loss label.
    const outsideLabel = LOSS_LABEL.test(c.designation || '') && c.designationBasis !== 'model-estimate';
    if (!(c.recouped === false || outsideLabel)) continue;
    if (TWO_PART_NO_CAP.has(slug) && c.capitalization == null) continue;
    const show = bySlug.get(slug) || bySlug.get(c.slug) || bySlug.get(slug.replace(/-\d{4}$/, ''));
    if (!show) continue;
    const r = liveModelRun(show, c, L, opts).result;
    if (!r || r.error) continue;
    checked++;
    if (r.recoupmentPctCentral >= NEAR_MISS_PCT) over.push(`${slug} ${Math.round(r.recoupmentPctCentral)}`);
  }
  assert.ok(checked >= 20, `only ${checked} loss-labelled star plays modelled`);
  // The repo is public: name shows only in a local run.
  const names = process.env.CI ? `${over.length} rows (run locally for names)` : over.join(', ');
  assert.equal(over.length, 0, `loss-labelled star plays at >= ${NEAR_MISS_PCT}%: ${names}`);
});
