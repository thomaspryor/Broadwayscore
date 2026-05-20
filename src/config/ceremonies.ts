/**
 * Registry of non-Tony award ceremonies shown in the OtherAwardsPanel.
 *
 * Adding a new ceremony (OBIE, Lortel, Critics' Circle, etc.) requires:
 *   1. One entry in OTHER_CEREMONY_CONFIGS below.
 *   2. A corresponding case in nodeFor() in AwardScoreCard.tsx.
 *   3. Extending the OtherAwardKey union type.
 *   4. Adding the ceremony key to ShowAwards in data-types.ts.
 *   5. Extending classifyCategory in scripts/lib/classify-category.js
 *      + src/lib/awards-scoring.ts (and updating the golden fixture).
 */

export type OtherAwardKey = 'dramaDesk' | 'occ' | 'dramaLeague' | 'nydcc' | 'obie' | 'lortel' | 'criticsCircle' | 'eveningStandard';

export interface OtherAwardConfig {
  key: OtherAwardKey;
  short: string;
  display: string;
  ceremonyName: string;
  chip: string;
  text: string;
}

// Per-ceremony color coding (re-introduced per Claude Design 2026-05-17 after
// being briefly neutralized). Colors give each ceremony its own glanceable
// identity in the chip row — important when 4+ chips sit side-by-side.
export const OTHER_CEREMONY_CONFIGS: OtherAwardConfig[] = [
  { key: 'dramaDesk',   short: 'Drama Desk',       display: 'Drama Desk Awards',               ceremonyName: 'Drama Desk',               chip: 'bg-purple-500/10 border-purple-500/20',   text: 'text-purple-300' },
  { key: 'occ',         short: 'Outer Critics',    display: 'Outer Critics Circle',            ceremonyName: 'Outer Critics Circle',     chip: 'bg-cyan-500/10 border-cyan-500/20',       text: 'text-cyan-300' },
  { key: 'dramaLeague', short: 'Drama League',     display: 'Drama League Awards',             ceremonyName: 'Drama League',             chip: 'bg-emerald-500/10 border-emerald-500/20', text: 'text-emerald-300' },
  { key: 'nydcc',       short: 'NY Drama Critics', display: "NY Drama Critics' Circle Awards", ceremonyName: "NY Drama Critics' Circle", chip: 'bg-rose-500/10 border-rose-500/20',       text: 'text-rose-300' },
  { key: 'obie',        short: 'Obie Award',       display: 'Obie Awards',                    ceremonyName: 'Obie Awards',              chip: 'bg-orange-500/10 border-orange-500/20',   text: 'text-orange-300' },
  { key: 'lortel',      short: 'Lortel Award',     display: 'Lucille Lortel Awards',          ceremonyName: 'Lortel Awards',            chip: 'bg-violet-500/10 border-violet-500/20',   text: 'text-violet-300' },
  { key: 'criticsCircle', short: 'Critics Circle', display: "Critics' Circle Theatre Awards", ceremonyName: "Critics' Circle",          chip: 'bg-yellow-500/10 border-yellow-500/20',   text: 'text-yellow-300' },
  { key: 'eveningStandard', short: 'Evening Standard', display: 'Evening Standard Theatre Awards', ceremonyName: 'Evening Standard',     chip: 'bg-sky-500/10 border-sky-500/20',         text: 'text-sky-300' },
];
