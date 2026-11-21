import type { ShowCommercial } from '@/lib/data-types';
import { formatReturnRange } from '@/lib/commercial-display';

/** Our modeled investor return under a win: always labelled as an estimate. */
export default function EstimatedReturnLine({ range, modelDataQuality }: {
  range: [number, number] | null | undefined;
  modelDataQuality?: ShowCommercial['modelDataQuality'];
}) {
  if (!range) return null;
  const assumed = modelDataQuality === 'low';
  return (
    <div
      className="mt-0.5"
      data-testid="estimated-return"
      title={`Our model's estimate of what investors got back, as a multiple of their money, after the producers' share and counting the NY tax credit. Shown as a range because running costs are rarely reported${assumed ? '; this show\'s running cost is assumed from similar shows' : ''}. See methodology.`}
    >
      <div className="text-xs text-gray-300 whitespace-nowrap">Est. {formatReturnRange(range)} returned</div>
      <div className="text-[10px] text-fg-muted whitespace-nowrap">Our model{assumed ? ' · running cost assumed' : ''}</div>
    </div>
  );
}
