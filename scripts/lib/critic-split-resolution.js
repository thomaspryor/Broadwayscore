'use strict';

const { criticProfileKey } = require('./url-slug');
const { displayCriticName } = require('./critic-display-name');

/** Return unbaselined pairs that still produce separate critic pages at rebuild. */
function newSplitPairs(pairs, baseline) {
  const resolved = (p) => {
    const keys = new Set();
    // Review counts only suggest a canonical. A verified alias can point the
    // other way, so compare the actual emitted pages on BOTH sides (BRO-7855).
    for (const page of [p.canonical, p.variant]) {
      for (const name of page.spellings || [page.name]) {
        for (const outlet of page.outlets?.length ? page.outlets : [undefined]) {
          const display = displayCriticName(name, outlet);
          const key = display && criticProfileKey(display);
          if (!key) return false;
          keys.add(key);
        }
      }
    }
    return keys.size === 1;
  };
  return pairs.filter(p => !baseline.has(p.key) && !resolved(p));
}

module.exports = { newSplitPairs };
