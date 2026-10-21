const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "2026-10-21" -> "Oct 21, 2026" without timezone drift. */
export function formatDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  return `${MONTHS[m - 1]} ${d}, ${y}`;
}

export function formatMonth(iso: string): string {
  const [y, m] = iso.split('-').map(Number);
  return `${MONTHS[m - 1]} ${y}`;
}

export function formatPrice(usd: number | null): string | null {
  return usd == null ? null : `$${usd.toLocaleString('en-US')}`;
}

export const CATEGORY_LABEL = { foldable: 'Foldable', phone: 'Phone' } as const;

/** "Released Oct 23, 2026", or "Ships Oct 23, 2026" before the date (static export: build date). */
export function releaseLabel(iso: string): string {
  const today = new Date().toISOString().slice(0, 10);
  return `${iso > today ? 'Ships' : 'Released'} ${formatDate(iso)}`;
}
