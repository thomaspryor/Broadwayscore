'use strict';
/**
 * critic-edit-plan-checks (BRO-7745): problems with a review-field-edit on
 * criticName that the executor applies cleanly but that leave the site wrong.
 *
 * Both hit the bro-7745-cousins plan (2026-11-18, 16/16 "ok"):
 *   1. Twin: re-crediting a TheaterMania "David Gordon" file to Zachary Stewart
 *      when the show already had theatermania--zachary-stewart.json for the same
 *      article (clydes-2021, jitney-2017). Two files, one critic, one outlet.
 *   2. Undone by the rebuild: the Rent Theatre and Tonic row was set to "Roby"
 *      (the live page's credit), but the stored text still printed "Written by
 *      Penny for Theatre and Tonic", and rebuild-all-reviews.js re-applies
 *      printedBylineOverride() to the stored text, so the site showed "Penny".
 */
const path = require('path');
const { printedBylineOverride } = require('./byline-from-text');
const { normalizeOutlet, normalizeCritic } = require('./review-normalization');

const norm = (p) => path.posix.normalize(String(p || '')).replace(/^\.\//, '');
const criticKey = (name) => {
  const k = normalizeCritic(String(name || ''));
  return k && k !== 'unknown' ? k : null;
};

/**
 * Problems for one criticName edit. `readJson(rel)` returns a parsed review
 * file or null; `listFolder(folder)` its file names. `actions` is the whole
 * plan: deletes and other criticName edits in it count.
 */
function criticEditPlanProblems(a, actions, { readJson, listFolder }) {
  if (!a || a.type !== 'review-field-edit' || a.field !== 'criticName' || !a.file || !a.newValue) return [];
  const file = norm(a.file);
  const data = readJson(file);
  if (!data) return [];
  const out = [];
  const outlet = normalizeOutlet(data.outletId || data.outlet || '');

  const printed = printedBylineOverride(outlet, data.fullText, data.url, a.newValue);
  if (printed) {
    out.push(`${file}: criticName "${a.newValue}" will be undone by the rebuild, which re-reads the stored text's printed credit "${printed}"; refresh the stored text first or keep the name the text prints`);
  }

  const want = criticKey(a.newValue);
  if (want) {
    const deleted = new Set(actions.filter((x) => x && x.type === 'review-file-op' && x.operation === 'delete' && x.sourcePath).map((x) => norm(x.sourcePath)));
    const edits = new Map(actions.filter((x) => x && x.type === 'review-field-edit' && x.field === 'criticName' && x.file).map((x) => [norm(x.file), x.newValue]));
    const folder = file.split('/')[0];
    for (const f of listFolder(folder)) {
      const rel = `${folder}/${f}`;
      if (rel === file || deleted.has(rel) || path.extname(f) !== '.json') continue;
      const other = readJson(rel);
      if (!other || normalizeOutlet(other.outletId || other.outlet || '') !== outlet) continue;
      if (other.duplicateOf || other.wrongProduction === true || other.wrongShow === true) continue;
      const name = edits.has(rel) ? edits.get(rel) : other.criticName;
      if (criticKey(name) === want) out.push(`${file}: criticName "${a.newValue}" makes it a twin of ${rel} (same outlet, same critic); delete one of them in this plan`);
    }
  }
  return out;
}

module.exports = { criticEditPlanProblems };
