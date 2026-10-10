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

const PRICE_TIER_LABEL: Record<SeatingPriceTier, string> = {
  budget: 'Budget',
  mid: 'Mid',
  premium: 'Premium',
  top: 'Top tier',
};

const SHOW_TAG_LABEL: Record<string, string> = {
  musical: 'musicals',
  play: 'plays',
  'dance-heavy': 'dance-heavy shows',
  spectacle: 'spectacle',
  'intimate-drama': 'intimate drama',
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

  return (
    <div className="mb-4">
      <div
        className="flex h-2 rounded-full overflow-hidden gap-[2px] bg-surface-overlay"
        role="img"
        aria-label={`Seating distribution: ${picks} best, ${solid} good, ${skips} risky`}
      >
        {picks > 0 && <div className="bg-score-great" style={{ flex: picks }} />}
        {solid > 0 && <div className="bg-gray-600" style={{ flex: solid }} />}
        {skips > 0 && <div className="bg-score-tepid" style={{ flex: skips }} />}
      </div>
      <div className="flex justify-between mt-1.5 text-[11px] font-medium text-gray-400">
        {picks > 0 && <span><span className="text-score-great font-bold">{picks}</span> best</span>}
        {solid > 0 && <span><span className="text-gray-100 font-bold">{solid}</span> good</span>}
        {skips > 0 && <span><span className="text-score-tepid font-bold">{skips}</span> risky</span>}
      </div>
    </div>
  );
}

function SectionRow({
  section,
  isHero = false,
  compactRationale = false,
  isValueAccent = false,
  startOpen = false,
}: {
  section: SeatingSection;
  isHero?: boolean;
  compactRationale?: boolean;
  isValueAccent?: boolean;
  startOpen?: boolean;
}) {
  const [open, setOpen] = useState(startOpen);

  const priceLabel = section.priceTier ? PRICE_TIER_LABEL[section.priceTier] : null;
  const nameClass = isHero ? 'text-base font-bold text-white' : 'text-sm font-semibold text-gray-100';
  const rowRange = section.rowRange || '';
  const showRowRange = rowRange && !(section.name || '').toLowerCase().includes(rowRange.toLowerCase());
  const hasHazards = (section.hazards?.length ?? 0) > 0;
  const hazardsWithNotes = (section.hazards ?? []).filter((h) => h.note);
  const hasBestFor = !!(section.bestFor && section.bestFor.length > 0);
  const hasWorstFor = !!(section.worstFor && section.worstFor.length > 0);
  const hasExpandContent = !!(section.rationale || hasBestFor || hasWorstFor || hasHazards);

  const baseSpacing = isHero ? 'pb-3' : 'py-2.5 border-t border-white/5';
  const accentClass = isValueAccent ? 'border-l-2 border-brand/50 pl-2.5 -ml-2.5 bg-brand/[0.04] rounded-r' : '';

  // ── Theater variant: original inline layout ─────────────────────────────
  if (!compactRationale) {
    return (
      <div className={`${baseSpacing} ${accentClass}`.trim()}>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap leading-tight">
              <h3 className={nameClass}>{section.name}</h3>
              <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-pill text-[11px] font-semibold uppercase tracking-wide ${VERDICT_CHIP_CLASS[section.verdict]}`}>
                <span aria-hidden="true" className="text-xs leading-none">{VERDICT_ICON[section.verdict]}</span>
                <span>{VERDICT_LABEL[section.verdict]}</span>
              </span>
              {section.isValuePick && (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-pill text-[11px] font-semibold uppercase tracking-wide bg-brand/20 text-brand border border-brand/40">
                  <span aria-hidden="true" className="text-xs leading-none">★</span>
                  <span>Smartest Value</span>
                </span>
              )}
              {showRowRange && (
                <span className="text-gray-500 text-xs font-normal">
                  rows {rowRange}
                  {section.bestRow && <span className="text-brand ml-1">· {section.bestRow} sweetest</span>}
                </span>
              )}
              {priceLabel && <span className="text-gray-500 text-xs">· {priceLabel}</span>}
              {typeof section.dataPoints === 'number' && section.dataPoints > 0 && (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-pill text-[10px] font-medium bg-surface-overlay text-gray-400 border border-white/5">
                  · {section.dataPoints} report{section.dataPoints === 1 ? '' : 's'}
                </span>
              )}
            </div>
            {(hasBestFor || hasWorstFor) && (
              <div className="text-[11px] text-gray-500 mt-1 leading-relaxed">
                {hasBestFor && <span><span className="text-gray-400">Best for</span> {section.bestFor!.map((t) => SHOW_TAG_LABEL[t] || t).join(', ')}</span>}
                {hasBestFor && hasWorstFor && <span className="mx-1.5 text-gray-600">·</span>}
                {hasWorstFor && <span><span className="text-gray-400">Skip for</span> {section.worstFor!.map((t) => SHOW_TAG_LABEL[t] || t).join(', ')}</span>}
              </div>
            )}
          </div>
        </div>
        {section.rationale && <p className="text-sm text-gray-300 leading-relaxed mt-2">{section.rationale}</p>}
        {hasHazards && (
          <details className="group mt-1.5">
            <summary className="cursor-pointer list-none text-[11px] text-gray-400 hover:text-gray-200 select-none inline-flex items-center gap-1">
              <span className="text-score-tepid" aria-hidden="true">⚠</span>
              <span className="underline decoration-dotted underline-offset-2">
                {section.hazards!.length === 1 ? '1 hazard' : `${section.hazards!.length} hazards`}
              </span>
              <span className="text-gray-600 group-open:hidden">▾</span>
              <span className="text-gray-600 hidden group-open:inline">▴</span>
            </summary>
            {hazardsWithNotes.length > 0 ? (
              <ul className="mt-1.5 space-y-1 pl-4 text-[11px] text-gray-400 leading-snug">
                {hazardsWithNotes.map((h, i) => (
                  <li key={i}><span className="font-medium text-gray-300">{h.type.replace(/-/g, ' ')}:</span> {h.note}</li>
                ))}
              </ul>
            ) : (
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {(section.hazards ?? []).map((h, i) => (
                  <span key={i} className="text-[10px] text-gray-500 bg-surface-overlay px-2 py-0.5 rounded-pill">{h.type.replace(/-/g, ' ')}</span>
                ))}
              </div>
            )}
          </details>
        )}
      </div>
    );
  }

  // ── Show variant: collapsed card, tap to expand ─────────────────────────
  const metaParts: string[] = [];
  if (showRowRange) metaParts.push(`Rows ${rowRange}`);
  if (priceLabel) metaParts.push(priceLabel);

  return (
    <div className={`${baseSpacing} ${accentClass}`.trim()}>
      <button
        type="button"
        onClick={() => hasExpandContent && setOpen((v) => !v)}
        className={`w-full text-left ${hasExpandContent ? 'cursor-pointer' : 'cursor-default'}`}
        aria-expanded={hasExpandContent ? open : undefined}
      >
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 flex-wrap leading-tight min-w-0">
            <h3 className={`${nameClass} leading-none`}>{section.name}</h3>
            {section.isValuePick && (
              <span className="text-brand text-sm font-bold leading-none" aria-label="Smartest Value">★</span>
            )}
            <span className={`self-center inline-flex items-center gap-1 px-2 py-0.5 rounded-pill text-[11px] font-semibold uppercase tracking-wide ${VERDICT_CHIP_CLASS[section.verdict]}`}>
              <span aria-hidden="true" className="text-xs leading-none">{VERDICT_ICON[section.verdict]}</span>
              <span>{VERDICT_LABEL[section.verdict]}</span>
            </span>
          </div>
          {hasExpandContent && (
            <span className="text-gray-600 text-xs flex-shrink-0" aria-hidden="true">{open ? '▴' : '▾'}</span>
          )}
        </div>
        {metaParts.length > 0 && (
          <p className="text-xs text-gray-500 mt-1 leading-tight">{metaParts.join(' · ')}</p>
        )}
      </button>

      {open && (
        <div className="mt-2.5 space-y-2 border-t border-white/5 pt-2.5">
          {section.rationale && (
            <p className="text-sm text-gray-300 leading-relaxed">{section.rationale}</p>
          )}
          {(hasBestFor || hasWorstFor) && (
            <div className="text-[11px] text-gray-500 leading-relaxed">
              {hasBestFor && <span><span className="text-gray-400">Best for</span> {section.bestFor!.map((t) => SHOW_TAG_LABEL[t] || t).join(', ')}</span>}
              {hasBestFor && hasWorstFor && <span className="mx-1.5 text-gray-600">·</span>}
              {hasWorstFor && <span><span className="text-gray-400">Skip for</span> {section.worstFor!.map((t) => SHOW_TAG_LABEL[t] || t).join(', ')}</span>}
            </div>
          )}
          {hasHazards && (
            <div>
              {hazardsWithNotes.length > 0 ? (
                <ul className="space-y-1 text-[11px] text-gray-400 leading-snug">
                  {hazardsWithNotes.map((h, i) => (
                    <li key={i} className="flex gap-1.5">
                      <span className="text-score-tepid flex-shrink-0" aria-hidden="true">⚠</span>
                      <span><span className="font-medium text-gray-300">{h.type.replace(/-/g, ' ')}:</span> {h.note}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {(section.hazards ?? []).map((h, i) => (
                    <span key={i} className="text-[10px] text-gray-500 bg-surface-overlay px-2 py-0.5 rounded-pill flex items-center gap-1">
                      <span className="text-score-tepid" aria-hidden="true">⚠</span>
                      {h.type.replace(/-/g, ' ')}
                    </span>
                  ))}
                </div>
              )}
            </div>
          )}
          {typeof section.dataPoints === 'number' && section.dataPoints > 0 && (
            <p className="text-[10px] text-gray-600">{section.dataPoints} audience report{section.dataPoints === 1 ? '' : 's'}</p>
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
  const sweetSpots = validSections.filter((s) => s.verdict === 'sweet-spot' && s !== valuePickSection);
  const skips = validSections.filter((s) => s.verdict === 'skip' && s !== valuePickSection);
  const solidsExclValue = validSections.filter((s) => s.verdict === 'solid' && s !== valuePickSection);

  const shouldCollapseSolids = solidsExclValue.length > 2;
  const visibleSolids = shouldCollapseSolids && !expanded ? [] : solidsExclValue;
  const hiddenSolidCount = shouldCollapseSolids && !expanded ? solidsExclValue.length : 0;

  const heroRow = valuePickSection ?? sweetSpots[0] ?? validSections[0];
  const restSweetSpots = sweetSpots.filter((s) => s !== heroRow);

  return (
    <div className="text-left">
      <VerdictDistributionBar sections={validSections} />

      <SectionRow
        section={heroRow}
        isHero
        compactRationale={compactRationale}
        isValueAccent={heroRow === valuePickSection}
        startOpen={compactRationale}
      />

      {restSweetSpots.map((s, i) => (
        <SectionRow key={`ss-${i}`} section={s} compactRationale={compactRationale} />
      ))}

      {skips.map((s, i) => (
        <SectionRow key={`sk-${i}`} section={s} compactRationale={compactRationale} />
      ))}

      {visibleSolids.map((s, i) => (
        <SectionRow key={`so-${i}`} section={s} compactRationale={compactRationale} />
      ))}

      {hiddenSolidCount > 0 && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="mt-3 text-xs text-brand hover:text-brand-light underline decoration-dotted underline-offset-2"
          aria-expanded={expanded}
        >
          Show {hiddenSolidCount} more good seat{hiddenSolidCount === 1 ? '' : 's'}
        </button>
      )}
    </div>
  );
}
