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

  // Plan-level facts: files the plan removes (delete, or move/rename source), and fields it edits.
  const removed = new Set(actions.filter((x) => x && x.type === 'review-file-op' && ['delete', 'move', 'rename'].includes(x.operation) && x.sourcePath).map((x) => norm(x.sourcePath)));
  const fieldEdits = new Map();
  for (const x of actions) {
    if (!x || x.type !== 'review-field-edit' || !x.file || !x.field) continue;
    const k = norm(x.file);
    if (!fieldEdits.has(k)) fieldEdits.set(k, {});
    fieldEdits.get(k)[x.field] = x.newValue;
  }
  // A file as it will be after this plan's field edits.
  const after = (rel, d) => ({ ...d, ...(fieldEdits.get(rel) || {}) });
  const excluded = (d) => Boolean(d.duplicateOf) || d.wrongProduction === true || d.wrongShow === true;
  const self = after(file, data);
  if (excluded(self) || removed.has(file)) return [];

  // The stored text is refetched when the plan changes the url or runs a script; the old text's
  // credit then says nothing about what the rebuild will read.
  const textRefreshed = (fieldEdits.get(file) || {}).url !== undefined || actions.some((x) => x && x.type === 'run-script');
  const printed = textRefreshed ? null : printedBylineOverride(outlet, data.fullText, data.url, a.newValue);
  if (printed) {
    out.push(`${file}: criticName "${a.newValue}" will be undone by the rebuild, which re-reads the stored text's printed credit "${printed}"; refresh the stored text first or keep the name the text prints`);
  }

  const want = criticKey(a.newValue);
  // A no-op edit (same critic as now) creates no new twin; a pre-existing one is not this plan's doing.
  if (want && criticKey(data.criticName) !== want) {
    const folder = file.split('/')[0];
    for (const f of listFolder(folder)) {
      const rel = `${folder}/${f}`;
      if (rel === file || removed.has(rel) || path.extname(f) !== '.json') continue;
      const raw = readJson(rel);
      if (!raw) continue;
      const other = after(rel, raw);
      if (normalizeOutlet(other.outletId || other.outlet || '') !== outlet || excluded(other)) continue;
      if (criticKey(other.criticName) === want) out.push(`${file}: criticName "${a.newValue}" makes it a twin of ${rel} (same outlet, same critic); delete one of them in this plan`);
    }
  }
  return out;
}

module.exports = { criticEditPlanProblems };
