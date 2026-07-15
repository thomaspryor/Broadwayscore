export type SortDirection = 'asc' | 'desc';

/**
 * Strip inline markdown that leaks from LLM/press-copy sources (synopses,
 * critic consensus) into plain-text UI, meta descriptions, and JSON-LD:
 * **bold**, *italic*, [text](url), `code`. Not a markdown parser — these
 * fields are single-paragraph prose that should render as plain text.
 */
export function stripInlineMarkdown<T extends string | null | undefined>(text: T): T {
  if (!text) return text;
  return text
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*\n]+)\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1') as T;
}

export function formatCurrency(amount: number | null | undefined): string {
  if (amount === null || amount === undefined) return '\u2014';
  if (amount >= 1_000_000_000) return `$${(amount / 1_000_000_000).toFixed(1)}B`;
  if (amount >= 1_000_000) return `$${(amount / 1_000_000).toFixed(1)}M`;
  if (amount >= 1_000) return `$${(amount / 1_000).toFixed(0)}K`;
  return `$${amount.toLocaleString()}`;
}

export function formatNumber(num: number | null | undefined): string {
  if (num === null || num === undefined) return '\u2014';
  return num.toLocaleString();
}

export function formatPercent(pct: number | null | undefined): string {
  if (pct === null || pct === undefined) return '\u2014';
  return `${pct.toFixed(1)}%`;
}

/**
 * Market used when rendering a ticket price. Broadway / Off-Broadway use USD ($);
 * West End / Off-West End use GBP (£). The data/lottery-rush.json file stores raw
 * numbers (e.g. 29.5 for £29.50) — this helper is the single place that knows
 * how to render them with the right symbol and decimal handling.
 *
 * Keep the API narrow: callers pass the show's `category` or a `MarketKey`-like
 * string; null/undefined is treated as USD (default Broadway) so legacy call
 * sites that don't thread market through stay safe.
 */
export type TicketPriceMarket =
  | 'broadway'
  | 'off-broadway'
  | 'west-end'
  | 'off-west-end'
  | 'london'
  | undefined
  | null;

export function isLondonTicketMarket(market: TicketPriceMarket): boolean {
  return market === 'west-end' || market === 'off-west-end' || market === 'london';
}

/**
 * Format a ticket price (lottery/rush/SRO/face-value) with the correct currency.
 * London uses £ with 2 decimals when non-integer (£29.50), integer otherwise (£25).
 * US uses $ with no decimals for whole numbers, 2 decimals otherwise ($12.50).
 *
 *   formatTicketPrice(45, 'broadway')         // "$45"
 *   formatTicketPrice(29.5, 'west-end')       // "£29.50"
 *   formatTicketPrice(12, 'off-west-end')     // "£12"
 *   formatTicketPrice(null, 'broadway')       // "—"
 */
export function formatTicketPrice(
  amount: number | null | undefined,
  market: TicketPriceMarket = 'broadway'
): string {
  if (amount === null || amount === undefined || Number.isNaN(amount)) return '\u2014';
  const symbol = isLondonTicketMarket(market) ? '£' : '$';
  const isInteger = Number.isInteger(amount);
  return `${symbol}${isInteger ? amount.toString() : amount.toFixed(2)}`;
}

/**
 * Format a range of ticket prices with the correct currency (e.g. "$10-60" /
 * "£15-45"). Used in FAQ schema and intro copy.
 */
export function formatTicketPriceRange(
  low: number,
  high: number,
  market: TicketPriceMarket = 'broadway'
): string {
  const symbol = isLondonTicketMarket(market) ? '£' : '$';
  return `${symbol}${low}-${high}`;
}
