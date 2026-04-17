'use client';

import { useState } from 'react';
import type { SeatingSection, SeatingVerdict, SeatingPriceTier } from '@/lib/data-types';

interface SeatingGuidanceProps {
  sections?: SeatingSection[];
  bestSeats?: string;
  compactRationale?: boolean;
}

const VERDICT_ICON: Record<SeatingVerdict, string> = {
  'sweet-spot': '✓',
  solid: '•',
  skip: '−',
};

const VERDICT_CHIP_CLASS: Record<SeatingVerdict, string> = {
  'sweet-spot': 'bg-score-great-bg text-score-great border border-score-great/30',
  solid: 'bg-surface-overlay text-gray-300 border border-white/10',
  skip: 'bg-score-tepid-bg text-score-tepid border border-score-tepid/30',
};

const VERDICT_ORDER: SeatingVerdict[] = ['sweet-spot', 'solid', 'skip'];

const PRICE_TIER_LABEL: Record<SeatingPriceTier, string> = {
  budget: 'Budget',
  mid: 'Mid',
  premium: 'Premium',
  top: 'Top tier',
};

function isValidSection(s: SeatingSection | null | undefined): s is SeatingSection {
  return !!s && typeof s.name === 'string' && !!s.verdict && !!s.verdictLabel;
}

function VerdictChip({ section }: { section: SeatingSection }) {
  const srLabel = `Verdict: ${section.verdictLabel}`;
  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-pill text-[11px] font-semibold uppercase tracking-wide ${VERDICT_CHIP_CLASS[section.verdict]}`}
      aria-label={srLabel}
    >
      <span aria-hidden="true" className="text-xs leading-none">{VERDICT_ICON[section.verdict]}</span>
      <span>{section.verdictLabel}</span>
    </span>
  );
}

function SectionRow({ section, isHero = false, compactRationale = false }: { section: SeatingSection; isHero?: boolean; compactRationale?: boolean }) {
  const priceLabel = section.priceTier ? PRICE_TIER_LABEL[section.priceTier] : null;
  const nameClass = isHero ? 'text-base font-bold text-white' : 'text-sm font-semibold text-gray-100';
  const hazardsWithNotes = (section.hazards ?? []).filter((h) => h.note);
  const hasHazards = (section.hazards?.length ?? 0) > 0;
  const hazardCountLabel = section.hazards?.length === 1 ? '1 hazard' : `${section.hazards?.length ?? 0} hazards`;
  const showRationaleInline = section.rationale && !compactRationale;
  const showRationaleExpand = section.rationale && compactRationale;

  return (
    <div className={isHero ? 'pb-3' : 'py-3 border-t border-white/5'}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap leading-tight">
            <h3 className={nameClass}>{section.name}</h3>
            <VerdictChip section={section} />
            {section.rowRange && (
              <span className="text-gray-500 text-xs font-normal">rows {section.rowRange}</span>
            )}
            {priceLabel && (
              <span className="text-gray-500 text-xs">· {priceLabel}</span>
            )}
          </div>
        </div>
        {typeof section.dataPoints === 'number' && section.dataPoints > 0 && (
          <span className="text-[10px] text-gray-600 whitespace-nowrap flex-shrink-0" title={`${section.dataPoints} audience reports informed this verdict`}>
            {section.dataPoints} reports
          </span>
        )}
      </div>

      {/* Inline rationale (theater variant) */}
      {showRationaleInline && (
        <p className="text-sm text-gray-300 leading-relaxed mt-2">{section.rationale}</p>
      )}

      {/* Inline expander row: "More details ▾" and "⚠ 1 hazard ▾" on same line */}
      {(showRationaleExpand || hasHazards) && (
        <div className="flex items-start gap-x-4 gap-y-1 flex-wrap mt-2 text-[11px] text-gray-400">
          {showRationaleExpand && (
            <details className="group">
              <summary className="cursor-pointer list-none hover:text-gray-200 select-none inline-flex items-center gap-1">
                <span className="underline decoration-dotted underline-offset-2">More details</span>
                <span className="text-gray-600 group-open:hidden">▾</span>
                <span className="text-gray-600 hidden group-open:inline">▴</span>
              </summary>
              <p className="text-sm text-gray-300 leading-relaxed mt-1.5">{section.rationale}</p>
            </details>
          )}
          {hasHazards && (
            <details className="group">
              <summary className="cursor-pointer list-none hover:text-gray-200 select-none inline-flex items-center gap-1">
                <span className="text-score-tepid" aria-hidden="true">⚠</span>
                <span className="underline decoration-dotted underline-offset-2">{hazardCountLabel}</span>
                <span className="text-gray-600 group-open:hidden">▾</span>
                <span className="text-gray-600 hidden group-open:inline">▴</span>
              </summary>
              {hazardsWithNotes.length > 0 ? (
                <ul className="mt-1.5 space-y-1 pl-4 text-[11px] text-gray-400 leading-snug">
                  {hazardsWithNotes.map((h, i) => (
                    <li key={i}>
                      <span className="font-medium text-gray-300">{h.type.replace(/-/g, ' ')}:</span> {h.note}
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {(section.hazards ?? []).map((h, i) => (
                    <span key={i} className="text-[10px] text-gray-500 bg-surface-overlay px-2 py-0.5 rounded-pill">
                      {h.type.replace(/-/g, ' ')}
                    </span>
                  ))}
                </div>
              )}
            </details>
          )}
        </div>
      )}
    </div>
  );
}

export default function SeatingGuidance({ sections, bestSeats, compactRationale = false }: SeatingGuidanceProps) {
  const [expanded, setExpanded] = useState(false);

  const validSections = (sections ?? []).filter(isValidSection);
  if (!validSections.length) return null;

  // Sort: sweet-spot first, then solid, then skip
  const sorted = [...validSections].sort((a, b) => VERDICT_ORDER.indexOf(a.verdict) - VERDICT_ORDER.indexOf(b.verdict));

  const sweetSpots = sorted.filter((s) => s.verdict === 'sweet-spot');
  const solids = sorted.filter((s) => s.verdict === 'solid');
  const skips = sorted.filter((s) => s.verdict === 'skip');

  const hero = sweetSpots[0] ?? sorted[0];
  const remaining = sorted.filter((s) => s !== hero);
  const remainingSweetSpots = remaining.filter((s) => s.verdict === 'sweet-spot');
  const remainingSkips = remaining.filter((s) => s.verdict === 'skip');

  // Collapse "solid" rows by default if there are more than 2
  const shouldCollapseSolids = solids.length > 2;
  const visibleSolids = shouldCollapseSolids && !expanded ? [] : solids;
  const hiddenSolidCount = shouldCollapseSolids && !expanded ? solids.length : 0;

  return (
    <div className="text-left">
      {bestSeats && (
        <div className="mb-4 p-3 rounded-lg border border-brand/30 bg-brand/5">
          <p className="text-sm text-gray-200 leading-relaxed italic">{bestSeats}</p>
        </div>
      )}

      {/* Hero: sweet-spot, given visual weight */}
      <SectionRow section={hero} isHero compactRationale={compactRationale} />

      {/* Additional sweet-spots */}
      {remainingSweetSpots.map((s, i) => (
        <SectionRow key={`ss-${i}`} section={s} compactRationale={compactRationale} />
      ))}

      {/* Skips (always shown — warnings need visibility) */}
      {remainingSkips.map((s, i) => (
        <SectionRow key={`sk-${i}`} section={s} compactRationale={compactRationale} />
      ))}

      {/* Solids (collapsed by default if many) */}
      {visibleSolids.map((s, i) => (
        <SectionRow key={`so-${i}`} section={s} compactRationale={compactRationale} />
      ))}

      {hiddenSolidCount > 0 && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="mt-3 text-xs text-brand hover:text-brand-light underline decoration-dotted underline-offset-2"
          aria-expanded={false}
        >
          Show {hiddenSolidCount} more solid pick{hiddenSolidCount === 1 ? '' : 's'}
        </button>
      )}
    </div>
  );
}
