'use strict';

// Announced recoupers our model reads under 100% (model false negatives),
// each with the diagnosis of why (BRO-6140, from BRO-6137 item 4). The
// announcement wins on the page (owner 2026-07-13, task #140); this list
// keeps the audit's HIGH flag for false negatives nobody has looked at yet.
// Diagnosed 2026-11-05 with impliedRecoupNut (lib/implied-recoup-cost.js) and
// each record's modelInputBasis. When an input below gets a sourced figure,
// re-run the model; once the show leaves the false-negative set its entry is
// reported stale and should be deleted.

const MODEL_FALSE_NEGATIVE_EXPLANATIONS = Object.freeze({
  'kimberly-akimbo-2022': 'Recoupment announced Apr 2026, two years after the Broadway close, and counts the national tour; the model sees only Broadway weeks (weekly cost is an industry estimate).',
  gutenberg: 'Borderline: central 94.5%, range 67-120% straddles 100. Recouped the week it closed on a reported $638K all-in breakeven; a musical, so the implied-cost fit does not apply.',
  'the-lehman-trilogy-2021': 'Recoupment rests on a low-confidence forum report (owner kept it, BRO-6446-b); weekly cost is a type default and capitalization is the SEC ceiling, so the implied-cost fit skips it as an inference.',
  'the-piano-lesson-2022': 'Borderline: central 95.2%, range 71-118%. Recoupment announced Mar 2024, over a year after the Jan 2023 close (tax credit or later income), so the implied-cost fit skips it; weekly cost is a type default.',
  'sea-wall-a-life-2019': 'Type-default weekly cost is far too high for a two-actor play at the Hudson; the implied-cost fit finds no cost within 0.4x-2.5x of it that reaches 100% by the Sep 2019 announcement. Needs a sourced running cost.',
  'the-ferryman-2018': 'Borderline: central 97.7% even with the cost implied by the reported recoupment on closing day (the live run keeps a reserve the fit leaves out).',
  'sunday-in-the-park-with-george-2017': 'No capitalization on record: the model runs on an $8.25M comparables estimate, too high for a 10-week concert-scale revival, with a type-default weekly cost. Needs a sourced capitalization.',
  'next-to-normal-2009': 'Musical with a type-default weekly cost (no reported cost anchor); range 4-154% straddles 100. Needs a sourced running cost.',
  'memphis-2009': 'Musical with a type-default weekly cost (no reported cost anchor) over a 148-week run; range -64-127% straddles 100. Needs a sourced running cost.',
});

/**
 * Split model false negatives (recouped:true, modelRecouped:false) into
 * diagnosed and undiagnosed, and list diagnoses whose show is no longer one.
 * @param {Array<[string, object]>} entries [key, commercial record] pairs
 * @param {Record<string, string>} [explanations]
 * @returns {{ explained: Array<{key: string, why: string}>, unexplained: string[], staleExplanations: string[] }}
 */
function splitModelFalseNegatives(entries, explanations = MODEL_FALSE_NEGATIVE_EXPLANATIONS) {
  const explained = [];
  const unexplained = [];
  const seen = new Set();
  for (const [key, d] of entries) {
    if (!(d && d.recouped === true && d.modelRecouped === false)) continue;
    seen.add(key);
    if (Object.prototype.hasOwnProperty.call(explanations, key)) explained.push({ key, why: explanations[key] });
    else unexplained.push(key);
  }
  const staleExplanations = Object.keys(explanations).filter((k) => !seen.has(k));
  return { explained, unexplained, staleExplanations };
}

module.exports = { MODEL_FALSE_NEGATIVE_EXPLANATIONS, splitModelFalseNegatives };
