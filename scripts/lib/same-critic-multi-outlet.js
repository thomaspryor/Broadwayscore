/**
 * BRO-7238 part 3: (show, critic) keys that hold reviews from 2+ outlets.
 * One critic's single review counted twice is the failure class; a key is
 * "unresolved" when no outlet in it is a known syndication secondary of another.
 * Pure over reviews.json rows so tests can require() the real function.
 */
const { getSyndicationPrimaries, SYNDICATION_PORTAL_OUTLETS } = require('./syndication-pairs');

const NO_BYLINE = /^(unknown|staff|n\/a|none|anonymous|)$/;

/**
 * @param {Array<{showId:string,criticName?:string,outletId:string}>} reviews
 * @returns {{showId:string,critic:string,outlets:string[],covered:string[]}[]}
 *   covered = outlets that are a known secondary of another outlet in the key (the rebuild drops them)
 */
function findSameCriticMultiOutlet(reviews) {
  const by = new Map();
  for (const r of reviews || []) {
    const critic = String(r.criticName || '').toLowerCase().trim();
    if (NO_BYLINE.test(critic) || !r.outletId) continue;
    const k = `${r.showId}|${critic}`;
    if (!by.has(k)) by.set(k, { showId: r.showId, critic, outlets: new Set() });
    by.get(k).outlets.add(r.outletId);
  }
  const out = [];
  for (const g of by.values()) {
    if (g.outlets.size < 2) continue;
    const outlets = [...g.outlets].sort();
    const covered = outlets.filter((o) => getSyndicationPrimaries(g.critic, o, { sameCriticOutlets: outlets })
      .some((p) => g.outlets.has(p)));
    out.push({ showId: g.showId, critic: g.critic, outlets, covered });
  }
  return out;
}

/** Keys where every outlet is still counted (no known secondary), i.e. the double count is live. */
const unresolved = (keys) => keys.filter((k) => k.covered.length === 0);

module.exports = { findSameCriticMultiOutlet, unresolved, SYNDICATION_PORTAL_OUTLETS };
