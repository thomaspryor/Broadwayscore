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
  getNonprofitProducerLine,
  getNonprofitTag,
  getRecoupedCellSummary,
  hasCommercialCard,
  getConversionSourceLabel,
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

test('a New York Times ArtsBeat link is the newspaper, not a blog (BRO-5562)', () => {
  for (const nyt of [
    'The New York Times (Dec 15, 2014): "The show\'s weekly running costs are about $625,000." https://archive.nytimes.com/artsbeat.blogs.nytimes.com/2014/12/15/the-last-ship-rises-with-sting-in-the-cast/',
    'NYT ArtsBeat reported the closing. http://artsbeat.blogs.nytimes.com/2014/05/01/x/',
  ]) {
    assert.equal(publicSourceText(nyt), nyt, `should keep: ${nyt}`);
  }
  for (const blog of [
    'Financing Broadway blog listing capitalization at $14 million',
    'Estimate from a blog post https://example.blogspot.com/x',
    'Broadway & Me blog https://broadwayandme.blogspot.com/2010/12/x.html',
  ]) {
    assert.equal(publicSourceText(blog), null, `should drop: ${blog}`);
  }
});

test('publicSourceText drops hand-edit process notes and field names written as code (BRO-4669)', () => {
  // The live wording these records carried before the BRO-4669 plan.
  const internal = [
    'No producer announcement; Broadway Journal (Aug 25 2023) projected recoupment. Kept recouped:true per owner review 2026-07-13.',
    'Closed 2023-11-19 after limited run. recouped:null because no public outcome citation either way.',
    'Total gross ~$15.2M. Per policy applied 2026-05-24: recouped:null because no explicit citation.',
    '548 performances. Per policy applied 2026-05-24: designation=Nonprofit because no hard recoupment citation.',
    'humanReviewedDesignation: true',
    'Owner decision on 2026-07-13',
  ];
  for (const text of internal) {
    assert.equal(publicSourceText(text), null, `should drop: ${text}`);
  }
  // Citations and prose with colons, capitalized words and URL query strings stay.
  const clean = [
    'Based on a True story: Variety (Mar 2016)',
    'Recouped: Deadline (Aug 2023)',
    'SEC Form D: https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&type=D&dateb=',
    'Broadway Journal (Aug 25, 2023): the month of recoupment was not reported.',
    'No recoupment outcome has been announced. The run was extended twice.',
  ];
  for (const text of clean) {
    assert.equal(publicSourceText(text), text, `should keep: ${text}`);
  }
});

test('publicSourceText drops the placeholder note the stub enroller writes', () => {
  // Imports the real enroller so a reworded placeholder cannot slip past the guard.
  const { makeStub } = createRequire(import.meta.url)('../../scripts/initialize-commercial-stub.js');
  // The enroller writes no note (null); a placeholder that comes back must still be dropped.
  const stubNotes = makeStub().notes;
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
  // cleanup-commercial-data.js now writes a plain public note, so the research
  // scripts' plausibility flag is the one bracketed annotation left to find.
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
  const cited = { costMethodology: 'trade-reported', weeklyRunningCostSource: 'Deadline (Mar 2024)' };
  assert.equal(isEstimatedRunningCost(cited), false);
  assert.equal(getWeeklyCostSourceLabel(cited), 'Deadline (Mar 2024)');
  // ...but still never print internal text: with nothing publishable left it reads as an estimate.
  const internalOnly = { costMethodology: 'sec-filing', weeklyRunningCostSource: 'SEC filings (GPT Deep Research)' };
  assert.equal(getWeeklyCostSourceLabel(internalOnly), 'Estimate');
  assert.equal(isEstimatedRunningCost(internalOnly), true);
  // The explicit isEstimate flag still wins.
  assert.equal(isEstimatedRunningCost({ ...cited, isEstimate: { weeklyRunningCost: true } }), true);
});

test('a weekly cost labeled reported that cites no source reads as an estimate (BRO-4666)', () => {
  for (const costMethodology of ['trade-reported', 'sec-filing', 'producer-confirmed', undefined]) {
    for (const weeklyRunningCostSource of [undefined, null, '', '  ']) {
      const rec = { costMethodology, weeklyRunningCostSource };
      assert.equal(isEstimatedRunningCost(rec), true, `${costMethodology} / ${JSON.stringify(weeklyRunningCostSource)}`);
      assert.equal(getWeeklyCostSourceLabel(rec), 'Estimate');
    }
  }
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

test('nonprofit producer line (BRO-4721): names the company, survives toPublicShowCommercial, never prints internal text', () => {
  const base = { capitalization: null, capitalizationSource: null, weeklyRunningCost: null, recouped: null, recoupedDate: null, recoupedWeeks: null };
  const mtc = { ...base, designation: 'Nonprofit', nonprofitOrg: 'Manhattan Theatre Club' };
  assert.equal(getNonprofitProducerLine(mtc), 'A Manhattan Theatre Club production (nonprofit)');
  assert.equal(getNonprofitProducerLine(toPublicShowCommercial(mtc)), 'A Manhattan Theatre Club production (nonprofit)');
  // A commercial outcome on a nonprofit production (an enhancement) names the producer without calling the show nonprofit.
  assert.equal(
    getNonprofitProducerLine({ ...base, designation: 'Easy Winner', nonprofitOrg: 'Lincoln Center Theater' }),
    'Nonprofit producer: Lincoln Center Theater'
  );
  assert.equal(getNonprofitProducerLine({ ...base, designation: 'Windfall' }), null);
  // An enhancement deal says why its card shows a % recouped (BRO-5502), and the type survives the public projection.
  const lct = { ...base, designation: 'Nonprofit', nonprofitOrg: 'Lincoln Center Theater', productionType: 'enhancement' };
  assert.equal(getNonprofitProducerLine(lct), 'A Lincoln Center Theater production (nonprofit, with commercial enhancement investors)');
  assert.equal(getNonprofitProducerLine(toPublicShowCommercial(lct)), 'A Lincoln Center Theater production (nonprofit, with commercial enhancement investors)');
  assert.equal(getNonprofitProducerLine({ ...base, designation: 'Nonprofit', nonprofitOrg: 'Inferred from GPT deep research' }), null);
  assert.equal(toPublicShowCommercial({ ...base, designation: 'Nonprofit', nonprofitOrg: 'GPT DR batch 2' }).nonprofitOrg, undefined);
});

test('a nonprofit run that became a commercial run (BRO-5508): says when, counts as commercial, survives the projections', () => {
  const base = { capitalization: null, capitalizationSource: null, weeklyRunningCost: null, recouped: null, recoupedDate: null, recoupedWeeks: null };
  const ragtime = {
    ...base, designation: 'TBD', nonprofitOrg: 'Lincoln Center Theater', productionType: 'enhancement',
    commercialConversion: { date: '2026-01-05', sourceUrl: 'https://www.reddit.com/r/Broadway/comments/x/' },
  };
  const line = 'Began as a Lincoln Center Theater nonprofit production, then switched to a commercial run in Jan 2026';
  assert.equal(getNonprofitProducerLine(ragtime), line);
  assert.equal(getNonprofitProducerLine(toPublicShowCommercial(ragtime)), line);
  assert.deepEqual(toPublicShowCommercial(ragtime).commercialConversion, ragtime.commercialConversion);
  assert.equal(getNonprofitTag(ragtime), 'Lincoln Center Theater · commercial from Jan 2026');
  // The switch is reported but not its date: say it happened, never invent when.
  const rocky = { ...base, designation: 'TBD', nonprofitOrg: 'Roundabout Theatre Company', commercialConversion: { date: null, sourceUrl: 'https://www.reddit.com/r/Broadway/comments/y/' } };
  assert.equal(getNonprofitProducerLine(rocky), 'Began as a Roundabout Theatre Company nonprofit production, then switched to a commercial run');
  assert.equal(getNonprofitTag(rocky), 'Roundabout Theatre Company · went commercial');
  // A malformed record never reaches the page as a conversion.
  assert.equal(toPublicShowCommercial({ ...base, designation: 'TBD', commercialConversion: 'yes' }).commercialConversion, undefined);
  // Without a switch the tag is the company, as before.
  assert.equal(getNonprofitTag({ nonprofitOrg: 'Manhattan Theatre Club' }), 'Manhattan Theatre Club');
  assert.equal(getNonprofitTag({ nonprofitOrg: null }), null);
  // It has investors: its % recouped cell shows the analyst's figure, never "Not applicable: nonprofit".
  const row = { ...rocky, slug: 'the-rocky-horror-show', status: 'open', analystRecoupPct: [0, 20], analystRecoupAsOf: '2026-10-13', analystRecoupUrl: 'https://www.reddit.com/r/Broadway/comments/z/', modelRecoupmentPct: null };
  assert.equal(getRecoupedCellSummary(row).kind, 'analyst');
  assert.equal(getRecoupedCellSummary({ ...row, designation: 'Nonprofit', commercialConversion: undefined }).kind, 'reason');
  // TBD with no cap and no recoupment still gets a show-page card when there is a switch or an analyst figure to show.
  assert.equal(hasCommercialCard(toPublicShowCommercial(rocky)), true);
  assert.equal(hasCommercialCard({ ...base, designation: 'TBD', analystRecoupPct: [0, 0] }), true);
  assert.equal(hasCommercialCard({ ...base, designation: 'TBD' }), false);
  // The card's link names a Reddit source the way the estimates do.
  assert.equal(getConversionSourceLabel(ragtime.commercialConversion.sourceUrl), 'r/Broadway analyst');
  assert.equal(getConversionSourceLabel('https://playbill.com/article/broadways-appropriate-extension-begins-march-25'), 'source');
  assert.equal(getConversionSourceLabel('https://notreddit.com.example/x'), 'source');
  assert.equal(getConversionSourceLabel(null), 'source');
});
