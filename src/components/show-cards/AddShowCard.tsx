'use client';

/** Add action shared by the diary and watchlist, in either layout. */
export function AddShowCard({ context, variant = 'grid', onOpen }: { context: 'diary' | 'watchlist'; variant?: 'grid' | 'list'; onOpen: () => void }) {
  const openAndReveal = () => {
    onOpen();
    // The search input mounts in the page header. From the bottom of a long
    // list the open is off-screen and reads as a dead button on mobile
    // (owner, 2026-07-20). Scroll it into view and focus it.
    requestAnimationFrame(() => {
      const input = document.querySelector<HTMLInputElement>('input[placeholder^="Search to"]');
      input?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      input?.focus({ preventScroll: true });
    });
  };
  return (
    <button
      type="button"
      onClick={openAndReveal}
      // Poster-sized, top-aligned: the grid would otherwise stretch it to the
      // tallest card in the row (name, stars, date controls), owner 2026-10-03.
      className={`card-interactive focus-ring flex items-center justify-center text-gray-300 hover:text-white ${
        variant === 'list'
          ? 'w-full min-h-[72px] gap-3 px-4 py-3'
          : 'self-start aspect-[2/3] flex-col gap-2 p-3'
      }`}
      aria-label={context === 'diary' ? 'Rate a new show' : 'Add a new show to watchlist'}
    >
      <svg className="w-8 h-8 shrink-0 text-brand" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5} aria-hidden="true">
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
      </svg>
      <span className="text-sm font-semibold">{context === 'diary' ? 'Rate a show' : 'Add a show'}</span>
    </button>
  );
}
