'use client';

import { useState, useEffect, useCallback, useRef, useMemo, useDeferredValue } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useUserLists } from '@/hooks/useUserLists';
import type { UserList, ListItem, ShowLookup } from '@/types/user';
import type Fuse from 'fuse.js';

interface ShowMap {
  [showId: string]: ShowLookup;
}

interface SearchShow {
  id: string;
  title: string;
  slug: string;
  status: string;
  venue?: string;
  od?: string;
  images?: { thumbnail?: string };
  category?: string;
}

interface ListsTabProps {
  userId: string | null;
  showMap: ShowMap;
  isMockMode: boolean;
}

export default function ListsTab({ userId, showMap, isMockMode }: ListsTabProps) {
  const searchParams = useSearchParams();
  const activeListId = searchParams.get('list');

  const {
    lists: realLists, loading: realLoading, getLists, getListItems,
    createList, updateList, deleteList,
    addToList, removeFromList, reorderList,
  } = useUserLists(userId);

  const [mockData, setMockData] = useState<{ lists: UserList[]; items: Record<string, ListItem[]> } | null>(null);
  const [listItems, setListItems] = useState<ListItem[]>([]);
  const [listItemsLoading, setListItemsLoading] = useState(false);
  const [showModal, setShowModal] = useState<'create' | 'edit' | null>(null);
  const [editingList, setEditingList] = useState<UserList | null>(null);

  // Mock mode: load mock data
  useEffect(() => {
    if (!isMockMode) return;
    import('./__dev-mock-data').then(mod => {
      setMockData({ lists: mod.mockLists, items: mod.mockListItems });
    });
  }, [isMockMode]);

  const lists = isMockMode && mockData ? mockData.lists : realLists;
  const loading = isMockMode ? !mockData : realLoading;

  // Load lists on mount
  useEffect(() => {
    if (userId && !isMockMode) {
      getLists();
    }
  }, [userId, isMockMode, getLists]);

  // Load items when viewing a specific list
  useEffect(() => {
    if (!activeListId) return;
    if (isMockMode && mockData) {
      setListItems(mockData.items[activeListId] || []);
      return;
    }
    if (!userId || isMockMode) return;
    setListItemsLoading(true);
    getListItems(activeListId).then(items => {
      setListItems(items);
      setListItemsLoading(false);
    });
  }, [activeListId, userId, isMockMode, mockData, getListItems]);

  const activeList = lists.find(l => l.id === activeListId);

  const navigateToList = (listId: string | null) => {
    const base = '/my-shows?tab=lists';
    const url = listId ? `${base}&list=${listId}` : base;
    window.history.pushState(null, '', url);
    // Trigger re-render via popstate won't work, so use replaceState + force
    window.dispatchEvent(new PopStateEvent('popstate'));
  };

  const handleCreateList = async (name: string, description: string | null, isRanked: boolean) => {
    const newList = await createList(name, description, isRanked);
    if (newList) {
      setShowModal(null);
      navigateToList(newList.id);
    }
  };

  const handleUpdateList = async (listId: string, name: string, description: string | null, isRanked: boolean) => {
    await updateList(listId, { name, description, is_ranked: isRanked });
    setShowModal(null);
    setEditingList(null);
  };

  const handleDeleteList = async (listId: string) => {
    await deleteList(listId);
    navigateToList(null);
  };

  const handleAddToList = async (listId: string, showId: string) => {
    await addToList(listId, showId);
    // Refresh items
    const items = await getListItems(listId);
    setListItems(items);
  };

  const handleRemoveFromList = async (listId: string, showId: string) => {
    await removeFromList(listId, showId);
    setListItems(prev => prev.filter(i => i.show_id !== showId));
  };

  // Detail view
  if (activeListId && activeList) {
    return (
      <div>
        <ListDetailView
          list={activeList}
          items={listItems}
          loading={listItemsLoading}
          showMap={showMap}
          onBack={() => navigateToList(null)}
          onEdit={() => { setEditingList(activeList); setShowModal('edit'); }}
          onDelete={() => handleDeleteList(activeListId)}
          onAddShow={(showId) => handleAddToList(activeListId, showId)}
          onRemoveShow={(showId) => handleRemoveFromList(activeListId, showId)}
          onReorder={async (itemIds, positions) => {
            await reorderList(activeListId, itemIds, positions);
            const items = await getListItems(activeListId);
            setListItems(items);
          }}
        />
        {showModal === 'edit' && editingList && (
          <ListModal
            mode="edit"
            list={editingList}
            showMap={showMap}
            onSave={(name, desc, ranked) => handleUpdateList(editingList.id, name, desc, ranked)}
            onClose={() => { setShowModal(null); setEditingList(null); }}
            onDelete={() => handleDeleteList(editingList.id)}
          />
        )}
      </div>
    );
  }

  // Index view
  return (
    <div>
      {loading ? (
        <div className="space-y-3">
          {[1, 2, 3].map(i => (
            <div key={i} className="h-20 bg-white/5 rounded-xl animate-pulse" />
          ))}
        </div>
      ) : lists.length === 0 ? (
        <div className="text-center py-16">
          <div className="text-4xl mb-3">📋</div>
          <h3 className="text-lg font-bold text-white mb-1">No lists yet</h3>
          <p className="text-sm text-gray-400 mb-4">Create lists to organize your shows.</p>
          <button
            type="button"
            onClick={() => setShowModal('create')}
            className="inline-block px-5 py-2.5 text-sm font-semibold text-black bg-[#FFD700] rounded-lg hover:bg-[#e6c200] transition-colors"
          >
            Create a List
          </button>
        </div>
      ) : (
        <div className="space-y-1">
          {lists.map(list => (
            <ListRow
              key={list.id}
              list={list}
              showMap={showMap}
              onClick={() => navigateToList(list.id)}
            />
          ))}
        </div>
      )}

      {/* Create button (floating, when lists exist) */}
      {lists.length > 0 && (
        <button
          type="button"
          onClick={() => setShowModal('create')}
          className="mt-6 flex items-center justify-center gap-2 w-full px-4 py-3 rounded-xl border-2 border-dashed border-white/10 hover:border-white/20 hover:bg-white/[0.03] transition-colors text-gray-500 hover:text-gray-300"
        >
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
          </svg>
          <span className="text-xs font-medium">Create a list</span>
        </button>
      )}

      {showModal === 'create' && (
        <ListModal
          mode="create"
          showMap={showMap}
          onSave={handleCreateList}
          onClose={() => setShowModal(null)}
        />
      )}
    </div>
  );
}

// --- List Index Row ---

function ListRow({ list, showMap, onClick }: { list: UserList; showMap: ShowMap; onClick: () => void }) {
  const previewShows = (list.preview_show_ids || []).map(id => showMap[id]).filter(Boolean);

  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full flex items-center gap-3 px-3 sm:px-5 py-3 sm:py-4 rounded-xl bg-white/[0.02] border border-white/[0.06] hover:border-white/10 hover:bg-white/[0.04] transition-colors text-left"
    >
      <div className="flex-1 min-w-0">
        <h4 className="font-bold text-white text-base truncate">{list.name}</h4>
        <p className="text-xs text-gray-500 mt-0.5">
          {list.item_count || 0} {(list.item_count || 0) === 1 ? 'Show' : 'Shows'}
          {list.is_ranked && <span className="ml-1.5 text-amber-400/60">#</span>}
        </p>
      </div>
      {/* Poster previews */}
      <div className="flex-shrink-0 flex items-center gap-1">
        {previewShows.slice(0, 4).map((show, i) => (
          <div key={i} className="w-10 h-10 sm:w-12 sm:h-12 rounded-lg overflow-hidden bg-surface-overlay flex-shrink-0">
            {show.posterUrl ? (
              <img src={show.posterUrl} alt="" className="w-full h-full object-cover" />
            ) : (
              <div className="w-full h-full flex items-center justify-center text-gray-600 text-sm">🎭</div>
            )}
          </div>
        ))}
      </div>
      <svg className="w-4 h-4 text-gray-600 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
      </svg>
    </button>
  );
}

// --- List Detail View ---

function ListDetailView({
  list, items, loading, showMap, onBack, onEdit, onDelete,
  onAddShow, onRemoveShow, onReorder,
}: {
  list: UserList;
  items: ListItem[];
  loading: boolean;
  showMap: ShowMap;
  onBack: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onAddShow: (showId: string) => void;
  onRemoveShow: (showId: string) => void;
  onReorder: (itemIds: string[], positions: number[]) => void;
}) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [showOverflow, setShowOverflow] = useState(false);
  const [showAddSearch, setShowAddSearch] = useState(false);
  const overflowRef = useRef<HTMLDivElement>(null);

  // Close overflow on outside click
  useEffect(() => {
    if (!showOverflow) return;
    function handleClick(e: MouseEvent) {
      if (overflowRef.current && !overflowRef.current.contains(e.target as Node)) {
        setShowOverflow(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [showOverflow]);

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <button
          type="button"
          onClick={onBack}
          className="flex items-center gap-1 text-sm text-brand hover:text-brand/80 transition-colors"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
          </svg>
          Lists
        </button>
        <div className="relative" ref={overflowRef}>
          <button
            type="button"
            onClick={() => setShowOverflow(!showOverflow)}
            className="p-2 text-gray-400 hover:text-white transition-colors"
            aria-label="List options"
          >
            <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
              <circle cx="12" cy="5" r="1.5" />
              <circle cx="12" cy="12" r="1.5" />
              <circle cx="12" cy="19" r="1.5" />
            </svg>
          </button>
          {showOverflow && (
            <div className="absolute right-0 top-full mt-1 bg-surface-raised border border-white/10 rounded-lg shadow-xl overflow-hidden z-50 min-w-[160px]">
              <button
                type="button"
                onClick={() => { setShowOverflow(false); onEdit(); }}
                className="w-full flex items-center gap-2 px-4 py-2.5 text-sm text-white hover:bg-white/5 transition-colors"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                </svg>
                Edit List
              </button>
              {!confirmDelete ? (
                <button
                  type="button"
                  onClick={() => setConfirmDelete(true)}
                  className="w-full flex items-center gap-2 px-4 py-2.5 text-sm text-red-400 hover:bg-white/5 transition-colors"
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                  </svg>
                  Delete List
                </button>
              ) : (
                <div className="flex items-center gap-2 px-4 py-2.5 text-sm">
                  <button type="button" onClick={() => { setShowOverflow(false); onDelete(); }} className="text-red-400 hover:text-red-300 font-medium">Delete?</button>
                  <button type="button" onClick={() => setConfirmDelete(false)} className="text-gray-500 hover:text-white">No</button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      <h2 className="text-2xl font-extrabold text-white mb-1">{list.name}</h2>
      {list.description && (
        <p className="text-sm text-gray-400 mb-4">{list.description}</p>
      )}

      {/* Items */}
      {loading ? (
        <div className="space-y-2">
          {[1, 2, 3].map(i => (
            <div key={i} className="h-16 bg-white/5 rounded-xl animate-pulse" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <div className="text-center py-12">
          <p className="text-sm text-gray-400 mb-4">This list is empty. Add some shows!</p>
        </div>
      ) : (
        <div className="space-y-1">
          {items.map((item, index) => {
            const show = showMap[item.show_id];
            const title = show?.title || item.show_id;
            const slug = show?.slug || item.show_id;
            const href = `/show/${slug}`;

            return (
              <div
                key={item.id}
                className="group/item relative flex items-center gap-3 px-3 sm:px-5 py-2.5 sm:py-3 rounded-xl bg-white/[0.02] border border-white/[0.06] hover:border-white/10 hover:bg-white/[0.04] transition-colors"
              >
                <Link href={href} className="absolute inset-0 z-0" aria-label={`View ${title}`} />

                {/* Rank number */}
                {list.is_ranked && (
                  <span className="relative z-[1] flex-shrink-0 w-6 text-center text-sm font-bold text-gray-500 pointer-events-none">
                    {index + 1}
                  </span>
                )}

                {/* Poster */}
                <div className="relative z-[1] flex-shrink-0 w-12 sm:w-14 aspect-square rounded-lg overflow-hidden bg-surface-overlay pointer-events-none">
                  {show?.posterUrl ? (
                    <img src={show.posterUrl} alt="" className="w-full h-full object-cover" />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center text-gray-600 text-lg">🎭</div>
                  )}
                </div>

                {/* Info */}
                <div className="relative z-[1] flex-1 min-w-0 pointer-events-none">
                  <h4 className="font-bold text-white text-base group-hover/item:text-brand transition-colors truncate">{title}</h4>
                  {show?.venue && <p className="text-sm text-gray-500 truncate">{show.venue}</p>}
                </div>

                {/* Remove button */}
                <button
                  type="button"
                  onClick={(e) => { e.preventDefault(); e.stopPropagation(); onRemoveShow(item.show_id); }}
                  className="relative z-[1] p-1.5 text-gray-600 hover:text-red-400 transition-colors opacity-0 group-hover/item:opacity-100 sm:opacity-0 sm:group-hover/item:opacity-100"
                  aria-label={`Remove ${title} from list`}
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>

                {/* Chevron */}
                <svg className="relative z-[1] w-4 h-4 text-gray-600 flex-shrink-0 pointer-events-none" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                </svg>
              </div>
            );
          })}
        </div>
      )}

      {/* Add a show */}
      {showAddSearch ? (
        <div className="mt-4">
          <ListAddShowSearch
            onSelect={(showId) => { onAddShow(showId); setShowAddSearch(false); }}
            onClose={() => setShowAddSearch(false)}
            existingShowIds={new Set(items.map(i => i.show_id))}
          />
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setShowAddSearch(true)}
          className="mt-4 flex items-center gap-2 text-sm text-brand hover:text-brand/80 transition-colors"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
          </svg>
          Add a show...
        </button>
      )}
    </div>
  );
}

// --- Add Show Search (simplified for lists) ---

function ListAddShowSearch({
  onSelect, onClose, existingShowIds,
}: {
  onSelect: (showId: string) => void;
  onClose: () => void;
  existingShowIds: Set<string>;
}) {
  const [query, setQuery] = useState('');
  const deferredQuery = useDeferredValue(query);
  const [results, setResults] = useState<SearchShow[]>([]);
  const [shows, setShows] = useState<SearchShow[]>([]);
  const fuseRef = useRef<Fuse<SearchShow> | null>(null);
  const [dataReady, setDataReady] = useState(false);
  const fetchedRef = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const ensureData = useCallback(async () => {
    if (fetchedRef.current) return;
    fetchedRef.current = true;
    try {
      const [res, { default: FuseClass }] = await Promise.all([
        fetch('/data/search-shows.json'),
        import('fuse.js/basic') as Promise<{ default: typeof Fuse }>,
      ]);
      const data: SearchShow[] = await res.json();
      fuseRef.current = new FuseClass(data, {
        keys: [{ name: 'title', weight: 0.8 }, { name: 'venue', weight: 0.2 }],
        threshold: 0.35,
        ignoreLocation: true,
        minMatchCharLength: 2,
      });
      setShows(data);
      setDataReady(true);
    } catch {
      fetchedRef.current = false;
    }
  }, []);

  useEffect(() => {
    ensureData();
    setTimeout(() => inputRef.current?.focus(), 50);
  }, [ensureData]);

  const filteredResults = useMemo(() => {
    if (deferredQuery.length < 2 || !fuseRef.current) return [];
    const fuseResults = fuseRef.current.search(deferredQuery, { limit: 6 }).map(r => r.item);
    const q = deferredQuery.toLowerCase();
    const substring = shows.filter(s =>
      s.title.toLowerCase().includes(q) && !fuseResults.some(r => r.id === s.id)
    );
    return [...fuseResults, ...substring].slice(0, 6);
  }, [deferredQuery, dataReady, shows]);

  useEffect(() => { setResults(filteredResults); }, [filteredResults]);

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Escape') onClose();
              if (e.key === 'Enter' && results.length > 0) onSelect(results[0].id);
            }}
            placeholder="Search for a show..."
            className="w-full px-3 py-2 pl-8 text-sm bg-white/5 border border-white/10 rounded-lg text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-brand/50"
          />
          <svg className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="p-2 text-gray-500 hover:text-white transition-colors"
          aria-label="Close search"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
      {query.length >= 2 && (
        <div className="bg-surface-raised border border-white/10 rounded-lg overflow-hidden max-h-64 overflow-y-auto">
          {results.length > 0 ? results.map(show => {
            const alreadyAdded = existingShowIds.has(show.id);
            return (
              <button
                key={show.id}
                onClick={() => !alreadyAdded && onSelect(show.id)}
                disabled={alreadyAdded}
                className="w-full flex items-center gap-2.5 px-3 py-2 text-left hover:bg-white/5 transition-colors disabled:opacity-50"
              >
                {show.images?.thumbnail ? (
                  <img src={show.images.thumbnail} alt="" className="w-9 h-9 rounded object-cover flex-shrink-0" />
                ) : (
                  <div className="w-9 h-9 rounded bg-white/10 flex-shrink-0" />
                )}
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-white truncate">{show.title}</div>
                  <div className="text-[10px] text-gray-500">
                    {show.venue && <span>{show.venue}</span>}
                    {show.od && <span> · {show.od.slice(0, 4)}</span>}
                  </div>
                </div>
                <span className="text-[10px] text-gray-500 flex-shrink-0">
                  {alreadyAdded ? <span className="text-green-400">Added</span> : '+ Add'}
                </span>
              </button>
            );
          }) : (
            <div className="px-3 py-4 text-center text-xs text-gray-500">
              No shows found for &ldquo;{query}&rdquo;
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// --- Create/Edit List Modal ---

function ListModal({
  mode, list, showMap, onSave, onClose, onDelete,
}: {
  mode: 'create' | 'edit';
  list?: UserList;
  showMap: ShowMap;
  onSave: (name: string, description: string | null, isRanked: boolean) => void;
  onClose: () => void;
  onDelete?: () => void;
}) {
  const [name, setName] = useState(list?.name || '');
  const [description, setDescription] = useState(list?.description || '');
  const [isRanked, setIsRanked] = useState(list?.is_ranked || false);
  const [showDescription, setShowDescription] = useState(!!list?.description);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const canSave = name.trim().length > 0;

  return (
    <div className="fixed inset-0 z-[100] flex items-end sm:items-center justify-center">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      {/* Modal */}
      <div className="relative w-full sm:max-w-md bg-surface-raised border border-white/10 rounded-t-2xl sm:rounded-2xl max-h-[85vh] overflow-y-auto">
        {/* Header */}
        <div className="sticky top-0 flex items-center justify-between px-4 py-3 border-b border-white/10 bg-surface-raised z-10">
          <button type="button" onClick={onClose} className="text-sm text-brand hover:text-brand/80">
            Cancel
          </button>
          <h3 className="text-sm font-bold text-white">
            {mode === 'create' ? 'Create List' : 'Edit List'}
          </h3>
          <button
            type="button"
            onClick={() => canSave && onSave(name.trim(), description.trim() || null, isRanked)}
            disabled={!canSave}
            className={`text-sm font-bold ${canSave ? 'text-brand hover:text-brand/80' : 'text-gray-600'}`}
          >
            Save
          </button>
        </div>

        <div className="p-4 space-y-4">
          {/* Name */}
          <div>
            <label className="block text-xs font-bold text-gray-400 uppercase tracking-wider mb-1">
              List Name
            </label>
            <input
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="e.g. Best of 2025, Must-See..."
              maxLength={100}
              className="w-full px-3 py-2.5 text-sm bg-white/5 border border-white/10 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-brand/50"
              autoFocus
            />
          </div>

          {/* Description */}
          {showDescription ? (
            <div>
              <label className="block text-xs font-bold text-gray-400 uppercase tracking-wider mb-1">
                Description
              </label>
              <textarea
                value={description}
                onChange={e => setDescription(e.target.value)}
                placeholder="What's this list about?"
                maxLength={500}
                rows={3}
                className="w-full px-3 py-2.5 text-sm bg-white/5 border border-white/10 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-brand/50 resize-none"
              />
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setShowDescription(true)}
              className="text-xs text-brand hover:text-brand/80 transition-colors"
            >
              + Add description
            </button>
          )}

          {/* Ranked toggle */}
          <div className="flex items-center justify-between py-2">
            <span className="text-sm text-white">Ranked list</span>
            <button
              type="button"
              onClick={() => setIsRanked(!isRanked)}
              className={`relative w-11 h-6 rounded-full transition-colors ${isRanked ? 'bg-brand' : 'bg-white/20'}`}
              role="switch"
              aria-checked={isRanked}
            >
              <span className={`absolute top-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${isRanked ? 'translate-x-[22px]' : 'translate-x-0.5'}`} />
            </button>
          </div>

          {/* Delete */}
          {mode === 'edit' && onDelete && (
            <div className="pt-4 border-t border-white/10">
              {!confirmDelete ? (
                <button
                  type="button"
                  onClick={() => setConfirmDelete(true)}
                  className="w-full text-center text-sm text-red-400 hover:text-red-300 transition-colors py-2"
                >
                  Delete List
                </button>
              ) : (
                <div className="flex items-center justify-center gap-3 py-2">
                  <button type="button" onClick={onDelete} className="text-sm text-red-400 hover:text-red-300 font-medium">
                    Confirm Delete
                  </button>
                  <button type="button" onClick={() => setConfirmDelete(false)} className="text-sm text-gray-500 hover:text-white">
                    Cancel
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
