/**
 * default-critic-home.js — BRO-7391 (class: cross-outlet attribution drift).
 *
 * audit-cross-outlet-attributions.js flags a review-text file when its criticName
 * equals ANOTHER outlet's registry defaultCritic. That only means "misattributed"
 * if the registry's defaultCritic is really that outlet's critic. BRO-7038 was a
 * registry defaultCritic that was wrong (Mark Kennedy at news-tribune, he is AP):
 * every syndicated copy read as drift. Each daily card then cleared single rows
 * while the cause (a defaultCritic the outlet has never published under) stayed.
 *
 * A "homeless" default is a defaultCritic with ZERO reviews at its own outlet
 * (alias-canonicalised) in reviews.json while the same critic HAS reviews at other
 * outlets. Those are the registry rows that can mint false suspects.
 *
 * PURE: takes parsed JSON, no I/O.
 */
'use strict';

/**
 * @param {{outlets: Object<string,{defaultCritic?:string}>, _aliasIndex?: Object<string,string>}} registryDoc
 * @param {Array<{outletId:string, criticName:string}>} reviews
 * @returns {Array<{outletId:string, critic:string, elsewhere:Array<{outletId:string,n:number}>}>}
 */
function findHomelessDefaultCritics(registryDoc, reviews) {
  const idx = (registryDoc && registryDoc._aliasIndex) || {};
  const canon = (id) => {
    const hit = idx[String(id || '').toLowerCase()];
    return typeof hit === 'string' && hit ? hit : id;
  };
  const counts = new Map(); // critic -> Map(outlet -> n)
  for (const r of reviews || []) {
    if (!r || !r.criticName) continue;
    const o = canon(r.outletId);
    if (!counts.has(r.criticName)) counts.set(r.criticName, new Map());
    const m = counts.get(r.criticName);
    m.set(o, (m.get(o) || 0) + 1);
  }
  const out = [];
  for (const [oid, entry] of Object.entries((registryDoc && registryDoc.outlets) || {})) {
    const critic = entry && entry.defaultCritic;
    if (!critic) continue;
    const home = canon(oid);
    const m = counts.get(critic);
    if (m && m.get(home)) continue;
    const elsewhere = m
      ? [...m.entries()].filter(([o]) => o !== home).map(([outletId, n]) => ({ outletId, n })).sort((a, b) => b.n - a.n)
      : [];
    if (elsewhere.length) out.push({ outletId: oid, critic, elsewhere });
  }
  return out.sort((a, b) => a.outletId.localeCompare(b.outletId));
}

module.exports = { findHomelessDefaultCritics };
