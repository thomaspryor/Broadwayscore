/**
 * Wording for the email list ("opening night emails") and the account nudge.
 *
 * One home for these strings because they drifted apart before: "Subscribed"
 * next to "Sign in" read as "you have an account" (BRO-4893, owner's partner
 * skipped account sign-up because of it), and "no schedule ... just opening
 * night scores" stayed on the site after the Sunday roundup started.
 *
 * Rules: never call list members "subscribed" or "signed up" (account words),
 * and keep the promise honest about the Sunday roundup.
 * The email footers mirror the account line in scripts/lib/email-templates.js.
 */

export type ListMarket = 'broadway' | 'west-end' | 'off-west-end';

// Off-West End shares the West End list (useFormspreeCapture routes it there).
export const marketLabel = (market: ListMarket) =>
  (market === 'west-end' || market === 'off-west-end' ? 'West End' : 'Broadway');

export const EMAIL_LIST_COPY = {
  /** Button that opens the signup form. */
  cta: 'Get opening night emails',
  heading: (market: ListMarket) => `Never Miss a New ${marketLabel(market)} Show`,
  /** What subscribers get. Must mention the Sunday roundup. */
  promise: (market: ListMarket) =>
    `Scores the night each new ${marketLabel(market)} show opens, plus a short Sunday roundup. Unsubscribe anytime.`,
  /** Shown once the browser is on the list. */
  joined: (market: ListMarket) =>
    `You're getting opening night emails for new ${marketLabel(market)} shows.`,
  successTitle: "You're on the list",
} as const;

export const ACCOUNT_NUDGE_COPY = {
  /** Says plainly that the email list is not an account. */
  separate: "Emails aren't an account.",
  pitch: 'Create a free account to save your ratings and build a watchlist.',
  button: 'Create a free account',
} as const;

/**
 * Per-show email updates (ShowFollowBanner). Not "Follow": the account
 * Watchlist is how signed-in people follow a show, and two kinds of "follow"
 * read as the same thing (BRO-4897).
 */
export const SHOW_EMAIL_COPY = {
  prompt: (showTitle: string) => `Get ${showTitle} news by email: opening night score, closing dates, lotteries`,
  button: 'Email me',
  success: (showTitle: string) => `We'll email you about ${showTitle}`,
} as const;

/** Footer box and link that promote the free account (BRO-4946). */
export const ACCOUNT_PROMO_COPY = {
  heading: 'Your theater diary, free',
  pitch: 'Rate the shows you see, keep a watchlist and a diary, on any phone or computer.',
  signedOutButton: 'Create a free account',
  signedInButton: 'Go to My Shows',
  linkSignedOut: 'Create a free account',
  linkSignedIn: 'My Shows',
} as const;
