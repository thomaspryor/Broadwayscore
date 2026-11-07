'use client';
/**
 * Scope control: one pill showing the active scope (opens a sectioned picker:
 * All time · Tony seasons · Years) plus a symmetric quick toggle between All
 * time and the current Tony season. Port of the iOS ScopePill (BRO-6170).
 */

import { useState } from 'react';
import { Modal, ModalCloseButton } from '@/components/show-cards';
import { ALL_TIME, type ScopeOption } from '@/lib/stats-ui/scope';
import { pressableClass } from './primitives';

const SECTIONS: ScopeOption['section'][] = ['All time', 'Seasons', 'Years'];

export default function ScopePill({
  scopes,
  active,
  onChange,
}: {
  scopes: ScopeOption[];
  active: ScopeOption;
  onChange: (s: ScopeOption) => void;
}) {
  const [open, setOpen] = useState(false);
  const currentSeason = scopes.find((s) => s.kind === 'season' && s.inProgress) ?? null;
  const quick = active.kind !== 'all' ? ALL_TIME : currentSeason;

  return (
    <>
      <div className="flex items-center gap-2 flex-wrap">
        <button
          type="button"
          data-testid="stats-scope-pill"
          onClick={() => setOpen(true)}
          aria-haspopup="dialog"
          aria-label={`Scope: ${active.label}. Change scope.`}
          className={`${pressableClass} inline-flex items-center gap-2 rounded-full bg-brand/10 border border-brand text-brand px-4 min-h-[40px] text-sm font-semibold hover:bg-brand/15`}
        >
          <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
          </svg>
          <span className="truncate max-w-[180px]">{active.label}</span>
          <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
          </svg>
        </button>
        {quick && (
          <button
            type="button"
            data-testid={active.kind !== 'all' ? 'stats-scope-clear' : 'stats-scope-season'}
            onClick={() => onChange(quick)}
            className={`${pressableClass} inline-flex items-center rounded-full bg-white/5 border border-white/10 text-gray-300 hover:text-white hover:border-white/20 px-3.5 min-h-[40px] text-sm font-medium`}
          >
            {quick.label}
          </button>
        )}
      </div>

      <Modal isOpen={open} onClose={() => setOpen(false)} maxWidth="sm" bottomSheet ariaLabel="Choose a scope">
        <div className="sticky top-0 z-10 bg-surface-raised border-b border-white/5 px-5 py-4 flex items-center justify-between">
          <h2 className="text-lg font-bold text-white">Scope</h2>
          <ModalCloseButton onClick={() => setOpen(false)} className="p-1 -m-1" />
        </div>
        <div className="px-3 py-3">
          {SECTIONS.map((section) => {
            const items = scopes.filter((s) => s.section === section);
            if (!items.length) return null;
            return (
              <div key={section} className="mb-2">
                {section !== 'All time' && (
                  <p className="px-3 pt-3 pb-1 text-xs font-bold uppercase tracking-wider text-fg-muted">{section}</p>
                )}
                <div className={section === 'Years' ? 'grid grid-cols-3 gap-1.5 px-1' : ''}>
                  {items.map((s) => {
                    const selected = s.id === active.id;
                    return (
                      <button
                        key={s.id}
                        type="button"
                        data-testid={`stats-scope-option-${s.id}`}
                        aria-pressed={selected}
                        onClick={() => {
                          onChange(s);
                          setOpen(false);
                        }}
                        className={`${pressableClass} w-full flex items-center justify-between gap-2 rounded-lg px-3 min-h-[44px] text-sm ${
                          selected ? 'bg-brand/10 text-brand font-semibold' : 'text-gray-200 hover:bg-white/5'
                        } ${section === 'Years' ? 'justify-center border border-white/5' : ''}`}
                      >
                        <span>
                          {s.label}
                          {s.inProgress && section === 'Seasons' && <span className="ml-2 text-xs text-fg-muted">in progress</span>}
                        </span>
                        {selected && section !== 'Years' && (
                          <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3} aria-hidden="true">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                          </svg>
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </Modal>
    </>
  );
}
