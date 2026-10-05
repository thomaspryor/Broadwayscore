/**
 * BRO-4623: the show-page Commercial Scorecard printed raw source fields
 * verbatim, and 35+ records carried internal research notes there
 * ("GPT DR Batch 3: ...", "Trade press / deep research synthesis",
 * "SEC filings (GPT Deep Research)"). publicSourceText is the guard that keeps
 * that language off the page even if the data text comes back.
 * Runs in the tsx unit batch (imports src TS directly, like commercial-display.test.mjs).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const {
  publicSourceText,
  isEstimatedRunningCost,
  getWeeklyCostSourceLabel,
  getRecoupmentAttribution,
  toPublicShowCommercial,
} = await import('../../src/lib/commercial-display.ts');

test('publicSourceText drops internal research-tooling language', () => {
  const internal = [
    'GPT DR Batch 3: ~$800-900K weekly running cost (industry consensus)',
    'Trade press / deep research synthesis',
    'SEC filings (GPT Deep Research)',
    'Variety (2025). Previous $20M estimate from Deep Research was too low',
    'Reddit r/Broadway consensus',
    'Inferred from grosses',
    'Industry estimate',
    'industry-estimate based on cast size',
    'ChatGPT summary of trade coverage',
    'DR batch 7',
    'Synthesized from several reports',
    'Auto-enrolled stub; awaiting model + curation.',
    'Awaiting model run',
  ];
  for (const text of internal) {
    assert.equal(publicSourceText(text), null, `should drop: ${text}`);
  }
});

test('publicSourceText drops the placeholder note the stub enroller writes', () => {
  // Imports the real enroller so a reworded placeholder cannot slip past the guard.
  const { makeStub } = createRequire(import.meta.url)('../../scripts/initialize-commercial-stub.js');
  const stubNotes = makeStub().notes;
  assert.equal(typeof stubNotes, 'string');
  assert.equal(publicSourceText(stubNotes), null, `stub notes leaked: ${stubNotes}`);
});

test('publicSourceText cuts bracketed pipeline annotations and keeps the rest of the note', () => {
  assert.equal(
    publicSourceText('Limited run through March 8, 2026. [Auto-designated Fizzle: closed without known recoupment data]'),
    'Limited run through March 8, 2026.'
  );
  assert.equal(
    publicSourceText('[PLAUSIBILITY WARNING: weekly cost above gross] Transferred from the Public Theater.'),
    'Transferred from the Public Theater.'
  );
  assert.equal(publicSourceText('[Auto-designated Fizzle: closed without known recoupment data]'), null);
  // Brackets that are part of a citation stay.
  assert.equal(publicSourceText('Variety [paywalled] (Mar 2016)'), 'Variety [paywalled] (Mar 2016)');
});

test('every bracketed annotation a script appends to commercial notes is cut', () => {
  // Scans the writers rather than mirroring their strings, so a new
  // "[SOMETHING: ...]" prefix appended to notes fails here until it is handled.
  const root = fileURLToPath(new URL('../../scripts/', import.meta.url));
  const files = [
    ...readdirSync(root).filter((f) => f.endsWith('.js')).map((f) => join(root, f)),
    ...readdirSync(join(root, 'lib')).filter((f) => f.endsWith('.js')).map((f) => join(root, 'lib', f)),
  ];
  const prefixes = new Set();
  for (const file of files) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      // A write to a record's notes: `x.notes = ...` or `x.notes + ...`.
      if (!/\.notes\s*(?:\+|=(?!=))/.test(line)) continue;
      for (const m of line.matchAll(/['`]\s*\[([A-Za-z][A-Za-z -]*?)(?::|\])/g)) prefixes.add(m[1].trim());
    }
  }
  assert.ok(prefixes.has('Auto-designated Fizzle'), `scan found: ${[...prefixes].join(', ')}`);
  assert.ok(prefixes.has('PLAUSIBILITY WARNING'), `scan found: ${[...prefixes].join(', ')}`);
  for (const prefix of prefixes) {
    assert.equal(
      publicSourceText(`Transferred from the Public Theater. [${prefix}: detail]`),
      'Transferred from the Public Theater.',
      `annotation "[${prefix}: ...]" would print on the show page`
    );
  }
});

test('publicSourceText passes clean citations through unchanged (trimmed)', () => {
  const clean = [
    'Deadline (Mar 2024) recoupment report: $12M',
    'SEC Form D filing (2023)',
    'Broadway Journal (Aug 25 2023)',
    'Variety (Mar 2016)',
    'The New York Times, June 2024',
  ];
  for (const text of clean) {
    assert.equal(publicSourceText(text), text, `should keep: ${text}`);
  }
  assert.equal(publicSourceText('  Playbill (2025)  '), 'Playbill (2025)');
});

test('publicSourceText: empty and missing values are null', () => {
  assert.equal(publicSourceText(null), null);
  assert.equal(publicSourceText(undefined), null);
  assert.equal(publicSourceText(''), null);
  assert.equal(publicSourceText('   '), null);
});

test('estimated cost methodologies mark the weekly cost as an estimate and label the source "Estimate"', () => {
  for (const costMethodology of ['industry-estimate', 'deep-research', 'reddit-standard']) {
    assert.equal(isEstimatedRunningCost({ costMethodology }), true, costMethodology);
    assert.equal(
      getWeeklyCostSourceLabel({ costMethodology, weeklyRunningCostSource: 'GPT DR Batch 3: ~$800-900K' }),
      'Estimate',
      costMethodology
    );
  }
  // Reported methodologies keep a clean source and no estimate marker...
  assert.equal(isEstimatedRunningCost({ costMethodology: 'trade-reported' }), false);
  assert.equal(
    getWeeklyCostSourceLabel({ costMethodology: 'trade-reported', weeklyRunningCostSource: 'Deadline (Mar 2024)' }),
    'Deadline (Mar 2024)'
  );
  // ...but still never print internal text.
  assert.equal(
    getWeeklyCostSourceLabel({ costMethodology: 'sec-filing', weeklyRunningCostSource: 'SEC filings (GPT Deep Research)' }),
    null
  );
  // The explicit isEstimate flag still wins.
  assert.equal(isEstimatedRunningCost({ costMethodology: 'trade-reported', isEstimate: { weeklyRunningCost: true } }), true);
});

test('recoupment attribution never surfaces internal source text', () => {
  const base = {
    designation: 'Windfall',
    capitalization: 10_000_000,
    capitalizationSource: null,
    weeklyRunningCost: null,
    recouped: true,
    recoupedDate: '2024-03',
    recoupedWeeks: null,
  };
  const internal = getRecoupmentAttribution({ ...base, recoupedSource: 'GPT DR Batch 3: recouped spring 2024' });
  assert.equal(internal.sourceText, null);

  const cited = getRecoupmentAttribution({
    ...base,
    recoupedSource: 'GPT DR Batch 3: recouped spring 2024',
    sources: [{ type: 'trade', url: 'https://deadline.com/2024/03/x', date: '2024-03-10' }],
  });
  assert.equal(cited.sourceText, 'Trade press report');
  assert.equal(cited.sourceUrl, 'https://deadline.com/2024/03/x');

  const clean = getRecoupmentAttribution({ ...base, recoupedSource: 'Deadline (Mar 2024) recoupment report: $12M' });
  assert.equal(clean.sourceText, 'Deadline (Mar 2024) recoupment report: $12M');
});

test('toPublicShowCommercial sends only publishable fields to the browser', () => {
  const raw = {
    designation: 'TBD',
    capitalization: 22_000_000,
    capitalizationSource: 'SEC filings (GPT Deep Research)',
    weeklyRunningCost: 850_000,
    weeklyRunningCostSource: 'GPT DR Batch 3: ~$800-900K (industry consensus)',
    costMethodology: 'deep-research',
    isEstimate: { capitalization: true },
    recouped: false,
    recoupedDate: null,
    recoupedWeeks: null,
    recoupedSource: 'Inferred: closed 30 days ago, no trade-press recoupment found',
    notes: 'Auto-enrolled stub; awaiting model + curation.',
    deepResearch: { verifiedFields: ['capitalization'], verifiedDate: '2026-01-01', notes: 'GPT deep research pass' },
    modelWarnings: ['No NY tax credit (notes say it was not received)'],
    classifiedReason: 'LLM classifier: consensus of reddit threads',
    estimatedRecoupmentSource: 'Deep Research synthesis',
    capitalizationNote: 'inferred from Form D range',
    sources: [{ type: 'trade', url: 'https://deadline.com/2024/03/x', date: '2024-03-10', excerpt: 'copyrighted excerpt text' }],
    modelRecoupmentPct: [10, 20, 30],
    modelBreakeven: 700_000,
    modelDataQuality: 'medium',
    modelMethod: 'weekly-model',
  };
  const pub = toPublicShowCommercial(raw);
  const json = JSON.stringify(pub);
  for (const leak of ['GPT', 'Deep Research', 'deep research', 'Auto-enrolled', 'Inferred', 'consensus', 'reddit', 'excerpt', 'modelWarnings', 'classifiedReason', 'deepResearch', 'capitalizationNote']) {
    assert.ok(!json.includes(leak), `public record leaked "${leak}": ${json}`);
  }
  // Every field the card reads survives.
  assert.equal(pub.capitalization, 22_000_000);
  assert.equal(pub.weeklyRunningCost, 850_000);
  assert.equal(pub.costMethodology, 'deep-research');
  assert.deepEqual(pub.modelRecoupmentPct, [10, 20, 30]);
  assert.equal(pub.modelBreakeven, 700_000);
  assert.deepEqual(pub.sources, [{ type: 'trade', url: 'https://deadline.com/2024/03/x', date: '2024-03-10' }]);
  assert.equal(getWeeklyCostSourceLabel(pub), 'Estimate');
  assert.equal(isEstimatedRunningCost(pub), true);
  // Clean citations pass through untouched.
  const clean = toPublicShowCommercial({ ...raw, capitalizationSource: 'Variety (Mar 2016)', notes: 'Transferred from the Public Theater.' });
  assert.equal(clean.capitalizationSource, 'Variety (Mar 2016)');
  assert.equal(clean.notes, 'Transferred from the Public Theater.');
});

test('toPublicShowCommercial keeps the "not announced" reading of an internal recoupment source', () => {
  const raw = {
    designation: 'Windfall',
    capitalization: 10_000_000,
    capitalizationSource: null,
    weeklyRunningCost: null,
    recouped: true,
    recoupedDate: '2024-03',
    recoupedWeeks: null,
    recoupedSource: 'GPT DR Batch 3: Disney never formally announces recoupment',
    sources: [{ type: 'trade', url: 'https://deadline.com/2024/03/x', date: '2024-03-10' }],
  };
  const fromRaw = getRecoupmentAttribution(raw);
  const fromPublic = getRecoupmentAttribution(toPublicShowCommercial(raw));
  assert.equal(fromPublic.qualifier, 'Not publicly announced');
  assert.equal(fromPublic.qualifier, fromRaw.qualifier);
  assert.deepEqual(fromPublic.confidence, fromRaw.confidence);
  assert.equal(fromPublic.confidence.level, 'medium');
  // The sanitized label is not repeated as a "Source:" line.
  assert.equal(fromPublic.sourceText, 'Trade press report');
  assert.ok(!JSON.stringify(toPublicShowCommercial(raw)).includes('GPT'));
});
