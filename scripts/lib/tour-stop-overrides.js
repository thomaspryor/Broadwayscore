'use strict';
/**
 * Tour-stop override layer (BRO-7271). fetch-tour-schedules.js rewrites
 * data/tour-schedules.json from Tours To You, so a hand correction there is
 * lost on the next run. Corrections live in data/tour-stop-overrides.json and
 * are re-applied after every fetch:
 *   { overrides: [{ tourId, start, set: { end?, start?, venue?, city? }, reason }] }
 * `start` is the stop's start date as fetched (it also matches the corrected
 * start when `set.start` is used, so re-applying is idempotent).
 * `was` (required) holds the fetched value of each field in `set`. If upstream
 * now shows something else (it fixed the date itself, or the stop moved) the
 * override is DRIFTED: skipped, and reported so it can be deleted or updated.
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
    const was = (o && o.was) || {};
    for (const k of keys) if (typeof was[k] !== 'string') errs.push(`${at}: was.${k} required`);
    if (set.start && set.end && set.end < set.start) errs.push(`${at}: end before start`);
  });
  // No two overrides may target the same stop or chain (one's result = another's selector).
  const seen = new Map();
  doc.overrides.forEach((o, i) => {
    if (!o) return;
    for (const key of [o.start, o.set && o.set.start].filter(Boolean)) {
      const id = `${o.tourId}|${key}`;
      if (seen.has(id) && seen.get(id) !== i) errs.push(`overrides[${i}]: selector collides with overrides[${seen.get(id)}]`);
      seen.set(id, i);
    }
  });
  return errs;
}

/**
 * New stops array with this tour's overrides applied. Pure; input untouched.
 * `report` (optional) gets { override, status: 'applied'|'drifted'|'unmatched' }.
 */
function applyStopOverrides(tourId, stops, overrides, report) {
  const mine = (overrides || []).filter(o => o.tourId === tourId);
  const used = new Set();
  const out = (stops || []).map(stop => {
    const o = mine.find(x => x.start === stop.start || (x.set && x.set.start === stop.start));
    if (!o) return stop;
    used.add(o);
    const already = Object.keys(o.set).every(k => stop[k] === o.set[k]);
    const asFetched = Object.keys(o.set).every(k => stop[k] === (o.was || {})[k]);
    if (!already && !asFetched) { if (report) report({ override: o, status: 'drifted' }); return stop; }
    if (report) report({ override: o, status: 'applied' });
    return { ...stop, ...o.set };
  });
  if (report) for (const o of mine) if (!used.has(o)) report({ override: o, status: 'unmatched' });
  return out;
}

/** Apply to every tour in a `tours` map in place; returns ids whose stops changed. */
function applyAllOverrides(tours, overrides, report) {
  const changed = [];
  for (const id of Object.keys(tours || {})) {
    const next = applyStopOverrides(id, tours[id].stops, overrides, report);
    if (JSON.stringify(next) !== JSON.stringify(tours[id].stops)) {
      tours[id].stops = next;
      tours[id].updatedAt = new Date().toISOString();
      changed.push(id);
    }
  }
  return changed;
}

module.exports = { validateOverrides, applyStopOverrides, applyAllOverrides };
