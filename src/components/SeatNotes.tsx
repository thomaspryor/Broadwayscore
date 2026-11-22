import type { SeatNote } from '@/lib/data-types';
import { noteLocationLabel, noteSourceLinks } from '../../scripts/lib/seat-notes-publish';

/**
 * Sourced seat tips grouped as Watch out / Good value / Good to know (BRO-8057).
 * Expects notes already filtered and ordered by publishableSeatNotes().
 */
const GROUPS: { type: SeatNote['type']; label: string; mark: string; pill: string }[] = [
  { type: 'watch-out', label: 'Watch out', mark: '▲', pill: 'text-score-tepid bg-score-tepid-bg border-score-tepid/35' },
  { type: 'value', label: 'Good value', mark: '$', pill: 'text-score-great bg-score-great-bg border-score-great/35' },
  { type: 'note', label: 'Good to know', mark: '✓', pill: 'text-score-good bg-score-good-bg border-score-good/35' },
];

export default function SeatNotes({ notes }: { notes: SeatNote[] }) {
  return (
    <div>
      {GROUPS.map((g) => {
        const items = notes.filter((n) => n.type === g.type);
        if (!items.length) return null;
        return (
          <div key={g.type} className="grid gap-3 py-3.5 border-t border-white/5 first:border-t-0 first:pt-1">
            <span className={`inline-flex items-center gap-1.5 w-max px-2.5 py-0.5 rounded-full border text-[11px] font-bold uppercase tracking-[0.08em] ${g.pill}`}>
              <span aria-hidden="true">{g.mark}</span>
              {g.label}
            </span>
            <ul className="grid gap-3 m-0 p-0 list-none">
              {items.map((n, i) => {
                const links = noteSourceLinks(n);
                return (
                  <li key={i} className="grid gap-0.5">
                    <span className="text-[15px] font-bold text-white">{noteLocationLabel(n)}</span>
                    <span className="text-sm text-gray-300 leading-relaxed">{n.claim}</span>
                    {links.length > 0 && (
                      <span className="text-[11px] text-fg-muted">
                        {links.length > 1 ? `${links.length} sources · ` : ''}
                        {links.map((l, j) => (
                          <span key={l.url}>
                            {j > 0 && ', '}
                            <a href={l.url} target="_blank" rel="noopener noreferrer nofollow" className="underline decoration-white/20 underline-offset-2 hover:text-white">
                              {l.label}
                            </a>
                          </span>
                        ))}
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </div>
  );
}
