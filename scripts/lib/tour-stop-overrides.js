'use strict';
/**
 * Tour-stop override layer (BRO-7271). fetch-tour-schedules.js rewrites
 * data/tour-schedules.json from Tours To You, so a hand correction there is
 * lost on the next run. Corrections live in data/tour-stop-overrides.json and
 * are re-applied after every fetch:
 *   { overrides: [{ tourId, start, set: { end?, start?, venue?, city? }, reason }] }
 * `start` is the stop's start date as fetched (it also matches the corrected
 * start when `set.start` is used, so re-applying is idempotent).
 */
const SETTABLE = ['city', 'venue', 'start', 'end'];
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Problems with an overrides document; [] when valid. Pure. */
function validateOverrides(doc) {
  const errs = [];
  if (!doc || !Array.isArray(doc.overrides)) return ['overrides must be an array'];
  doc.overrides.forEach((o, i) => {
    const at = `overrides[${i}]`;
    if (!o || !o.tourId) errs.push(`${at}: tourId required`);
    if (!o || !DATE.test(o.start || '')) errs.push(`${at}: start must be YYYY-MM-DD`);
    if (!o || !o.reason) errs.push(`${at}: reason required`);
    const set = (o && o.set) || {};
    const keys = Object.keys(set);
    if (!keys.length) errs.push(`${at}: set is empty`);
    for (const k of keys) {
      if (!SETTABLE.includes(k)) errs.push(`${at}: cannot set ${k}`);
      else if ((k === 'start' || k === 'end') && !DATE.test(set[k])) errs.push(`${at}: ${k} must be YYYY-MM-DD`);
    }
    if (set.start && set.end && set.end < set.start) errs.push(`${at}: end before start`);
  });
  return errs;
}

/** New stops array with this tour's overrides applied. Pure; input untouched. */
function applyStopOverrides(tourId, stops, overrides) {
  const mine = (overrides || []).filter(o => o.tourId === tourId);
  return (stops || []).map(stop => {
    const o = mine.find(x => x.start === stop.start || (x.set && x.set.start === stop.start));
    return o ? { ...stop, ...o.set } : stop;
  });
}

/** Apply to every tour in a `tours` map in place; returns ids whose stops changed. */
function applyAllOverrides(tours, overrides) {
  const changed = [];
  for (const id of Object.keys(tours || {})) {
    const next = applyStopOverrides(id, tours[id].stops, overrides);
    if (JSON.stringify(next) !== JSON.stringify(tours[id].stops)) {
      tours[id].stops = next;
      tours[id].updatedAt = new Date().toISOString();
      changed.push(id);
    }
  }
  return changed;
}

module.exports = { validateOverrides, applyStopOverrides, applyAllOverrides };
