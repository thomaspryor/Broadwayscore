// BRO-7830: limits and labels the critic client components import. Kept apart
// from critic-claim.ts, which imports Node's `crypto`: a client component that
// imports even one constant from there makes webpack ship a browser crypto
// polyfill (~134kB first-load JS, measured on /show/[slug]).
export const BIO_MAX = 300;
export const TITLE_MAX = 100;
export const MAX_LINKS = 6;
export const PICK_MAX = 120;
export const FLAG_NOTE_MAX = 600;

/** What a critic can say is wrong with one of their reviews (BRO-6984). */
export const FLAG_REASONS = {
  wrong_score: 'Wrong score',
  not_mine: 'Not my review',
  wrong_show: 'Wrong show',
  other: 'Something else',
} as const;
export type FlagReason = keyof typeof FLAG_REASONS;
