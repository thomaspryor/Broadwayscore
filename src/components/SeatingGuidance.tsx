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
  solid: '✓',
  skip: '−',
};

// Plain-language labels — override whatever label the data supplies so the
// whole site speaks one consistent vocabulary regardless of historical data.
const VERDICT_LABEL: Record<SeatingVerdict, string> = {
  'sweet-spot': 'Best Seats',
  solid: 'Good Seats',
  skip: 'Risky Seats',
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

function VerdictDistributionBar({ sections }: { sections: SeatingSection[] }) {
  const picks = sections.filter((s) => s.verdict === 'sweet-spot').length;
  const solid = sections.filter((s) => s.verdict === 'solid').length;
  const skips = sections.filter((s) => s.verdict === 'skip').length;
  const total = picks + solid + skips;
  if (total === 0) return null;

  const ariaLabel = `Seating distribution: ${picks} best, ${solid} good, ${skips} risky`;

  return (
    <div className="mb-4">
      <div
        className="flex h-2 rounded-full overflow-hidden gap-[2px] bg-surface-overlay"
        role="img"
        aria-label={ariaLabel}
      >
        {picks > 0 && <div className="bg-score-great" style={{ flex: picks }} />}
        {solid > 0 && <div className="bg-gray-600" style={{ flex: solid }} />}
        {skips > 0 && <div className="bg-score-tepid" style={{ flex: skips }} />}
      </div>
      <div className="flex justify-between mt-1.5 text-[11px] font-medium text-gray-400">
        {picks > 0 && (
          <span><span className="text-score-great font-bold">{picks}</span> best</span>
        )}
        {solid > 0 && (
          <span><span className="text-gray-100 font-bold">{solid}</span> good</span>
        )}
        {skips > 0 && (
          <span><span className="text-score-tepid font-bold">{skips}</span> risky</span>
        )}
      </div>
    </div>
  );
}

function VerdictChip({ section }: { section: SeatingSection }) {
  const label = VERDICT_LABEL[section.verdict];
  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-pill text-[11px] font-semibold uppercase tracking-wide ${VERDICT_CHIP_CLASS[section.verdict]}`}
      aria-label={`Verdict: ${label}`}
    >
      <span aria-hidden="true" className="text-xs leading-none">{VERDICT_ICON[section.verdict]}</span>
      <span>{label}</span>
    </span>
  );
}

function ValuePickChip() {
  return (
    <span
      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-pill text-[11px] font-semibold uppercase tracking-wide bg-brand/20 text-brand border border-brand/40"
      aria-label="Smartest Value — bang for buck"
    >
      <span aria-hidden="true" className="text-xs leading-none">★</span>
      <span>Smartest Value</span>
    </span>
  );
}

function ReportsPill({ count }: { count: number }) {
  return (
    <span
      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-pill text-[10px] font-medium bg-surface-overlay text-gray-400 border border-white/5"
      title={`${count} audience reports informed this verdict`}
      aria-label={`Based on ${count} reports`}
    >
      <span aria-hidden="true" className="text-[10px] leading-none">·</span>
      <span>{count} report{count === 1 ? '' : 's'}</span>
    </span>
  );
}

const SHOW_TAG_LABEL: Record<string, string> = {
  'musical': 'musicals',
  'play': 'plays',
  'dance-heavy': 'dance-heavy shows',
  'spectacle': 'spectacle',
  'intimate-drama': 'intimate drama',
};

function ShowContextLine({ bestFor, worstFor }: { bestFor?: string[]; worstFor?: string[] }) {
  const hasBest = bestFor && bestFor.length > 0;
  const hasWorst = worstFor && worstFor.length > 0;
  if (!hasBest && !hasWorst) return null;
  const bestStr = hasBest ? bestFor.map((t) => SHOW_TAG_LABEL[t] || t).join(', ') : '';
  const worstStr = hasWorst ? worstFor.map((t) => SHOW_TAG_LABEL[t] || t).join(', ') : '';
  return (
    <div className="text-[11px] text-gray-500 mt-1 leading-relaxed">
      {hasBest && (
        <span>
          <span className="text-gray-400">Best for</span> {bestStr}
        </span>
      )}
      {hasBest && hasWorst && <span className="mx-1.5 text-gray-600">·</span>}
      {hasWorst && (
        <span>
          <span className="text-gray-400">Skip for</span> {worstStr}
        </span>
      )}
    </div>
  );
}

function SectionRow({ section, isHero = false, compactRationale = false, isValueAccent = false, forceShowRationale = false }: { section: SeatingSection; isHero?: boolean; compactRationale?: boolean; isValueAccent?: boolean; forceShowRationale?: boolean }) {
  const [heroRationaleExpanded, setHeroRationaleExpanded] = useState(false);
  const priceLabel = section.priceTier ? PRICE_TIER_LABEL[section.priceTier] : null;
  const nameClass = isHero ? 'text-base font-bold text-white' : 'text-sm font-semibold text-gray-100';
  const hazardsWithNotes = (section.hazards ?? []).filter((h) => h.note);
  const hasHazards = (section.hazards?.length ?? 0) > 0;
  const hazardCountLabel = section.hazards?.length === 1 ? '1 hazard' : `${section.hazards?.length ?? 0} hazards`;

  // Rationale display logic:
  // - forceShowRationale (value-pick hero): show inline, clamp to 2 lines, expandable
  // - compactRationale (show variant): hide behind "More details"
  // - otherwise (theater variant): show inline, full text
  const showRationaleForced = !!section.rationale && forceShowRationale;
  const showRationaleInline = !!section.rationale && !compactRationale && !forceShowRationale;
  const showRationaleExpand = !!section.rationale && compactRationale && !forceShowRationale;
  const rationaleLikelyClamped = (section.rationale?.length ?? 0) > 100;

  // Drop "(rows X)" when X is already in the section name (e.g. "Orchestra Center (Rows O-V)")
  const rowRange = section.rowRange || '';
  const showRowRange = rowRange && !(section.name || '').toLowerCase().includes(rowRange.toLowerCase());

  const baseSpacing = isHero ? 'pb-3' : 'py-2 border-t border-white/5';
  const accentClass = isValueAccent ? 'border-l-2 border-brand/50 pl-2.5 -ml-2.5 bg-brand/[0.04] rounded-r' : '';

  return (
    <div className={`${baseSpacing} ${accentClass}`.trim()}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap leading-tight">
            <h3 className={nameClass}>{section.name}</h3>
            <VerdictChip section={section} />
            {section.isValuePick && <ValuePickChip />}
            {showRowRange && (
              <span className="text-gray-500 text-xs font-normal">
                rows {rowRange}
                {section.bestRow && (
                  <span className="text-brand ml-1">
                    · {section.bestRow} sweetest
                  </span>
                )}
              </span>
            )}
            {priceLabel && (
              <span className="text-gray-500 text-xs">· {priceLabel}</span>
            )}
            {typeof section.dataPoints === 'number' && section.dataPoints > 0 && (
              <ReportsPill count={section.dataPoints} />
            )}
          </div>
          <ShowContextLine bestFor={section.bestFor} worstFor={section.worstFor} />
        </div>
      </div>

      {/* Inline rationale (theater variant) */}
      {showRationaleInline && (
        <p className="text-sm text-gray-300 leading-relaxed mt-2">{section.rationale}</p>
      )}

      {/* Forced rationale (value-pick hero) — clamp to 2 lines with expand */}
      {showRationaleForced && (
        <>
          <p className={`text-sm text-gray-300 leading-relaxed mt-1.5 ${heroRationaleExpanded ? '' : 'line-clamp-2'}`}>
            {section.rationale}
          </p>
          {rationaleLikelyClamped && (
            <button
              type="button"
              onClick={() => setHeroRationaleExpanded((v) => !v)}
              className="mt-1 text-[11px] text-gray-400 hover:text-brand underline decoration-dotted underline-offset-2 transition-colors"
              aria-expanded={heroRationaleExpanded}
            >
              {heroRationaleExpanded ? 'Show less' : 'More details'}
              <span aria-hidden="true"> {heroRationaleExpanded ? '▴' : '▾'}</span>
            </button>
          )}
        </>
      )}

      {/* Inline expander row: "More details ▾" and "⚠ 1 hazard ▾" on same line */}
      {(showRationaleExpand || hasHazards) && (
        <div className="flex items-start gap-x-4 gap-y-1 flex-wrap mt-1.5 text-[11px] text-gray-400">
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

export default function SeatingGuidance({ sections, bestSeats: _bestSeats, compactRationale = false }: SeatingGuidanceProps) {
  const [expanded, setExpanded] = useState(false);

  const validSections = (sections ?? []).filter(isValidSection);
  if (!validSections.length) return null;

  const valuePickSection = validSections.find((s) => s.isValuePick);

  // Ordering: Smartest Value first (regardless of verdict), then Best Seats,
  // then Risky Seats, then Good Seats (collapsible if >2). This replaces the
  // old gold lede box — the value pick now IS the top row.
  const sweetSpots = validSections.filter((s) => s.verdict === 'sweet-spot' && s !== valuePickSection);
  const skips = validSections.filter((s) => s.verdict === 'skip' && s !== valuePickSection);
  const solidsExclValue = validSections.filter((s) => s.verdict === 'solid' && s !== valuePickSection);

  const shouldCollapseSolids = solidsExclValue.length > 2;
  const visibleSolids = shouldCollapseSolids && !expanded ? [] : solidsExclValue;
  const hiddenSolidCount = shouldCollapseSolids && !expanded ? solidsExclValue.length : 0;

  // Hero styling: value pick if present; otherwise the first sweet-spot.
  const heroRow = valuePickSection ?? sweetSpots[0] ?? validSections[0];
  const restSweetSpots = sweetSpots.filter((s) => s !== heroRow);

  return (
    <div className="text-left">
      <VerdictDistributionBar sections={validSections} />

      {/* Hero: value pick if present, else first sweet-spot */}
      <SectionRow
        section={heroRow}
        isHero
        compactRationale={compactRationale}
        isValueAccent={heroRow === valuePickSection}
        forceShowRationale={heroRow === valuePickSection}
      />

      {/* Remaining sweet-spots (value pick already rendered as hero above) */}
      {restSweetSpots.map((s, i) => (
        <SectionRow
          key={`ss-${i}`}
          section={s}
          compactRationale={compactRationale}
        />
      ))}

      {/* Risky Seats (always shown — warnings need visibility) */}
      {skips.map((s, i) => (
        <SectionRow
          key={`sk-${i}`}
          section={s}
          compactRationale={compactRationale}
        />
      ))}

      {/* Good Seats (collapsed by default if many) */}
      {visibleSolids.map((s, i) => (
        <SectionRow
          key={`so-${i}`}
          section={s}
          compactRationale={compactRationale}
        />
      ))}

      {hiddenSolidCount > 0 && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="mt-3 text-xs text-brand hover:text-brand-light underline decoration-dotted underline-offset-2"
          aria-expanded={false}
        >
          Show {hiddenSolidCount} more good seat{hiddenSolidCount === 1 ? '' : 's'}
        </button>
      )}
    </div>
  );
}
