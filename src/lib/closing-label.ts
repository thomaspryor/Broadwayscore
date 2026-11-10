/**
 * Closing-date wording for running shows (BRO-7252, owner decision 2026-11-09).
 *
 * A run that keeps extending (Operation Mincemeat ~12 times, Rocky Horror,
 * Schmigadoon) has no real announced final performance: its closingDate is
 * only the latest extension. Those shows read "Extended through <date> (Nth
 * extension)", never "Closes <date>". A run with no recorded extension keeps
 * "Closes <date>" (Buena Vista Social Club, Two Strangers).
 *
 * Extension history lives on the show as `closingExtensions`, appended by the
 * closing-date writers (scripts/lib/closing-date-guard.js):
 *   { announcedAt, from, to, source }
 *
 * Every surface that renders a closing label goes through formatClosingLabel
 * so one rule covers hero, cards, homepage and guides. The class guard is
 * tests/unit/closing-label.test.mjs, which also fails if a component renders
 * a raw "Closes ..." string again.
 */

export interface ClosingExtension {
  /** Date the extension was announced or first detected (YYYY-MM-DD), null when unknown. */
  announcedAt: string | null;
  /** Previous closing date, null when unknown. */
  from: string | null;
  /** New closing date (YYYY-MM-DD). */
  to: string;
  source?: string | null;
}

export interface ClosingLabelInput {
  closingDate?: string | null;
  closingExtensions?: ReadonlyArray<ClosingExtension> | null;
  /** Serialized form for client components that only need the count. */
  closingExtensionCount?: number | null;
}

/** Runs with this many extensions or more are treated as having no announced closing. */
export const REPEATED_EXTENSION_THRESHOLD = 2;

export function getClosingExtensionCount(input: ClosingLabelInput | null | undefined): number {
  if (!input) return 0;
  const fromList = Array.isArray(input.closingExtensions) ? input.closingExtensions.length : 0;
  const fromCount = typeof input.closingExtensionCount === 'number' && input.closingExtensionCount > 0
    ? Math.floor(input.closingExtensionCount)
    : 0;
  return Math.max(fromList, fromCount);
}

/** True once a run has been extended at least REPEATED_EXTENSION_THRESHOLD times. */
export function isRepeatedlyExtended(input: ClosingLabelInput | null | undefined): boolean {
  return getClosingExtensionCount(input) >= REPEATED_EXTENSION_THRESHOLD;
}

export function ordinal(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1: return `${n}st`;
    case 2: return `${n}nd`;
    case 3: return `${n}rd`;
    default: return `${n}th`;
  }
}

export type ClosingLabelKind = 'closes' | 'extended';

export interface ClosingLabel {
  kind: ClosingLabelKind;
  /** Full text, e.g. "Closes Jan 17, 2027" or "Extended through Jul 4, 2027 (12th extension)". */
  text: string;
  /** Leading word(s) only, for UIs that style the label separately from the date. */
  prefix: string;
  extensionCount: number;
}

/**
 * Label for a running show's closing date. `formattedDate` is the caller's
 * already-formatted date (each surface has its own short/long format).
 */
export function getClosingLabel(input: ClosingLabelInput, formattedDate: string): ClosingLabel {
  const count = getClosingExtensionCount(input);
  if (count >= 1) {
    return {
      kind: 'extended',
      prefix: 'Extended through',
      text: `Extended through ${formattedDate} (${ordinal(count)} extension)`,
      extensionCount: count,
    };
  }
  return { kind: 'closes', prefix: 'Closes', text: `Closes ${formattedDate}`, extensionCount: 0 };
}

export function formatClosingLabel(input: ClosingLabelInput, formattedDate: string): string {
  return getClosingLabel(input, formattedDate).text;
}

/** Compact form for tight cards and subtitles: "Extended through Jul 4 (12th ext.)". */
export function formatClosingLabelCompact(input: ClosingLabelInput, formattedDate: string): string {
  const count = getClosingExtensionCount(input);
  return count >= 1 ? `Extended through ${formattedDate} (${ordinal(count)} ext.)` : `Closes ${formattedDate}`;
}
