/**
 * Display helpers for national-tour pages (category 'tour', BRO-4211).
 *
 * A tour entry has no single venue ("North American Tour") and usually no
 * openingDate, so the show page's usual date line is empty. The span of its
 * reviews' publish years is the honest stand-in: "reviewed 2022–2025".
 */

/** "2022–2025", "2024", or null when no review carries a readable year. */
export function getTourReviewYears(reviews: ReadonlyArray<{ publishDate?: string | null }> | undefined): string | null {
  const years: number[] = [];
  for (const r of reviews || []) {
    const m = String(r.publishDate || '').match(/\b(19|20)\d{2}\b/);
    if (m) years.push(Number(m[0]));
  }
  if (years.length === 0) return null;
  const lo = Math.min(...years);
  const hi = Math.max(...years);
  return lo === hi ? String(lo) : `${lo}–${hi}`;
}
