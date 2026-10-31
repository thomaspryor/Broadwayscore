'use client';

/**
 * My Shows navigation (owner, 2026-10-25, BRO-6170). There is no "My Shows"
 * heading: the three section names ARE the page title, so the page has three
 * text levels — section names, the List / Feed / Stats switch, then controls
 * and content. Earlier underline tabs were too easy to miss.
 */

export type MyShowsTab = 'diary' | 'feed' | 'stats' | 'watchlist' | 'lists';

export interface NavItem {
  tab: MyShowsTab;
  label: string;
}

/** Diary / Watchlist / Lists as the page title, with a gold bar under the active one. */
export function TitleTabs({ items, isActive, onSelect, panelFor = tab => `panel-${tab}` }: {
  items: NavItem[];
  isActive: (tab: MyShowsTab) => boolean;
  onSelect: (tab: MyShowsTab) => void;
  /** id of the panel a tab shows (Diary shows panel-feed/panel-stats when those views are open). */
  panelFor?: (tab: MyShowsTab) => string;
}) {
  return (
    <div role="tablist" aria-label="My Shows sections" className="flex items-baseline gap-5 sm:gap-7 min-w-0">
      {items.map(item => {
        const on = isActive(item.tab);
        return (
          <button
            key={item.tab}
            type="button"
            role="tab"
            id={`tab-${item.tab}`}
            aria-selected={on}
            aria-controls={panelFor(item.tab)}
            onClick={() => onSelect(item.tab)}
            className={`relative pb-1.5 text-2xl sm:text-3xl font-extrabold tracking-tight transition-colors outline-none focus-visible:ring-2 focus-visible:ring-brand rounded-sm ${on ? 'text-white' : 'text-fg-muted hover:text-gray-300'}`}
          >
            {item.label}
            {on && <span aria-hidden="true" className="absolute left-0 right-0 bottom-0 h-[3px] rounded-full bg-brand" />}
          </button>
        );
      })}
    </div>
  );
}

const DIARY_VIEWS: { tab: MyShowsTab; label: string }[] = [
  { tab: 'diary', label: 'List' },
  { tab: 'feed', label: 'Feed' },
  { tab: 'stats', label: 'Stats' },
];

/** App-style List / Feed / Stats segmented control under Diary: the page's second text level. */
export function DiarySegmented({ active, onSelect }: { active: MyShowsTab; onSelect: (tab: MyShowsTab) => void }) {
  return (
    <div role="tablist" aria-label="Diary views" className="flex gap-1 p-1 mt-4 mb-3 rounded-xl bg-surface-raised border border-white/10">
      {DIARY_VIEWS.map(v => {
        const on = active === v.tab;
        return (
          <button
            key={v.tab}
            type="button"
            role="tab"
            id={`view-${v.tab}`}
            aria-selected={on}
            aria-controls={`panel-${v.tab}`}
            onClick={() => onSelect(v.tab)}
            className={`flex-1 py-2.5 text-base font-semibold rounded-lg transition-colors outline-none focus-visible:ring-2 focus-visible:ring-brand ${on ? 'bg-surface-overlay text-white' : 'text-gray-400 hover:text-white'}`}
          >
            {v.label}
          </button>
        );
      })}
    </div>
  );
}
