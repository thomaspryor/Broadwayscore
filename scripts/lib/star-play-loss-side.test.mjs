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
// BRO-6355: sourced non-recoupment bounds the model at <100%, without
// inferring how large the loss was. The 90% default-cost calibration guard
// still applies to records without that outside outcome constraint.
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
const { hasSourcedNonRecoupment } = require('./recoupment-model');

test('loss-labelled star plays respect the sourced loss bound or default-cost calibration', { skip }, () => {
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
    const show = bySlug.get(slug) || bySlug.get(c.slug) || bySlug.get(slug.replace(/-\d{4}$/, ''));
    if (!show) continue;
    const r = liveModelRun(show, c, L, opts).result;
    if (!r || r.error) continue;
    checked++;
    const ceiling = hasSourcedNonRecoupment(c) ? 100 : NEAR_MISS_PCT;
    if (r.recoupmentPctCentral >= ceiling) over.push(`${slug} ${r.recoupmentPctCentral} (limit ${ceiling})`);
  }
  assert.ok(checked >= 20, `only ${checked} loss-labelled star plays modelled`);
  // The repo is public: name shows only in a local run.
  const names = process.env.CI ? `${over.length} rows (run locally for names)` : over.join(', ');
  assert.equal(over.length, 0, `loss-labelled star plays above their bound: ${names}`);
});

test('all sourced non-recoupers stay below 100% in every live-model scenario', { skip }, () => {
  const { liveModelRun } = require('./model-drift');
  const { makeGrossesLookup } = require('./grosses-lookup');
  const { makeCapEstimator } = require('./cap-comparables');
  const load = (f) => JSON.parse(fs.readFileSync(path.join(REPO, 'data', f), 'utf8'));
  const raw = load('shows.json');
  const shows = raw.shows || raw;
  const by = new Map(shows.flatMap((s) => [[s.id, s], [s.slug, s]]));
  const commercial = load('commercial.json').shows;
  const lookup = makeGrossesLookup(load('grosses.json'), load('grosses-history.json'));
  const opts = { capComparables: true, capEstimator: makeCapEstimator(shows, commercial) };
  let checked = 0;
  for (const [key, c] of Object.entries(commercial)) {
    if (!hasSourcedNonRecoupment(c)) continue;
    const show = by.get(key) || by.get(c.slug) || by.get(key.replace(/-\d{4}$/, ''));
    if (!show) continue;
    const r = liveModelRun(show, c, lookup, opts).result;
    if (!r || r.error) continue;
    checked++;
    assert.ok([r.recoupmentPctLow, r.recoupmentPctCentral, r.recoupmentPctHigh].every((p) => p < 100));
    assert.equal(r.modelRecouped, false);
    assert.equal(r.weeksToRecoupEstimate, null);
  }
  assert.ok(checked >= 5, `only ${checked} sourced non-recoupers modelled`);
});
