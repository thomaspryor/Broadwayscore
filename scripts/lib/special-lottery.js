// Maps the bwayrush scraper's top-level `special` ({name, price}) onto the
// `specialLottery` field that ShowLotteryRush / LotteryRushCard actually read
// (BRO-6862). The program name (MTC $35, HipTix, LincTix) stays in `name`
// because those programs are age-restricted.
'use strict';

/** Mutates and returns the row. An existing specialLottery always wins. */
function mapSpecialToSpecialLottery(row) {
  if (!row || typeof row !== 'object' || !row.special) return row;
  const s = row.special;
  if (!row.specialLottery && s && s.name && typeof s.price === 'number') {
    row.specialLottery = {
      name: s.name,
      platform: s.platform || '',
      url: s.url || '',
      price: s.price,
      instructions: s.instructions || '',
    };
  }
  delete row.special;
  return row;
}

// Named access programs (age/eligibility-restricted, sold by the theatre).
// They are NOT a lottery: the "promote lone specialLottery -> lottery" and
// "dedupe lottery vs specialLottery" cleanups must leave them alone, or the
// next scrape turns "MTC $35" back into an unnamed $35 lottery (BRO-6878 review).
const ACCESS_PROGRAM_NAMES = new Set(['MTC $35', 'HipTix', 'LincTix', 'Ponyboy Seat']);
function isAccessProgram(sl) {
  return !!(sl && typeof sl.name === 'string' && ACCESS_PROGRAM_NAMES.has(sl.name));
}

module.exports = { mapSpecialToSpecialLottery, isAccessProgram, ACCESS_PROGRAM_NAMES };
