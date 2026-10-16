/**
 * Credit line for an estimate published by u/Boring_Waltz_9545 (BRO-5502):
 * names the source and links the post it came from. compact: the /biz table
 * cell ("r/Broadway analyst · Oct 2026"); full: the show-page card.
 */
import { ANALYST_FULL_LABEL, ANALYST_SHORT_LABEL, formatEstimateDate } from '@/lib/commercial-display';

interface AnalystEstimateCreditProps {
  asOf: string | null | undefined;
  url: string | null | undefined;
  compact?: boolean;
}

export default function AnalystEstimateCredit({ asOf, url, compact = false }: AnalystEstimateCreditProps) {
  const when = formatEstimateDate(asOf, compact ? 'short' : 'long');
  const text = compact
    ? `${ANALYST_SHORT_LABEL}${when ? ` · ${when}` : ''}`
    : `Estimate by ${ANALYST_FULL_LABEL}${when ? `, ${when}` : ''}`;
  const className = compact ? 'text-[10px] text-gray-500 whitespace-nowrap mt-1' : 'text-[11px] text-gray-500';
  if (!url) return <p className={className} data-testid="analyst-credit">{text}</p>;
  return (
    <p className={className} data-testid="analyst-credit">
      <a href={url} target="_blank" rel="noopener noreferrer" className="underline decoration-white/20 hover:text-gray-300">
        {text}
        <span className="sr-only"> (opens in a new tab)</span>
      </a>
    </p>
  );
}
