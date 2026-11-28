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

const { makeOutletCanonicalizer } = require('./cross-outlet-triage');

/**
 * @param {{outlets: Object<string,{defaultCritic?:string}>, _aliasIndex?: Object<string,string>}} registryDoc
 * @param {Array<{outletId:string, criticName:string}>} reviews
 * @returns {Array<{outletId:string, critic:string, elsewhere:Array<{outletId:string,n:number}>}>}
 */
function findHomelessDefaultCritics(registryDoc, reviews) {
  if (!registryDoc || typeof registryDoc.outlets !== 'object' || !Array.isArray(reviews) || !reviews.length) {
    throw new Error('findHomelessDefaultCritics: registry.outlets and a non-empty reviews array are required (an empty corpus would pass silently)');
  }
  const canon = makeOutletCanonicalizer(registryDoc);
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

/**
 * BRO-7391: the critic -> home-outlets map the cross-outlet audit flags against,
 * built ONLY from defaultCritic rows the critic has actually published under
 * (>=1 review at the alias-canonical home in reviews.json). A homeless default
 * is no evidence of where the critic works, so it must not make every review
 * they write elsewhere a suspect: BRO-7038 (Mark Kennedy at news-tribune, he is
 * AP) and BRO-8038 (Marilyn Stasio at boston-herald, she is Variety: her review
 * syndicated in the Chicago Tribune read as drift) were both this.
 * The live test (default-critic-home.live.test.mjs) still keeps NEW homeless
 * defaults out of the registry; this makes the audit immune to the ones there.
 *
 * @returns {Map<string, string[]>} criticName -> canonical home outletIds
 */
function buildEvidencedDefaultHomes(registryDoc, reviews) {
  if (!registryDoc || typeof registryDoc.outlets !== 'object' || !Array.isArray(reviews) || !reviews.length) {
    throw new Error('buildEvidencedDefaultHomes: registry.outlets and a non-empty reviews array are required (an empty corpus would drop every home)');
  }
  const canon = makeOutletCanonicalizer(registryDoc);
  const seen = new Set();
  for (const r of reviews) {
    if (r && r.criticName) seen.add(`${canon(r.outletId)}||${r.criticName}`);
  }
  const homes = new Map();
  for (const [oid, entry] of Object.entries(registryDoc.outlets)) {
    const critic = entry && entry.defaultCritic;
    if (!critic) continue;
    const home = canon(oid);
    if (!seen.has(`${home}||${critic}`)) continue;
    if (!homes.has(critic)) homes.set(critic, []);
    if (!homes.get(critic).includes(home)) homes.get(critic).push(home);
  }
  return homes;
}

module.exports = { findHomelessDefaultCritics, buildEvidencedDefaultHomes };
