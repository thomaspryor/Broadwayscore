// Maps the bwayrush scraper's top-level `special` ({name, price}) onto the
// `specialLottery` field that ShowLotteryRush / LotteryRushCard actually read
// (BRO-6862). The program name (MTC $35, HipTix, LincTix) stays in `name`
// because those programs are age-restricted.
'use strict';

// A specialLottery this mapper wrote has only name + price; every other field is empty.
// Anything richer (url, platform, instructions) came from a fuller source and is left alone.
const isDerived = (sl) => !!sl && !sl.platform && !sl.url && !sl.instructions;

/**
 * Mutates and returns the row.
 * - No specialLottery yet: build it from `special`.
 * - A derived specialLottery (ours): refresh name and price, so a later scrape that changes the
 *   price (HipTix 30 -> 35) is not frozen at the first value.
 * - A richer specialLottery: it wins.
 * `special` is removed only once it is accounted for; an unusable one (no name or no numeric price)
 * is left in place so the loader fallback and the data test can see it instead of it vanishing.
 */
function mapSpecialToSpecialLottery(row) {
  if (!row || typeof row !== 'object' || !row.special) return row;
  const s = row.special;
  const usable = !!(s && s.name && typeof s.price === 'number');
  if (!usable) return row;
  if (!row.specialLottery) {
    row.specialLottery = { name: s.name, platform: s.platform || '', url: s.url || '', price: s.price, instructions: s.instructions || '' };
  } else if (isDerived(row.specialLottery)) {
    row.specialLottery.name = s.name;
    row.specialLottery.price = s.price;
  }
  delete row.special;
  return row;
}

// Named discount programs (age or membership restricted, or a distinct premium seat). The scraper's
// "promote lone specialLottery -> lottery" and "dedupe against lottery" passes must leave them alone:
// promoting drops the name (an MTC $35 seat is for under-35s, not a plain $35 lottery), and the dedupe
// would delete a real general lottery as "same as HipTix".
const NAMED_PROGRAM_RE = /\b(mtc|hiptix|linctix|ponyboy)\b/i;
const isNamedSpecialProgram = (sl) => !!(sl && NAMED_PROGRAM_RE.test(String(sl.name || '')));

module.exports = { mapSpecialToSpecialLottery, isNamedSpecialProgram };
