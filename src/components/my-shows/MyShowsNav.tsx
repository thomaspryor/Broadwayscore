'use client';

/**
 * Design-proposal nav for /my-shows (BRO-6170). The owner found the original
 * underline tabs too easy to miss; these are the louder candidates, picked
 * with ?nav=segmented|cards|pills on the dev preview. Whichever wins replaces
 * the underline tablist and the rest is deleted.
 */

export type MyShowsTab = 'diary' | 'feed' | 'stats' | 'watchlist' | 'lists';
export type NavVariant = 'segmented' | 'cards' | 'pills' | 'titles' | 'titles-bar' | 'titles-icons';

export interface NavItem {
  tab: MyShowsTab;
  label: string;
  count?: number;
  /** Cards variant: the line under the label, e.g. "112 seen". */
  detail?: string;
}

const ICON_PATHS: Record<MyShowsTab, string> = {
  diary: 'M12 6.042A8.967 8.967 0 006 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 016 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 016-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0018 18a8.967 8.967 0 00-6 2.292m0-14.25v14.25',
  feed: 'M2.25 15.75l5.159-5.159a2.25 2.25 0 013.182 0l5.159 5.159m-1.5-1.5l1.409-1.409a2.25 2.25 0 013.182 0l2.909 2.909M3.75 21h16.5A1.5 1.5 0 0021.75 19.5V4.5A1.5 1.5 0 0020.25 3H3.75A1.5 1.5 0 002.25 4.5v15A1.5 1.5 0 003.75 21zM15.75 8.25a.75.75 0 11-1.5 0 .75.75 0 011.5 0z',
  stats: 'M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 013 19.875v-6.75zM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V8.625zM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V4.125z',
  watchlist: 'M17.593 3.322c1.1.128 1.907 1.077 1.907 2.185V21L12 17.25 4.5 21V5.507c0-1.108.806-2.057 1.907-2.185a48.507 48.507 0 0111.186 0z',
  lists: 'M8.25 6.75h12M8.25 12h12m-12 5.25h12M3.75 6.75h.007v.008H3.75V6.75zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zM3.75 12h.007v.008H3.75V12zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm-.375 5.25h.007v.008H3.75v-.008zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0z',
};

export function TabIcon({ tab, className = 'w-5 h-5' }: { tab: MyShowsTab; className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75} aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d={ICON_PATHS[tab]} />
    </svg>
  );
}

const ACTIVE = 'bg-brand/10 border-brand text-brand';
const IDLE = 'border-transparent text-gray-300 hover:text-white hover:bg-surface-overlay';

export default function MyShowsNav({ variant, items, isActive, onSelect }: {
  variant: NavVariant;
  items: NavItem[];
  isActive: (tab: MyShowsTab) => boolean;
  onSelect: (tab: MyShowsTab) => void;
}) {
  if (variant === 'cards') {
    return (
      <div role="tablist" aria-label="My Shows sections" className="grid grid-cols-3 gap-2 sm:gap-3 mt-2 mb-2">
        {items.map(item => {
          const on = isActive(item.tab);
          return (
            <button
              key={item.tab}
              type="button"
              role="tab"
              id={`tab-${item.tab}`}
              aria-selected={on}
              onClick={() => onSelect(item.tab)}
              className={`flex flex-col items-start gap-2 rounded-2xl border px-3 py-3 sm:px-4 sm:py-4 text-left transition-colors bg-surface-raised ${on ? ACTIVE : 'border-white/10 text-gray-300 hover:border-white/25 hover:text-white'}`}
            >
              <TabIcon tab={item.tab} className="w-6 h-6" />
              <span className="flex flex-col">
                <span className="text-base sm:text-lg font-bold leading-tight">{item.label}</span>
                <span className={`text-xs sm:text-sm font-medium ${on ? 'text-brand/80' : 'text-gray-500'}`}>{item.detail ?? '\u00a0'}</span>
              </span>
            </button>
          );
        })}
      </div>
    );
  }

  if (variant === 'pills') {
    return (
      <div role="tablist" aria-label="My Shows sections" className="mt-2 mb-2">
        <div className="flex flex-wrap gap-2">
          {items.map(item => {
            const on = isActive(item.tab);
            return (
              <button
                key={item.tab}
                type="button"
                role="tab"
                id={`tab-${item.tab}`}
                aria-selected={on}
                onClick={() => onSelect(item.tab)}
                className={`flex items-center gap-2 rounded-full border px-3.5 sm:px-4 py-2.5 text-[15px] font-semibold whitespace-nowrap transition-colors ${on ? ACTIVE : 'bg-surface-raised border-white/10 text-gray-300 hover:text-white hover:border-white/25'}`}
              >
                <TabIcon tab={item.tab} />
                {item.label}
                {item.count != null && item.count > 0 && (
                  <span className={`hidden sm:inline text-xs px-1.5 py-0.5 rounded-full ${on ? 'bg-brand/20' : 'bg-white/10'}`}>{item.count}</span>
                )}
              </button>
            );
          })}
        </div>
      </div>
    );
  }

  // segmented
  return (
    <div role="tablist" aria-label="My Shows sections" className="flex gap-1 p-1 mt-2 mb-2 rounded-2xl bg-surface-raised border border-white/10">
      {items.map(item => {
        const on = isActive(item.tab);
        return (
          <button
            key={item.tab}
            type="button"
            role="tab"
            id={`tab-${item.tab}`}
            aria-selected={on}
            onClick={() => onSelect(item.tab)}
            className={`flex-1 flex items-center justify-center gap-2 rounded-xl border py-3 text-base font-bold transition-colors ${on ? ACTIVE : IDLE}`}
          >
            <TabIcon tab={item.tab} />
            {item.label}
            {item.count != null && item.count > 0 && (
              <span className={`hidden sm:inline text-sm font-semibold ${on ? 'text-brand' : 'text-gray-500'}`}>{item.count}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/** The second-level List / Feed / Stats switch under Diary, with icons so Feed and Stats read as places to go. */
export function DiaryViewSwitch({ active, onSelect }: { active: MyShowsTab; onSelect: (tab: MyShowsTab) => void }) {
  const views: { tab: MyShowsTab; label: string }[] = [
    { tab: 'diary', label: 'List' },
    { tab: 'feed', label: 'Feed' },
    { tab: 'stats', label: 'Stats' },
  ];
  return (
    <div role="tablist" aria-label="Diary views" className="flex gap-6 border-b border-white/10 mt-3 mb-4">
      {views.map(v => {
        const on = active === v.tab;
        return (
          <button
            key={v.tab}
            type="button"
            role="tab"
            aria-selected={on}
            onClick={() => onSelect(v.tab)}
            className={`flex items-center gap-1.5 py-2.5 text-[15px] font-semibold border-b-2 -mb-[1px] transition-colors ${on ? 'text-white border-brand' : 'text-gray-400 border-transparent hover:text-white'}`}
          >
            <TabIcon tab={v.tab} className="w-[18px] h-[18px]" />
            {v.label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Round 3 (owner, 2026-10-24): no "My Shows" heading. The three sections ARE
 * the page title, so the page has three text levels: section names, the
 * List / Feed / Stats switch, then controls and content.
 */
export function TitleTabs({ items, isActive, onSelect, bar }: {
  items: NavItem[];
  isActive: (tab: MyShowsTab) => boolean;
  onSelect: (tab: MyShowsTab) => void;
  /** Gold bar under the active name. */
  bar?: boolean;
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
            onClick={() => onSelect(item.tab)}
            className={`relative text-2xl sm:text-3xl font-extrabold tracking-tight transition-colors ${bar ? 'pb-1.5' : ''} ${on ? 'text-white' : 'text-gray-500 hover:text-gray-300'}`}
          >
            {item.label}
            {bar && on && <span aria-hidden="true" className="absolute left-0 right-0 bottom-0 h-[3px] rounded-full bg-brand" />}
          </button>
        );
      })}
    </div>
  );
}

/** App-style List / Feed / Stats segmented control: the page's second text level. */
export function DiarySegmented({ active, onSelect, icons }: { active: MyShowsTab; onSelect: (tab: MyShowsTab) => void; icons?: boolean }) {
  const views: { tab: MyShowsTab; label: string }[] = [
    { tab: 'diary', label: 'List' },
    { tab: 'feed', label: 'Feed' },
    { tab: 'stats', label: 'Stats' },
  ];
  return (
    <div role="tablist" aria-label="Diary views" className="flex gap-1 p-1 mt-4 mb-3 rounded-xl bg-surface-raised border border-white/10">
      {views.map(v => {
        const on = active === v.tab;
        return (
          <button
            key={v.tab}
            type="button"
            role="tab"
            aria-selected={on}
            onClick={() => onSelect(v.tab)}
            className={`flex-1 flex items-center justify-center gap-2 py-2.5 text-base font-semibold rounded-lg transition-colors ${on ? 'bg-surface-overlay text-white' : 'text-gray-400 hover:text-white'}`}
          >
            {icons && <TabIcon tab={v.tab} className="w-[18px] h-[18px]" />}
            {v.label}
          </button>
        );
      })}
    </div>
  );
}
