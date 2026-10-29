/**
 * Credit line for an estimate published by u/Boring_Waltz_9545 (BRO-5502):
 * names the source and links the post it came from. compact: the /biz table
 * cell ("Analyst est. · Oct 2026"); full: the show-page card. withModel: the
 * range also spans our model's figure (getDisplayableEstimateRange), and says so.
 */
import { ANALYST_FULL_LABEL, ANALYST_SHORT_LABEL, formatEstimateDate } from '@/lib/commercial-display';

interface AnalystEstimateCreditProps {
  asOf: string | null | undefined;
  url: string | null | undefined;
  compact?: boolean;
  withModel?: boolean;
  /** Our own range, no analyst figure behind it (ourEstimateRangePct): credited "Our estimate", nothing else. */
  ours?: boolean;
}

export default function AnalystEstimateCredit({ asOf, url, compact = false, withModel = false, ours = false }: AnalystEstimateCreditProps) {
  if (ours) {
    return <p className={compact ? 'text-[10px] text-fg-muted mt-1' : 'text-[11px] text-fg-muted'} data-testid="analyst-credit">Our estimate</p>;
  }
  const when = formatEstimateDate(asOf, compact ? 'short' : 'long');
  // The date never splits; a narrow table cell breaks before it instead of
  // clipping it (a one-line credit overflowed its 144px cell at 360-414px).
  const text = (
    <>
      {compact
        ? `${ANALYST_SHORT_LABEL}${withModel ? ' + our model' : ''}`
        : `${withModel ? 'Our model and an estimate' : 'Estimate'} by ${ANALYST_FULL_LABEL}`}
      {when && <>{compact ? ' · ' : ', '}<span className="whitespace-nowrap">{when}</span></>}
    </>
  );
  const className = compact ? 'text-[10px] text-fg-muted mt-1' : 'text-[11px] text-fg-muted';
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
