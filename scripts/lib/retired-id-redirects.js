'use strict';

/**
 * BRO-7210: a show id retired as "duplicate of <kept-id>" must keep resolving to
 * the kept show. Retire reasons say "id kept as alias" but nothing built the alias,
 * so bookmarks / SERP entries for the dropped id 404'd (5 of 12 live cases:
 * motherfucker-off-broadway-2026, matthew-bournes-new-adventures-cinderella-...).
 * Pure: no I/O.
 *
 * @param {Array<{id:string, reason?:string}>} retired entries of data/retired-show-ids.json
 * @param {Array<{id:string, slug:string}>} shows live show rows
 * @param {Set<string>|Object} taken slugs/keys that already resolve or redirect
 * @returns {Object<string,{target:string,permanent:boolean}>}
 */
function deriveRetiredIdRedirects(retired, shows, taken) {
  const has = (k) => (taken instanceof Set ? taken.has(k) : Object.prototype.hasOwnProperty.call(taken || {}, k));
  const byId = new Map((shows || []).map((s) => [s.id, s]));
  const out = {};
  for (const e of Array.isArray(retired) ? retired : []) {
    if (!e || typeof e.id !== 'string' || !e.id) continue;
    const m = /\bduplicate of ([a-z0-9][a-z0-9-]*[a-z0-9])/i.exec(e.reason || '');
    if (!m) continue;
    const target = byId.get(m[1]);
    if (!target || !target.slug || target.id === e.id) continue;
    if (byId.has(e.id) || has(e.id)) continue; // live page or existing redirect wins
    out[e.id] = { target: target.slug, permanent: true };
  }
  return out;
}

module.exports = { deriveRetiredIdRedirects };
