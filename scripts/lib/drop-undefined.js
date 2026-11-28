'use strict';

/**
 * Drop keys whose value is undefined. Next's RSC serializer writes each one as
 * `"key":"$undefined"` (~25-35 bytes), and a market list page sends ~950 shows
 * with a dozen unset optional fields each. /browse/west-end-shows crossed its
 * 1.8MB HTML budget on that alone (BRO-7486). An absent key and an undefined
 * one read the same on the client, so this is lossless. null is kept.
 */
function dropUndefinedFields(obj) {
  const out = {};
  for (const k of Object.keys(obj)) if (obj[k] !== undefined) out[k] = obj[k];
  return out;
}

module.exports = { dropUndefinedFields };
