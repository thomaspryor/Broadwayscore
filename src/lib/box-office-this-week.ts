/**
 * Rows of the /box-office "This week" table. The public table lists open and
 * closed shows only; the Box Office v3 page (BRO-5007, unreleased) passes the
 * slugs that reported in the market week so shows still in previews (or not
 * yet marked open) appear too, and the table matches the week's show count.
 */
interface RowShow { slug: string; status: string }
interface RowGrosses { thisWeek?: { gross?: number | null } | null }

export function thisWeekRows<S extends RowShow, G extends RowGrosses>(
  shows: S[],
  grossesFor: (slug: string) => G | null | undefined,
  weekSlugs: ReadonlySet<string> | null = null,
): Array<{ show: S; grosses: G | null | undefined }> {
  return shows
    .filter((show) => (weekSlugs ? weekSlugs.has(show.slug) : show.status === 'open' || show.status === 'closed'))
    .map((show) => ({ show, grosses: grossesFor(show.slug) }))
    .filter((item) => item.grosses?.thisWeek?.gross)
    .sort((a, b) => (b.grosses?.thisWeek?.gross || 0) - (a.grosses?.thisWeek?.gross || 0));
}
